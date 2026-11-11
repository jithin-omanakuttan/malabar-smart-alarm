"""Turn a boarding-station reading into a recommended wake-up time.

Arrival priority:
1. ``actualArrival``  -> status LIVE (RailRadar's predicted/actual arrival)
2. ``scheduledArrival`` -> status SCHEDULED (timetable, no live prediction)
3. configured fallback  -> status FALLBACK (API unusable)

Stale data protection: if the station's arrival date is not the monitoring
date (e.g. the API is still showing yesterday's journey), the result is a
FALLBACK - it is never presented as live.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from enum import Enum
from typing import Optional

from .config import Settings
from .train_service import TrainSnapshot

MAX_BUFFER_MINUTES = 240


class Status(str, Enum):
    LIVE = "LIVE"
    SCHEDULED = "SCHEDULED"
    FALLBACK = "FALLBACK"


@dataclass(frozen=True)
class AlarmResult:
    status: Status
    monitoring_date: date
    arrival: datetime
    wakeup: datetime
    buffer_minutes: int
    delay_minutes: Optional[int] = None
    provenance: Optional[str] = None
    reason: Optional[str] = None

    def wakeup_has_passed(self, now: datetime) -> bool:
        return now >= self.wakeup


def calculate_wakeup(arrival: datetime, buffer_minutes: int) -> datetime:
    """recommended_wakeup_time = arrival - buffer."""
    if arrival.tzinfo is None:
        raise ValueError("arrival must be timezone-aware")
    if isinstance(buffer_minutes, bool) or not isinstance(buffer_minutes, int):
        raise ValueError("buffer_minutes must be an integer")
    if not 0 <= buffer_minutes <= MAX_BUFFER_MINUTES:
        raise ValueError(f"buffer_minutes must be between 0 and {MAX_BUFFER_MINUTES}")
    return arrival - timedelta(minutes=buffer_minutes)


def build_fallback(settings: Settings, monitoring_date: date, reason: str) -> AlarmResult:
    arrival = datetime.combine(monitoring_date, settings.fallback_scheduled_arrival, tzinfo=settings.tz)
    return AlarmResult(
        status=Status.FALLBACK,
        monitoring_date=monitoring_date,
        arrival=arrival,
        wakeup=calculate_wakeup(arrival, settings.buffer_minutes),
        buffer_minutes=settings.buffer_minutes,
        reason=reason,
    )


def _minutes_between(later: datetime, earlier: datetime) -> int:
    return int(round((later - earlier).total_seconds() / 60))


def calculate_from_snapshot(snapshot: TrainSnapshot, settings: Settings, monitoring_date: date) -> AlarmResult:
    station = snapshot.station
    scheduled = station.scheduled_arrival
    actual = station.actual_arrival
    code = station.station_code

    reference = scheduled or actual
    if reference is None:
        detail = f" (invalid: {', '.join(station.invalid_fields)})" if station.invalid_fields else ""
        return build_fallback(settings, monitoring_date, f"No arrival time for {code} in API response{detail}")

    if reference.date() != monitoring_date:
        return build_fallback(
            settings,
            monitoring_date,
            f"API data is for the journey reaching {code} on {reference:%d %b %Y}, "
            f"not {monitoring_date:%d %b %Y}",
        )

    scheduled_reason = "No live prediction (actualArrival empty); using timetable"
    if "actualArrival" in station.invalid_fields:
        scheduled_reason = "actualArrival was not a valid timestamp; using timetable"

    if actual is not None:
        limit = timedelta(minutes=settings.max_plausible_delay_minutes)
        if scheduled is not None and abs(actual - scheduled) > limit:
            scheduled_reason = (
                f"Predicted arrival {actual:%d %b %H:%M} is implausibly far from the timetable; ignored"
            )
        else:
            delay = _minutes_between(actual, scheduled) if scheduled else snapshot.delay_minutes
            return AlarmResult(
                status=Status.LIVE,
                monitoring_date=monitoring_date,
                arrival=actual,
                wakeup=calculate_wakeup(actual, settings.buffer_minutes),
                buffer_minutes=settings.buffer_minutes,
                delay_minutes=delay,
                provenance=station.provenance,
            )

    if scheduled is None:  # only reachable if an implausible actual had no schedule (defensive)
        return build_fallback(settings, monitoring_date, scheduled_reason)

    return AlarmResult(
        status=Status.SCHEDULED,
        monitoring_date=monitoring_date,
        arrival=scheduled,
        wakeup=calculate_wakeup(scheduled, settings.buffer_minutes),
        buffer_minutes=settings.buffer_minutes,
        delay_minutes=snapshot.delay_minutes,
        provenance=station.provenance,
        reason=scheduled_reason,
    )
