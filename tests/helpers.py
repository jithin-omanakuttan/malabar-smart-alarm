"""Shared test utilities. No network access, no real credentials."""

from __future__ import annotations

import copy
import io
import json
import urllib.error
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, List
from zoneinfo import ZoneInfo

from src.config import Settings

IST = ZoneInfo("Asia/Kolkata")
FIXTURE = Path(__file__).parent / "fixtures" / "railradar_live_16630.json"
FAKE_API_KEY = "test-key-not-real"
FAKE_TOPIC = "test-topic-not-real"


def load_fixture() -> dict:
    return copy.deepcopy(json.loads(FIXTURE.read_text(encoding="utf-8")))


def make_settings(**overrides: Any) -> Settings:
    base = dict(railradar_api_key=FAKE_API_KEY, ntfy_topic=FAKE_TOPIC)
    base.update(overrides)
    return Settings(**base)


def ist(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=IST)


def cngr(payload: dict) -> dict:
    return next(r for r in payload["data"]["route"] if r["stationCode"] == "CNGR")


class FakeResponse:
    def __init__(self, body: bytes, status: int = 200) -> None:
        self._body = body
        self.status = status

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


def http_error(url: str, code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(url, code, "error", {}, io.BytesIO(b""))


class FakeOpener:
    """Callable replacement for urllib.request.urlopen.

    ``outcomes`` is a list consumed in order; each item is either bytes / a
    dict / a list (returned as a response body) or an Exception (raised).
    Every request is recorded in ``requests``.
    """

    def __init__(self, outcomes: List[Any]) -> None:
        self.outcomes = list(outcomes)
        self.requests: List[Any] = []
        self.timeouts: List[float] = []

    def __call__(self, request: Any, timeout: float = 0) -> FakeResponse:
        self.requests.append(request)
        self.timeouts.append(timeout)
        if not self.outcomes:
            raise AssertionError("FakeOpener ran out of outcomes")
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        if isinstance(outcome, (dict, list)):
            outcome = json.dumps(outcome).encode("utf-8")
        return FakeResponse(outcome)


def no_sleep(_: float) -> None:
    return None


NoSleep: Callable[[float], None] = no_sleep
