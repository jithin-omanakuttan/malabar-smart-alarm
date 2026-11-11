"""Configuration for Malabar Smart Alarm.

All defaults live in the ``Settings`` dataclass below. Any value can be
overridden with an environment variable (see ``load_settings``), which is how
GitHub Actions secrets and repository variables reach the program.

Secrets (API key, ntfy topic, ntfy token) are NEVER given defaults here and
are excluded from ``repr()`` so they cannot leak into logs.
"""

from __future__ import annotations

import dataclasses
import os
import re
from dataclasses import dataclass, field
from datetime import time
from typing import Dict, FrozenSet, Mapping, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

WEEKDAY_NAMES = ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")

# ntfy topic names: letters, digits, underscore and dash, max 64 characters.
NTFY_TOPIC_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class ConfigError(ValueError):
    """Raised when a configuration value is missing or invalid."""


@dataclass(frozen=True)
class Settings:
    # --- Train and journey -------------------------------------------------
    train_name: str = "Malabar Express"
    train_number: str = "16630"
    boarding_station_name: str = "Chengannur"
    boarding_station_code: str = "CNGR"
    destination_name: str = "Kazhakuttam"
    destination_code: str = "KZK"

    # --- Alarm logic ---------------------------------------------------------
    buffer_minutes: int = 40
    timezone: str = "Asia/Kolkata"
    # Python weekday numbers: Monday=0 ... Sunday=6
    monitoring_weekdays: FrozenSet[int] = frozenset({0, 1, 2, 3, 4})
    # Timetable arrival at the boarding station, used when the API is unusable.
    # 04:51 - 40 min buffer = 04:11 fallback wake-up.
    fallback_scheduled_arrival: time = time(4, 51)
    # A prediction further than this from the timetable is treated as bad data.
    max_plausible_delay_minutes: int = 720

    # --- RailRadar API -------------------------------------------------------
    api_base_url: str = "https://api.railradar.in/v1"
    api_timeout_seconds: float = 20.0
    api_max_attempts: int = 2

    # --- ntfy ----------------------------------------------------------------
    ntfy_server: str = "https://ntfy.sh"
    ntfy_priority: int = 5  # 5 = "urgent" / max
    ntfy_timeout_seconds: float = 15.0
    ntfy_max_attempts: int = 3
    notification_title: str = "Malabar Smart Alarm"

    # --- Secrets (from environment only; hidden from repr) -------------------
    railradar_api_key: str = field(default="", repr=False)
    ntfy_topic: str = field(default="", repr=False)
    ntfy_token: str = field(default="", repr=False)

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def _get(env: Mapping[str, str], name: str) -> Optional[str]:
    """Return a stripped env value, treating empty strings as "not set".

    GitHub Actions expands unset ``vars.X`` / ``secrets.X`` to an empty string,
    so empty must mean "use the default".
    """
    value = env.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def parse_bool(value: Optional[str]) -> bool:
    return bool(value) and value.strip().lower() in {"1", "true", "yes", "on"}


def parse_int(name: str, text: str, minimum: int, maximum: int) -> int:
    try:
        number = int(text)
    except ValueError:
        raise ConfigError(f"{name} must be a whole number, got {text!r}") from None
    if not minimum <= number <= maximum:
        raise ConfigError(f"{name} must be between {minimum} and {maximum}, got {number}")
    return number


def parse_hhmm(name: str, text: str) -> time:
    match = re.fullmatch(r"(\d{1,2}):(\d{2})", text.strip())
    if not match:
        raise ConfigError(f"{name} must be in 24-hour HH:MM format, got {text!r}")
    hour, minute = int(match.group(1)), int(match.group(2))
    if hour > 23 or minute > 59:
        raise ConfigError(f"{name} is not a valid time: {text!r}")
    return time(hour, minute)


