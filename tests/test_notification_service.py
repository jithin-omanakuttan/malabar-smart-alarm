import json
import socket
import unittest
from datetime import date

from src.alarm_calculator import AlarmResult, Status, build_fallback
from src.notification_service import (
    NotificationError, NtfyClient, build_message, format_delay, make_marker, should_send,
)
from tests.helpers import FAKE_TOPIC, FakeOpener, http_error, ist, make_settings, no_sleep

DAY = date(2026, 11, 12)
NOW = ist(2026, 11, 12, 4, 0)


def live_result(**kw):
    base = dict(
        status=Status.LIVE, monitoring_date=DAY, arrival=ist(2026, 11, 12, 5, 14),
        wakeup=ist(2026, 11, 12, 4, 34), buffer_minutes=40, delay_minutes=23, provenance="predicted",
    )
    base.update(kw)
    return AlarmResult(**base)


def ntfy(opener, token=""):
    return NtfyClient("https://ntfy.sh", FAKE_TOPIC, token, opener=opener, sleep=no_sleep)


class BuildMessageTests(unittest.TestCase):
    def test_live_payload(self):
        msg = build_message(live_result(), make_settings(), NOW)
        self.assertEqual(msg.title, "Malabar Smart Alarm")
        self.assertEqual(msg.priority, 5)
        lines = msg.body.splitlines()
        self.assertEqual(lines[0], "Train: Malabar Express (16630)")
        self.assertEqual(lines[1], "Boarding: Chengannur (CNGR)")
        self.assertIn("Predicted arrival: 05:14 AM", lines)
        self.assertIn("Recommended wake-up: 04:34 AM", lines)
        self.assertIn("Delay: 23 minutes", lines)
        self.assertIn("Status: LIVE", lines)
        self.assertEqual(lines[-1], "Ref: 16630/2026-11-12/LIVE")
        self.assertNotIn("passed", msg.body)

    def test_fallback_clearly_labelled(self):
        result = build_fallback(make_settings(), DAY, "RailRadar API unavailable: timed out")
        msg = build_message(result, make_settings(), NOW)
        self.assertIn("FALLBACK", msg.title)
        self.assertIn("Status: FALLBACK", msg.body)
        self.assertIn("NOT live", msg.body)
        self.assertIn("Recommended wake-up: 04:11 AM", msg.body)
        self.assertIn("Reason: RailRadar API unavailable", msg.body)
        self.assertNotIn("Predicted arrival", msg.body)
        self.assertIn("warning", msg.tags)

    def test_scheduled_labelled(self):
        result = live_result(status=Status.SCHEDULED, arrival=ist(2026, 11, 12, 4, 51),
                             wakeup=ist(2026, 11, 12, 4, 11), reason="No live prediction")
        msg = build_message(result, make_settings(), NOW)
        self.assertIn("Scheduled arrival: 04:51 AM (no live prediction)", msg.body)
        self.assertIn("SCHEDULED", msg.title)

    def test_wakeup_already_passed_note(self):
        msg = build_message(live_result(), make_settings(), ist(2026, 11, 12, 4, 40))
        self.assertIn("already passed", msg.body)

    def test_manual_marker_suffix(self):
        msg = build_message(live_result(), make_settings(), NOW, manual=True)
        self.assertTrue(msg.body.endswith("Ref: 16630/2026-11-12/LIVE/manual"))

    def test_format_delay(self):
        self.assertEqual(format_delay(None), "not available")
        self.assertEqual(format_delay(0), "on time")
        self.assertEqual(format_delay(1), "1 minute")
        self.assertEqual(format_delay(-5), "running 5 minutes early")


