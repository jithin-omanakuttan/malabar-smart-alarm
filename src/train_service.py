"""Validate a RailRadar live response and extract the boarding-station data.

Only fields documented for the response are read:
``success``, ``data.train.number``, ``data.delayMinutes``, ``data.route[]`` and,
per route item, ``stationCode``, ``stationName``, ``sequence``, ``status``,
``provenance``, ``scheduledArrival``, ``actualArrival``,
``scheduledDeparture`` and ``actualDeparture``.

No field is assumed to be present or non-null.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, tzinfo
from typing import Any, List, Mapping, Optional, Tuple

logger = logging.getLogger(__name__)


class TrainDataError(Exception):
    """The API answered, but the payload cannot be used."""


class InvalidTimestampError(ValueError):
    """A timestamp field is present but is not valid ISO-8601."""


@dataclass(frozen=True)
class StationReading:
    station_code: str
    station_name: Optional[str]
    sequence: Optional[int]
    status: Optional[str]
    provenance: Optional[str]
    scheduled_arrival: Optional[datetime]
    actual_arrival: Optional[datetime]
    scheduled_departure: Optional[datetime]
    actual_departure: Optional[datetime]
    invalid_fields: Tuple[str, ...] = ()


@dataclass(frozen=True)
class TrainSnapshot:
    train_number: str
    delay_minutes: Optional[int]
    station: StationReading


def parse_timestamp(value: Any, tz: tzinfo) -> Optional[datetime]:
    """Parse an ISO-8601 timestamp and convert it to ``tz``.

    Returns None for null/empty values. Raises InvalidTimestampError for
    anything else that cannot be parsed. Naive timestamps are assumed to be
    in ``tz`` (RailRadar examples always carry an offset, so this is a guard).
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise InvalidTimestampError(f"expected a string, got {type(value).__name__}")
    text = value.strip()
    if not text:
        return None
    if text[-1] in "Zz":
        text = text[:-1] + "+00:00"  # Python 3.9/3.10 fromisoformat does not accept "Z"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise InvalidTimestampError(f"not an ISO-8601 timestamp: {text!r}") from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=tz)
    return parsed.astimezone(tz)


def _optional_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(round(value))


def extract_snapshot(
    payload: Any,
    expected_train_number: str,
    station_code: str,
    tz: tzinfo,
) -> TrainSnapshot:
    """Validate ``payload`` and return the data for ``station_code``."""
    if not isinstance(payload, Mapping):
        raise TrainDataError("response is not a JSON object")
    if payload.get("success") is not True:
        raise TrainDataError("API reported success=false or omitted 'success'")

    data = payload.get("data")
    if not isinstance(data, Mapping):
        raise TrainDataError("response has no 'data' object")

    train = data.get("train")
    number = _optional_str(train.get("number")) if isinstance(train, Mapping) else None
    if number is None:
        raise TrainDataError("response has no data.train.number")
    if number != str(expected_train_number):
        raise TrainDataError(f"response is for train {number}, expected {expected_train_number}")

    route = data.get("route")
    if not isinstance(route, list) or not route:
        raise TrainDataError("response has no data.route entries")

    wanted = station_code.strip().upper()
    item = next(
        (r for r in route if isinstance(r, Mapping) and str(r.get("stationCode", "")).strip().upper() == wanted),
        None,
    )
    if item is None:
        raise TrainDataError(f"station {wanted} not found in route")

    invalid: List[str] = []

    def ts(field: str) -> Optional[datetime]:
        try:
            return parse_timestamp(item.get(field), tz)
        except InvalidTimestampError as exc:
            logger.warning("Ignoring %s.%s: %s", wanted, field, exc)
            invalid.append(field)
            return None

    reading = StationReading(
        station_code=wanted,
        station_name=_optional_str(item.get("stationName")),
        sequence=_optional_int(item.get("sequence")),
        status=_optional_str(item.get("status")),
        provenance=_optional_str(item.get("provenance")),
        scheduled_arrival=ts("scheduledArrival"),
        actual_arrival=ts("actualArrival"),
        scheduled_departure=ts("scheduledDeparture"),
        actual_departure=ts("actualDeparture"),
        invalid_fields=tuple(invalid),
    )
    return TrainSnapshot(
        train_number=number,
        delay_minutes=_optional_int(data.get("delayMinutes")),
        station=reading,
    )
