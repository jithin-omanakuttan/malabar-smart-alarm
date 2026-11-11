import unittest
from datetime import date, datetime, time, timezone

from src.alarm_calculator import Status, build_fallback, calculate_from_snapshot, calculate_wakeup
from src.train_service import extract_snapshot
from tests.helpers import IST, cngr, ist, load_fixture, make_settings

DAY = date(2026, 11, 12)


def snapshot_from(payload):
    return extract_snapshot(payload, "16630", "CNGR", IST)


class CalculateWakeupTests(unittest.TestCase):
    def test_forty_minute_buffer(self):
        self.assertEqual(calculate_wakeup(ist(2026, 11, 12, 5, 14), 40), ist(2026, 11, 12, 4, 34))

    def test_buffer_crossing_midnight(self):
        self.assertEqual(calculate_wakeup(ist(2026, 11, 12, 0, 20), 40), ist(2026, 11, 11, 23, 40))

    def test_rejects_naive_and_bad_buffers(self):
        with self.assertRaises(ValueError):
            calculate_wakeup(datetime(2026, 11, 12, 5, 14), 40)
        for bad in (-1, 241, True, 40.5):
            with self.assertRaises(ValueError):
                calculate_wakeup(ist(2026, 11, 12, 5, 14), bad)


class CalculateFromSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.settings = make_settings()
        self.payload = load_fixture()

    def test_live_prediction_uses_actual_arrival(self):
        result = calculate_from_snapshot(snapshot_from(self.payload), self.settings, DAY)
        self.assertIs(result.status, Status.LIVE)
        self.assertEqual(result.arrival, ist(2026, 11, 12, 5, 14))
        self.assertEqual(result.wakeup, ist(2026, 11, 12, 4, 34))
        self.assertEqual(result.delay_minutes, 23)
        self.assertEqual(result.provenance, "predicted")
        self.assertIsNone(result.reason)

    def test_uses_arrival_not_departure(self):
        result = calculate_from_snapshot(snapshot_from(self.payload), self.settings, DAY)
        self.assertNotEqual(result.arrival, ist(2026, 11, 12, 5, 16))  # actualDeparture

    def test_scheduled_arrival_used_when_no_prediction(self):
        cngr(self.payload)["actualArrival"] = None
        result = calculate_from_snapshot(snapshot_from(self.payload), self.settings, DAY)
        self.assertIs(result.status, Status.SCHEDULED)
        self.assertEqual(result.arrival, ist(2026, 11, 12, 4, 51))
        self.assertEqual(result.wakeup, ist(2026, 11, 12, 4, 11))
        self.assertIn("No live prediction", result.reason)

    def test_invalid_actual_arrival_falls_back_to_schedule(self):
        cngr(self.payload)["actualArrival"] = "soon"
        result = calculate_from_snapshot(snapshot_from(self.payload), self.settings, DAY)
        self.assertIs(result.status, Status.SCHEDULED)
        self.assertIn("not a valid timestamp", result.reason)

    def test_missing_both_arrivals_gives_fallback(self):
        cngr(self.payload)["actualArrival"] = None
        del cngr(self.payload)["scheduledArrival"]
        result = calculate_from_snapshot(snapshot_from(self.payload), self.settings, DAY)
        self.assertIs(result.status, Status.FALLBACK)
        self.assertEqual(result.wakeup, ist(2026, 11, 12, 4, 11))
        self.assertIn("No arrival time", result.reason)

    def test_stale_journey_is_never_live(self):
        # API still showing yesterday's run.
        cngr(self.payload)["scheduledArrival"] = "2026-11-11T04:51:00+05:30"
        cngr(self.payload)["actualArrival"] = "2026-11-11T05:14:00+05:30"
        result = calculate_from_snapshot(snapshot_from(self.payload), self.settings, DAY)
        self.assertIs(result.status, Status.FALLBACK)
        self.assertIn("11 Nov 2026", result.reason)

    def test_implausible_prediction_is_ignored(self):
        cngr(self.payload)["actualArrival"] = "2026-11-13T05:14:00+05:30"  # 24h late
        result = calculate_from_snapshot(snapshot_from(self.payload), self.settings, DAY)
        self.assertIs(result.status, Status.SCHEDULED)
        self.assertIn("implausibly", result.reason)

    def test_utc_timestamps_converted_to_ist(self):
        cngr(self.payload)["scheduledArrival"] = "2026-11-11T23:21:00Z"
        cngr(self.payload)["actualArrival"] = "2026-11-11T23:44:00+00:00"
        result = calculate_from_snapshot(snapshot_from(self.payload), self.settings, DAY)
        self.assertIs(result.status, Status.LIVE)
        self.assertEqual(result.arrival, ist(2026, 11, 12, 5, 14))
        self.assertEqual(result.arrival.utcoffset().total_seconds(), 5.5 * 3600)
        self.assertEqual(result.wakeup.strftime("%I:%M %p"), "04:34 AM")

    def test_custom_buffer(self):
        result = calculate_from_snapshot(snapshot_from(self.payload), make_settings(buffer_minutes=60), DAY)
        self.assertEqual(result.wakeup, ist(2026, 11, 12, 4, 14))


class FallbackTests(unittest.TestCase):
    def test_default_fallback_is_0411(self):
        result = build_fallback(make_settings(), DAY, "API down")
        self.assertIs(result.status, Status.FALLBACK)
        self.assertEqual(result.arrival, ist(2026, 11, 12, 4, 51))
        self.assertEqual(result.wakeup, ist(2026, 11, 12, 4, 11))
        self.assertEqual(result.reason, "API down")

    def test_configurable_fallback(self):
        result = build_fallback(make_settings(fallback_scheduled_arrival=time(5, 0)), DAY, "x")
        self.assertEqual(result.wakeup, ist(2026, 11, 12, 4, 20))
        self.assertEqual(result.wakeup.astimezone(timezone.utc).hour, 22)


if __name__ == "__main__":
    unittest.main()
