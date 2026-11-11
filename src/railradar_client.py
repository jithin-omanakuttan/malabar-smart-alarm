"""Minimal RailRadar HTTP client (standard library only).

Security notes:
* The API key is only placed in the Authorization header of the outgoing
  request. It is never logged, never included in exception messages and is
  hidden from ``repr()``.
* Only HTTPS base URLs are accepted.
"""

from __future__ import annotations

import json
import logging
import socket
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

USER_AGENT = "malabar-smart-alarm/1.0"
RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}


class RailRadarError(Exception):
    """Any failure to obtain a usable JSON document from RailRadar.

    Messages are written by this module and never contain secrets.
    """

    def __init__(self, message: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


class RailRadarClient:
    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.railradar.in/v1",
        timeout: float = 20.0,
        max_attempts: int = 2,
        retry_delay: float = 5.0,
        opener: Optional[Callable[..., Any]] = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not api_key:
            raise RailRadarError("RAILRADAR_API_KEY is not configured")
        if not base_url.lower().startswith("https://"):
            raise RailRadarError("RailRadar base URL must use HTTPS")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_attempts = max(1, max_attempts)
        self._retry_delay = retry_delay
        self._opener = opener or urllib.request.urlopen
        self._sleep = sleep

    def __repr__(self) -> str:  # never show the key
        return f"RailRadarClient(base_url={self._base_url!r}, api_key=***)"

    def live_url(self, train_number: str) -> str:
        if not str(train_number).isdigit():
            raise RailRadarError("Train number must be digits only")
        return f"{self._base_url}/trains/{train_number}/live"

    def fetch_live(self, train_number: str) -> Dict[str, Any]:
        """GET /trains/{number}/live and return the decoded JSON object."""
        url = self.live_url(train_number)
        last_error: Optional[RailRadarError] = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                payload = self._request_once(url)
                logger.info("RailRadar responded on attempt %d", attempt)
                return payload
            except RailRadarError as exc:
                last_error = exc
                logger.warning("RailRadar attempt %d/%d failed: %s", attempt, self._max_attempts, exc)
                if not exc.retryable or attempt == self._max_attempts:
                    break
                self._sleep(self._retry_delay * attempt)
        assert last_error is not None
        raise last_error

    def _request_once(self, url: str) -> Dict[str, Any]:
        request = urllib.request.Request(
            url,
            method="GET",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Accept": "application/json",
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with self._opener(request, timeout=self._timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            code = exc.code
            if code in (401, 403):
                raise RailRadarError(f"RailRadar rejected the API key (HTTP {code})") from None
            if code == 404:
                raise RailRadarError("RailRadar has no live data for this train (HTTP 404)") from None
            raise RailRadarError(
                f"RailRadar returned HTTP {code}",
                retryable=code in RETRYABLE_STATUS or code >= 500,
            ) from None
        except (socket.timeout, TimeoutError):
            raise RailRadarError(f"RailRadar request timed out after {self._timeout:g}s", retryable=True) from None
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, (socket.timeout, TimeoutError)):
                raise RailRadarError(
                    f"RailRadar request timed out after {self._timeout:g}s", retryable=True
                ) from None
            raise RailRadarError(
                f"Network error contacting RailRadar ({type(exc.reason).__name__})", retryable=True
            ) from None
        except OSError as exc:
            raise RailRadarError(f"Network error contacting RailRadar ({type(exc).__name__})", retryable=True) from None

        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise RailRadarError("RailRadar returned invalid JSON") from None
        if not isinstance(payload, dict):
            raise RailRadarError("RailRadar returned an unexpected JSON structure (not an object)")
        return payload
