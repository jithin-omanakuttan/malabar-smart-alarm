"""Entry point: ``python -m src.main [--force] [--skip-dedupe] [--dry-run]``.

Exit codes:
  0  notification sent, or intentionally skipped (not a monitoring day / duplicate)
  1  notification could not be delivered, or the RailRadar key is not configured
  2  configuration error (e.g. NTFY_TOPIC missing or invalid)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import date, datetime, timedelta
from typing import List, Optional

from .alarm_calculator import AlarmResult, Status, build_fallback, calculate_from_snapshot
from .config import ConfigError, Settings, load_settings, parse_bool
from .notification_service import NotificationError, NtfyClient, build_message, should_send
from .railradar_client import RailRadarClient, RailRadarError
from .train_service import TrainDataError, extract_snapshot

logger = logging.getLogger("malabar")

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_CONFIG = 2


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )


def is_monitoring_day(now: datetime, settings: Settings) -> bool:
    """True if ``now`` (any timezone) falls on a monitoring weekday in the configured timezone."""
    return now.astimezone(settings.tz).weekday() in settings.monitoring_weekdays


def monitoring_date_for(now: datetime, settings: Settings) -> date:
    """The journey date to check.

    Scheduled runs happen before dawn, so this is normally today. For a manual
    run in the afternoon/evening the next useful arrival is tomorrow morning's,
    so after midday we look at tomorrow (this makes evening test runs show
    tonight's train instead of a stale FALLBACK).
    """
    local = now.astimezone(settings.tz)
    if local.hour >= 12:
        return local.date() + timedelta(days=1)
    return local.date()


def resolve_alarm(settings: Settings, client: Optional[RailRadarClient], monitoring_date: date) -> AlarmResult:
    if client is None:
        return build_fallback(settings, monitoring_date, "RailRadar API key is not configured")
    try:
        payload = client.fetch_live(settings.train_number)
    except RailRadarError as exc:
        return build_fallback(settings, monitoring_date, f"RailRadar API unavailable: {exc}")
    try:
        snapshot = extract_snapshot(payload, settings.train_number, settings.boarding_station_code, settings.tz)
    except TrainDataError as exc:
        return build_fallback(settings, monitoring_date, f"Unusable API response: {exc}")
    return calculate_from_snapshot(snapshot, settings, monitoring_date)


def _github_annotation(level: str, text: str) -> None:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        # Escape per GitHub workflow-command rules so API-supplied text cannot inject commands.
        safe = text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::{level}::{safe}", flush=True)


def _write_step_summary(lines: List[str]) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
    except OSError:
        logger.warning("Could not write GitHub step summary")


def run(
    settings: Settings,
    *,
    now: Optional[datetime] = None,
    force: bool = False,
    skip_dedupe: bool = False,
    dry_run: bool = False,
    railradar: Optional[RailRadarClient] = None,
    ntfy: Optional[NtfyClient] = None,
) -> int:
    tz = settings.tz
    now = (now or datetime.now(tz)).astimezone(tz)
    monitoring_date = monitoring_date_for(now, settings)
    logger.info(
        "Run started: train %s, station %s, now %s (%s), journey date %s",
        settings.train_number, settings.boarding_station_code, now.isoformat(), now.strftime("%A"),
        monitoring_date.isoformat(),
    )

    if not force and not is_monitoring_day(now, settings):
        logger.info("%s is not a monitoring day - nothing to do", now.strftime("%A"))
        return EXIT_OK

    # Notification client first: without it there is no point calling the API.
    if ntfy is None and not dry_run:
        try:
            ntfy = NtfyClient(
                settings.ntfy_server, settings.ntfy_topic, settings.ntfy_token,
                timeout=settings.ntfy_timeout_seconds, max_attempts=settings.ntfy_max_attempts,
            )
        except NotificationError as exc:
            logger.error("Configuration error: %s", exc)
            _github_annotation("error", f"Configuration error: {exc}")
            return EXIT_CONFIG

    key_missing = False
    if railradar is None:
        try:
            railradar = RailRadarClient(
                settings.railradar_api_key, settings.api_base_url,
                timeout=settings.api_timeout_seconds, max_attempts=settings.api_max_attempts,
            )
        except RailRadarError as exc:
            logger.error("%s - a FALLBACK notification will be sent", exc)
            key_missing = True

    result = resolve_alarm(settings, railradar, monitoring_date)
    logger.info(
        "Result: status=%s arrival=%s wakeup=%s delay=%s reason=%s",
        result.status.value, result.arrival.strftime("%H:%M"), result.wakeup.strftime("%H:%M"),
        result.delay_minutes, result.reason or "-",
    )
    message = build_message(result, settings, now, manual=force)
    _write_step_summary([
        "### Malabar Smart Alarm",
        f"- Status: **{result.status.value}**",
        f"- Arrival: {result.arrival:%H:%M} | Wake-up: {result.wakeup:%H:%M}",
        f"- Reason: {result.reason or '-'}",
    ])

    if dry_run:
        logger.info("Dry run - notification NOT sent. Message would be:\n%s\n%s", message.title, message.body)
        return EXIT_OK

    assert ntfy is not None
    if not skip_dedupe:
        try:
            bodies = ntfy.recent_bodies()
        except NotificationError as exc:
            # Better a possible duplicate than a missed alarm.
            logger.warning("Duplicate check unavailable (%s); sending anyway", exc)
            bodies = []
        send, why = should_send(bodies, settings.train_number, monitoring_date, result.status)
        if not send:
            logger.info("Not sending: %s", why)
            return EXIT_OK
        logger.info("Sending: %s", why)

    try:
        message_id = ntfy.publish(message)
    except NotificationError as exc:
        logger.error("Notification NOT delivered: %s", exc)
        _github_annotation("error", f"Notification NOT delivered: {exc}")
        return EXIT_FAILED

    logger.info("ntfy accepted the notification (id=%s, status=%s)", message_id, result.status.value)
    if result.status is not Status.LIVE:
        _github_annotation("warning", f"Sent {result.status.value} notification: {result.reason}")
    return EXIT_FAILED if key_missing else EXIT_OK


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Malabar Smart Alarm")
    parser.add_argument("--force", action="store_true", help="run even on a non-monitoring day")
    parser.add_argument("--skip-dedupe", action="store_true", help="send even if already sent today")
    parser.add_argument("--dry-run", action="store_true", help="print the message instead of sending it")
    args = parser.parse_args(argv)

    configure_logging()
    try:
        settings = load_settings()
    except ConfigError as exc:
        logger.error("Configuration error: %s", exc)
        _github_annotation("error", f"Configuration error: {exc}")
        return EXIT_CONFIG

    return run(
        settings,
        force=args.force or parse_bool(os.environ.get("FORCE_RUN")),
        skip_dedupe=args.skip_dedupe or parse_bool(os.environ.get("SKIP_DEDUPE")),
        dry_run=args.dry_run or parse_bool(os.environ.get("DRY_RUN")),
    )


if __name__ == "__main__":
    sys.exit(main())
