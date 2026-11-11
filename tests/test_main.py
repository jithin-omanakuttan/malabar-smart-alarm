"""End-to-end tests of main.run with fake HTTP, plus scheduling checks."""

import logging
import re
import socket
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

from src.main import EXIT_CONFIG, EXIT_FAILED, EXIT_OK, is_monitoring_day, monitoring_date_for, run
from src.notification_service import NtfyClient
from src.railradar_client import RailRadarClient
from tests.helpers import (
    FAKE_API_KEY, FAKE_TOPIC, FakeOpener, http_error, ist, load_fixture, make_settings, no_sleep,
)

WORKFLOW = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "malabar-alarm.yml"
PUBLISHED = {"id": "m1", "event": "message"}


def utc(*args):
    return datetime(*args, tzinfo=timezone.utc)


class SchedulingTests(unittest.TestCase):
    def setUp(self):
        self.settings = make_settings()

    def test_ist_weekday_rollover_from_utc(self):
        # Sunday 22:30 UTC == Monday 04:00 IST -> monitoring day
        self.assertEqual(utc(2026, 11, 8, 22, 30).weekday(), 6)
        self.assertTrue(is_monitoring_day(utc(2026, 11, 8, 22, 30), self.settings))
        # Friday 22:30 UTC == Saturday 04:00 IST -> not a monitoring day
        self.assertFalse(is_monitoring_day(utc(2026, 11, 13, 22, 30), self.settings))
        # Thursday 22:30 UTC == Friday 04:00 IST -> monitoring day
        self.assertTrue(is_monitoring_day(utc(2026, 11, 12, 22, 30), self.settings))

    def test_monday_to_friday_only(self):
        expected = [True, True, True, True, True, False, False]
        actual = [is_monitoring_day(ist(2026, 11, 9 + i, 4, 0), self.settings) for i in range(7)]
        self.assertEqual(actual, expected)

    def test_monitoring_date(self):
        self.assertEqual(monitoring_date_for(ist(2026, 11, 12, 3, 47), self.settings), date(2026, 11, 12))
        self.assertEqual(monitoring_date_for(utc(2026, 11, 11, 22, 30), self.settings), date(2026, 11, 12))
        # Evening manual test looks at tomorrow morning's arrival
        self.assertEqual(monitoring_date_for(ist(2026, 11, 11, 21, 0), self.settings), date(2026, 11, 12))

    def test_workflow_schedule(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        crons = re.findall(r"- cron: '([^']+)'\s*\n\s*timezone: '([^']+)'", text)
        self.assertEqual(crons, [("47 3 * * 1-5", "Asia/Kolkata"), ("53 3 * * 1-5", "Asia/Kolkata"),
                                 ("0 4 * * 1-5", "Asia/Kolkata")])
        self.assertIn("workflow_dispatch:", text)
        self.assertIn("concurrency:", text)
        self.assertIn("${{ secrets.RAILRADAR_API_KEY }}", text)
        self.assertNotRegex(text, r"RAILRADAR_API_KEY:\s*['\"]?[A-Za-z0-9]{8,}")


class RunTests(unittest.TestCase):
    def setUp(self):
        self.settings = make_settings()
        self.now = ist(2026, 11, 12, 4, 0)  # Thursday

    def clients(self, api_outcomes, ntfy_outcomes):
        api = FakeOpener(api_outcomes)
        notify = FakeOpener(ntfy_outcomes)
        rr = RailRadarClient(FAKE_API_KEY, opener=api, sleep=no_sleep)
        nt = NtfyClient("https://ntfy.sh", FAKE_TOPIC, opener=notify, sleep=no_sleep)
        return rr, nt, api, notify

    def test_live_end_to_end(self):
        rr, nt, api, notify = self.clients([load_fixture()], [b"", PUBLISHED])
        with self.assertLogs("malabar", level="INFO") as logs:
            code = run(self.settings, now=self.now, railradar=rr, ntfy=nt)
        self.assertEqual(code, EXIT_OK)
        body = notify.requests[1].data.decode()
        self.assertIn("Predicted arrival: 05:14 AM", body)
        self.assertIn("Recommended wake-up: 04:34 AM", body)
        self.assertIn("Status: LIVE", body)
        joined = "\n".join(logs.output)
        self.assertNotIn(FAKE_API_KEY, joined)
        self.assertNotIn(FAKE_TOPIC, joined)

    def test_api_timeout_sends_fallback(self):
        rr, nt, api, notify = self.clients([socket.timeout(), socket.timeout()], [b"", PUBLISHED])
        self.assertEqual(run(self.settings, now=self.now, railradar=rr, ntfy=nt), EXIT_OK)
        body = notify.requests[1].data.decode()
        self.assertIn("Status: FALLBACK", body)
        self.assertIn("Recommended wake-up: 04:11 AM", body)

    def test_duplicate_skipped(self):
        history = b'{"event":"message","message":"x\\nRef: 16630/2026-11-12/LIVE"}\n'
        rr, nt, api, notify = self.clients([load_fixture()], [history])
        self.assertEqual(run(self.settings, now=self.now, railradar=rr, ntfy=nt), EXIT_OK)
        self.assertEqual(len(notify.requests), 1)  # history lookup only, no publish

    def test_delivery_failure_returns_error(self):
        url = "https://ntfy.sh/x"
        rr, nt, api, notify = self.clients(
            [load_fixture()], [b"", http_error(url, 500), http_error(url, 500), http_error(url, 500)])
        with self.assertLogs("malabar", level="ERROR") as logs:
            code = run(self.settings, now=self.now, railradar=rr, ntfy=nt)
        self.assertEqual(code, EXIT_FAILED)
        self.assertIn("NOT delivered", "\n".join(logs.output))

    def test_history_failure_still_sends(self):
        rr, nt, api, notify = self.clients([load_fixture()], [http_error("https://ntfy.sh/x", 403), PUBLISHED])
        self.assertEqual(run(self.settings, now=self.now, railradar=rr, ntfy=nt), EXIT_OK)
        self.assertEqual(notify.requests[-1].get_method(), "POST")

    def test_weekend_does_nothing_unless_forced(self):
        saturday = ist(2026, 11, 14, 4, 0)
        rr, nt, api, notify = self.clients([], [])
        self.assertEqual(run(self.settings, now=saturday, railradar=rr, ntfy=nt), EXIT_OK)
        self.assertEqual(api.requests, [])
        rr, nt, api, notify = self.clients([load_fixture()], [PUBLISHED])
        run(self.settings, now=saturday, force=True, skip_dedupe=True, railradar=rr, ntfy=nt)
        self.assertEqual(len(notify.requests), 1)

    def test_missing_topic_is_config_error(self):
        code = run(make_settings(ntfy_topic=""), now=self.now)
        self.assertEqual(code, EXIT_CONFIG)

    def test_missing_api_key_sends_fallback_and_fails(self):
        notify = FakeOpener([b"", PUBLISHED])
        nt = NtfyClient("https://ntfy.sh", FAKE_TOPIC, opener=notify, sleep=no_sleep)
        logging.disable(logging.CRITICAL)
        try:
            code = run(make_settings(railradar_api_key=""), now=self.now, ntfy=nt)
        finally:
            logging.disable(logging.NOTSET)
        self.assertEqual(code, EXIT_FAILED)
        self.assertIn("Status: FALLBACK", notify.requests[1].data.decode())

    def test_dry_run_sends_nothing(self):
        rr, nt, api, notify = self.clients([load_fixture()], [])
        self.assertEqual(run(self.settings, now=self.now, dry_run=True, railradar=rr, ntfy=nt), EXIT_OK)
        self.assertEqual(notify.requests, [])


if __name__ == "__main__":
    unittest.main()
