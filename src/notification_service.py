"""ntfy notifications: message formatting, duplicate detection and delivery.

Duplicate protection without a database: every message ends with a reference
line such as ``Ref: 16630/2026-11-12/LIVE``. Before publishing, the program
reads the topic's recent messages (ntfy ``poll`` API) and skips sending if the
same day was already covered. A later LIVE result may still replace an
earlier SCHEDULED/FALLBACK one, so a temporary API outage at 03:47 does not
prevent a live update at 03:53 or 04:00.

The topic name acts like a password on public ntfy servers, so it is never
logged and never placed in exception messages.
"""

from __future__ import annotations

import base64
import json
import logging
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Callable, Iterable, List, Optional, Tuple

from .alarm_calculator import AlarmResult, Status
from .config import NTFY_TOPIC_PATTERN, Settings

logger = logging.getLogger(__name__)

USER_AGENT = "malabar-smart-alarm/1.0"
_STATUS_VALUES = frozenset(s.value for s in Status)


class NotificationError(Exception):
    """Delivery or lookup failed. Messages never contain the topic or token."""

    def __init__(self, message: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class NtfyMessage:
    title: str
    body: str
    priority: int
    tags: Tuple[str, ...]
    marker: str


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

def make_marker(train_number: str, monitoring_date: date, status: Status, manual: bool = False) -> str:
    # Manual runs get a "/manual" suffix so they never suppress the real
    # scheduled notification (sent_statuses ignores unknown suffixes).
    suffix = "/manual" if manual else ""
    return f"Ref: {train_number}/{monitoring_date.isoformat()}/{status.value}{suffix}"


def format_time(value: datetime) -> str:
    return value.strftime("%I:%M %p")


def format_delay(minutes: Optional[int]) -> str:
    if minutes is None:
        return "not available"
    if minutes == 0:
        return "on time"
    unit = "minute" if abs(minutes) == 1 else "minutes"
    if minutes > 0:
        return f"{minutes} {unit}"
    return f"running {abs(minutes)} {unit} early"


def build_message(result: AlarmResult, settings: Settings, now: datetime, manual: bool = False) -> NtfyMessage:
    lines = [
        f"Train: {settings.train_name} ({settings.train_number})",
        f"Boarding: {settings.boarding_station_name} ({settings.boarding_station_code})",
        f"Date: {result.monitoring_date:%a %d %b %Y}",
    ]
    arrival = format_time(result.arrival)
    if result.status is Status.LIVE:
        lines.append(f"Predicted arrival: {arrival}")
    elif result.status is Status.SCHEDULED:
        lines.append(f"Scheduled arrival: {arrival} (no live prediction)")
    else:
        lines.append(f"Fallback arrival: {arrival} (timetable, NOT live)")
    lines.append(f"Recommended wake-up: {format_time(result.wakeup)}")
    lines.append(f"Buffer: {result.buffer_minutes} minutes")
    if result.status is not Status.FALLBACK:
        lines.append(f"Delay: {format_delay(result.delay_minutes)}")
    lines.append(f"Status: {result.status.value}")
    if result.status is Status.LIVE and result.provenance:
        lines.append(f"Source: RailRadar ({result.provenance})")
    if result.reason:
        lines.append(f"Reason: {result.reason}")
    if result.wakeup_has_passed(now):
        lines.append("Note: The recommended wake-up time has already passed - get up now.")
    marker = make_marker(settings.train_number, result.monitoring_date, result.status, manual)
    lines.append(marker)

    if result.status is Status.LIVE:
        title = settings.notification_title
        tags: Tuple[str, ...] = ("steam_locomotive", "alarm_clock")
    else:
        title = f"{settings.notification_title} - {result.status.value}"
        tags = ("warning", "alarm_clock")

    return NtfyMessage(title=title, body="\n".join(lines), priority=settings.ntfy_priority, tags=tags, marker=marker)


# ---------------------------------------------------------------------------
# Duplicate detection
# ---------------------------------------------------------------------------

def sent_statuses(bodies: Iterable[str], train_number: str, monitoring_date: date) -> set:
    prefix = f"Ref: {train_number}/{monitoring_date.isoformat()}/"
    found = set()
    for body in bodies:
        for line in (body or "").splitlines():
            line = line.strip()
            if line.startswith(prefix):
                status = line[len(prefix):].strip()
                if status in _STATUS_VALUES:  # ignores e.g. "LIVE/manual"
                    found.add(status)
    return found


def should_send(bodies: Iterable[str], train_number: str, monitoring_date: date, status: Status) -> Tuple[bool, str]:
    already = sent_statuses(bodies, train_number, monitoring_date)
    if not already:
        return True, "no notification sent yet for this date"
    if status is Status.LIVE and Status.LIVE.value not in already:
        return True, f"upgrading earlier {'/'.join(sorted(already))} notification to LIVE"
    return False, f"already sent ({'/'.join(sorted(already))}) for {monitoring_date.isoformat()}"


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------

def _encode_header(value: str) -> str:
    """HTTP headers must be latin-1; ntfy accepts RFC 2047 encoded words."""
    try:
        value.encode("ascii")
        return value
    except UnicodeEncodeError:
        return "=?UTF-8?B?" + base64.b64encode(value.encode("utf-8")).decode("ascii") + "?="


class NtfyClient:
    def __init__(
        self,
        server: str,
        topic: str,
        token: str = "",
        timeout: float = 15.0,
        max_attempts: int = 3,
        retry_delay: float = 3.0,
        opener: Optional[Callable[..., Any]] = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not server.lower().startswith("https://"):
            raise NotificationError("ntfy server must use HTTPS")
        if not topic or not NTFY_TOPIC_PATTERN.fullmatch(topic):
            raise NotificationError("NTFY_TOPIC is missing or invalid")
        self._server = server.rstrip("/")
        self._topic = topic
        self._token = token
        self._timeout = timeout
        self._max_attempts = max(1, max_attempts)
        self._retry_delay = retry_delay
        self._opener = opener or urllib.request.urlopen
        self._sleep = sleep

    def __repr__(self) -> str:
        return f"NtfyClient(server={self._server!r}, topic=***)"

    def _headers(self) -> dict:
        headers = {"User-Agent": USER_AGENT}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    def _call(self, request: urllib.request.Request, action: str) -> bytes:
        last: Optional[NotificationError] = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                with self._opener(request, timeout=self._timeout) as response:
                    return response.read()
            except urllib.error.HTTPError as exc:
                retry = exc.code == 429 or exc.code >= 500
                last = NotificationError(f"ntfy {action} failed (HTTP {exc.code})", retryable=retry)
            except (socket.timeout, TimeoutError):
                last = NotificationError(f"ntfy {action} timed out after {self._timeout:g}s", retryable=True)
            except urllib.error.URLError as exc:
                last = NotificationError(f"ntfy {action} network error ({type(exc.reason).__name__})", retryable=True)
            except OSError as exc:
                last = NotificationError(f"ntfy {action} network error ({type(exc).__name__})", retryable=True)
            logger.warning("ntfy %s attempt %d/%d failed: %s", action, attempt, self._max_attempts, last)
            if not last.retryable or attempt == self._max_attempts:
                break
            self._sleep(self._retry_delay * attempt)
        assert last is not None
        raise last

    def recent_bodies(self, since: str = "12h") -> List[str]:
        """Return the bodies of messages published to the topic recently."""
        url = f"{self._server}/{self._topic}/json?poll=1&since={since}"
        request = urllib.request.Request(url, method="GET", headers=self._headers())
        raw = self._call(request, "history lookup")
        bodies: List[str] = []
        for line in raw.decode("utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict) and event.get("event") == "message":
                bodies.append(str(event.get("message", "")))
        return bodies

    def publish(self, message: NtfyMessage) -> str:
        """Publish and return ntfy's message id. Raises NotificationError on failure."""
        headers = self._headers()
        headers.update({
            "Title": _encode_header(message.title),
            "Priority": str(message.priority),
            "Tags": ",".join(message.tags),
            "Content-Type": "text/plain; charset=utf-8",
        })
        request = urllib.request.Request(
            f"{self._server}/{self._topic}",
            data=message.body.encode("utf-8"),
            method="POST",
            headers=headers,
        )
        raw = self._call(request, "publish")
        try:
            reply = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise NotificationError("ntfy publish returned an unreadable response") from None
        if not isinstance(reply, dict) or reply.get("event") != "message" or not reply.get("id"):
            raise NotificationError("ntfy publish response did not confirm the message")
        return str(reply["id"])