class ShouldSendTests(unittest.TestCase):
    def marker(self, status, day=DAY, manual=False):
        return f"Train...\n{make_marker('16630', day, status, manual)}"

    def test_first_send(self):
        self.assertTrue(should_send([], "16630", DAY, Status.LIVE)[0])

    def test_duplicate_live_skipped(self):
        self.assertFalse(should_send([self.marker(Status.LIVE)], "16630", DAY, Status.LIVE)[0])

    def test_fallback_upgraded_to_live(self):
        send, why = should_send([self.marker(Status.FALLBACK)], "16630", DAY, Status.LIVE)
        self.assertTrue(send)
        self.assertIn("upgrading", why)

    def test_repeated_fallback_skipped(self):
        self.assertFalse(should_send([self.marker(Status.FALLBACK)], "16630", DAY, Status.FALLBACK)[0])

    def test_fallback_after_live_skipped(self):
        self.assertFalse(should_send([self.marker(Status.LIVE)], "16630", DAY, Status.FALLBACK)[0])

    def test_other_day_and_manual_ignored(self):
        bodies = [self.marker(Status.LIVE, date(2026, 11, 11)), self.marker(Status.LIVE, manual=True)]
        self.assertTrue(should_send(bodies, "16630", DAY, Status.LIVE)[0])


class NtfyClientTests(unittest.TestCase):
    def test_publish_headers_and_body(self):
        opener = FakeOpener([{"id": "abc123", "event": "message"}])
        msg = build_message(live_result(), make_settings(), NOW)
        self.assertEqual(ntfy(opener, token="tk_test").publish(msg), "abc123")
        req = opener.requests[0]
        self.assertEqual(req.full_url, f"https://ntfy.sh/{FAKE_TOPIC}")
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(req.get_header("Title"), "Malabar Smart Alarm")
        self.assertEqual(req.get_header("Priority"), "5")
        self.assertEqual(req.get_header("Tags"), "steam_locomotive,alarm_clock")
        self.assertEqual(req.get_header("Authorization"), "Bearer tk_test")
        self.assertEqual(req.data.decode("utf-8"), msg.body)

    def test_publish_failure_is_reported_without_topic(self):
        url = f"https://ntfy.sh/{FAKE_TOPIC}"
        opener = FakeOpener([http_error(url, 500), http_error(url, 502), http_error(url, 503)])
        with self.assertRaises(NotificationError) as ctx:
            ntfy(opener).publish(build_message(live_result(), make_settings(), NOW))
        self.assertEqual(len(opener.requests), 3)
        self.assertNotIn(FAKE_TOPIC, str(ctx.exception))

    def test_publish_client_error_not_retried(self):
        opener = FakeOpener([http_error("https://ntfy.sh/x", 403)])
        with self.assertRaises(NotificationError):
            ntfy(opener).publish(build_message(live_result(), make_settings(), NOW))
        self.assertEqual(len(opener.requests), 1)

    def test_publish_timeout(self):
        opener = FakeOpener([socket.timeout()] * 3)
        with self.assertRaisesRegex(NotificationError, "timed out"):
            ntfy(opener).publish(build_message(live_result(), make_settings(), NOW))

    def test_unconfirmed_publish_is_failure(self):
        with self.assertRaises(NotificationError):
            ntfy(FakeOpener([b"not json"])).publish(build_message(live_result(), make_settings(), NOW))

    def test_recent_bodies_parses_ndjson(self):
        lines = [
            {"event": "open"},
            {"event": "message", "message": "hello\nRef: 16630/2026-11-12/LIVE"},
            {"event": "keepalive"},
        ]
        raw = ("\n".join(json.dumps(x) for x in lines) + "\n").encode()
        opener = FakeOpener([raw])
        bodies = ntfy(opener).recent_bodies()
        self.assertEqual(bodies, ["hello\nRef: 16630/2026-11-12/LIVE"])
        self.assertIn("/json?poll=1&since=12h", opener.requests[0].full_url)

    def test_rejects_bad_config(self):
        with self.assertRaises(NotificationError):
            NtfyClient("https://ntfy.sh", "")
        with self.assertRaises(NotificationError):
            NtfyClient("https://ntfy.sh", "bad/topic")
        with self.assertRaises(NotificationError):
            NtfyClient("http://ntfy.sh", FAKE_TOPIC)
        self.assertNotIn(FAKE_TOPIC, repr(ntfy(FakeOpener([]))))


if __name__ == "__main__":
    unittest.main()