def parse_weekdays(text: str) -> FrozenSet[int]:
    """Parse e.g. ``"MON-FRI"`` or ``"MON,WED,FRI"`` or ``"MON-FRI,SUN"``."""
    days = set()
    for part in text.upper().replace(" ", "").split(","):
        if not part:
            continue
        if "-" in part:
            start, end = part.split("-", 1)
            if start not in WEEKDAY_NAMES or end not in WEEKDAY_NAMES:
                raise ConfigError(f"MONITORING_DAYS has an unknown day in {part!r}")
            i, j = WEEKDAY_NAMES.index(start), WEEKDAY_NAMES.index(end)
            if i > j:
                raise ConfigError(f"MONITORING_DAYS range {part!r} must go forwards (e.g. MON-FRI)")
            days.update(range(i, j + 1))
        else:
            if part not in WEEKDAY_NAMES:
                raise ConfigError(f"MONITORING_DAYS has an unknown day {part!r}")
            days.add(WEEKDAY_NAMES.index(part))
    if not days:
        raise ConfigError("MONITORING_DAYS must contain at least one day")
    return frozenset(days)


def _require_https(name: str, url: str) -> str:
    if not url.lower().startswith("https://"):
        raise ConfigError(f"{name} must use HTTPS")
    return url.rstrip("/")


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------

def load_settings(env: Optional[Mapping[str, str]] = None) -> Settings:
    """Build Settings from defaults plus environment overrides."""
    env = os.environ if env is None else env
    overrides: Dict[str, object] = {}

    for env_name, attr in (
        ("TRAIN_NAME", "train_name"),
        ("BOARDING_STATION_NAME", "boarding_station_name"),
        ("DESTINATION_NAME", "destination_name"),
        ("NOTIFICATION_TITLE", "notification_title"),
    ):
        value = _get(env, env_name)
        if value:
            overrides[attr] = value

    train_number = _get(env, "TRAIN_NUMBER")
    if train_number:
        if not re.fullmatch(r"\d{4,6}", train_number):
            raise ConfigError(f"TRAIN_NUMBER must be 4-6 digits, got {train_number!r}")
        overrides["train_number"] = train_number

    for env_name, attr in (("BOARDING_STATION_CODE", "boarding_station_code"),
                           ("DESTINATION_CODE", "destination_code")):
        code = _get(env, env_name)
        if code:
            code = code.upper()
            if not re.fullmatch(r"[A-Z0-9]{1,8}", code):
                raise ConfigError(f"{env_name} must be letters/digits only, got {code!r}")
            overrides[attr] = code

    tz_name = _get(env, "TIMEZONE")
    if tz_name:
        try:
            ZoneInfo(tz_name)
        except (ZoneInfoNotFoundError, ValueError):
            raise ConfigError(f"TIMEZONE {tz_name!r} is not a valid IANA timezone") from None
        overrides["timezone"] = tz_name

    buffer_text = _get(env, "BUFFER_MINUTES")
    if buffer_text:
        overrides["buffer_minutes"] = parse_int("BUFFER_MINUTES", buffer_text, 0, 240)

    priority_text = _get(env, "NTFY_PRIORITY")
    if priority_text:
        overrides["ntfy_priority"] = parse_int("NTFY_PRIORITY", priority_text, 1, 5)

    days_text = _get(env, "MONITORING_DAYS")
    if days_text:
        overrides["monitoring_weekdays"] = parse_weekdays(days_text)

    fallback_text = _get(env, "FALLBACK_SCHEDULED_ARRIVAL")
    if fallback_text:
        overrides["fallback_scheduled_arrival"] = parse_hhmm("FALLBACK_SCHEDULED_ARRIVAL", fallback_text)

    api_base = _get(env, "RAILRADAR_API_BASE_URL")
    if api_base:
        overrides["api_base_url"] = _require_https("RAILRADAR_API_BASE_URL", api_base)

    ntfy_server = _get(env, "NTFY_SERVER")
    if ntfy_server:
        overrides["ntfy_server"] = _require_https("NTFY_SERVER", ntfy_server)

    # Secrets
    api_key = _get(env, "RAILRADAR_API_KEY")
    if api_key:
        overrides["railradar_api_key"] = api_key

    topic = _get(env, "NTFY_TOPIC")
    if topic:
        if not NTFY_TOPIC_PATTERN.fullmatch(topic):
            # Do not echo the topic value: it is a secret.
            raise ConfigError("NTFY_TOPIC may only contain letters, digits, '_' and '-' (max 64)")
        overrides["ntfy_topic"] = topic

    token = _get(env, "NTFY_TOKEN")
    if token:
        overrides["ntfy_token"] = token

    return dataclasses.replace(Settings(), **overrides)
