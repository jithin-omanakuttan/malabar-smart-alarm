import socket
import unittest
import urllib.error

from src.railradar_client import RailRadarClient, RailRadarError
from src.train_service import TrainDataError, extract_snapshot, parse_timestamp, InvalidTimestampError
from tests.helpers import FAKE_API_KEY, IST, FakeOpener, cngr, http_error, ist, load_fixture, no_sleep

URL = "https://api.railradar.in/v1/trains/16630/live"


def client(opener, **kw):
    return RailRadarClient(FAKE_API_KEY, opener=opener, sleep=no_sleep, **kw)


class RailRadarClientTests(unittest.TestCase):
    def test_successful_response(self):
        opener = FakeOpener([load_fixture()])
        payload = client(opener).fetch_live("16630")
        self.assertTrue(payload["success"])
        request = opener.requests[0]
        self.assertEqual(request.full_url, URL)
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("Authorization"), f"Bearer {FAKE_API_KEY}")
        self.assertEqual(opener.timeouts[0], 20.0)

    def test_timeout_is_retried_then_reported(self):
        opener = FakeOpener([socket.timeout("timed out"), socket.timeout("timed out")])
        with self.assertRaises(RailRadarError) as ctx:
            client(opener, max_attempts=2).fetch_live("16630")
        self.assertIn("timed out", str(ctx.exception))
        self.assertEqual(len(opener.requests), 2)

    def test_timeout_wrapped_in_urlerror(self):
        opener = FakeOpener([urllib.error.URLError(socket.timeout("timed out"))])
        with self.assertRaises(RailRadarError) as ctx:
            client(opener, max_attempts=1).fetch_live("16630")
        self.assertIn("timed out", str(ctx.exception))

    def test_recovers_after_transient_error(self):
        opener = FakeOpener([http_error(URL, 503), load_fixture()])
        self.assertTrue(client(opener).fetch_live("16630")["success"])

    def test_auth_error_not_retried_and_key_not_leaked(self):
        opener = FakeOpener([http_error(URL, 401)])
        with self.assertRaises(RailRadarError) as ctx:
            client(opener, max_attempts=3).fetch_live("16630")
        self.assertEqual(len(opener.requests), 1)
        self.assertIn("401", str(ctx.exception))
        self.assertNotIn(FAKE_API_KEY, str(ctx.exception))
        self.assertNotIn(FAKE_API_KEY, repr(client(opener)))

    def test_invalid_json(self):
        with self.assertRaises(RailRadarError) as ctx:
            client(FakeOpener([b"<html>oops</html>"])).fetch_live("16630")
        self.assertIn("invalid JSON", str(ctx.exception))

    def test_json_that_is_not_an_object(self):
        with self.assertRaises(RailRadarError):
            client(FakeOpener([[1, 2, 3]])).fetch_live("16630")

    def test_requires_key_and_https(self):
        with self.assertRaises(RailRadarError):
            RailRadarClient("")
        with self.assertRaises(RailRadarError):
            RailRadarClient(FAKE_API_KEY, base_url="http://api.railradar.in/v1")
        with self.assertRaises(RailRadarError):
            client(FakeOpener([])).live_url("16630/../x")


class ExtractSnapshotTests(unittest.TestCase):
    def test_extracts_chengannur(self):
        snap = extract_snapshot(load_fixture(), "16630", "CNGR", IST)
        self.assertEqual(snap.train_number, "16630")
        self.assertEqual(snap.delay_minutes, 23)
        st = snap.station
        self.assertEqual(st.station_code, "CNGR")
        self.assertEqual(st.station_name, "Chengannur")
        self.assertEqual(st.status, "upcoming")
        self.assertEqual(st.provenance, "predicted")
        self.assertEqual(st.scheduled_arrival, ist(2026, 11, 12, 4, 51))
        self.assertEqual(st.actual_arrival, ist(2026, 11, 12, 5, 14))
        self.assertEqual(st.invalid_fields, ())

    def test_station_code_case_insensitive(self):
        snap = extract_snapshot(load_fixture(), "16630", "cngr", IST)
        self.assertEqual(snap.station.station_code, "CNGR")

    def test_missing_station(self):
        payload = load_fixture()
        payload["data"]["route"] = [r for r in payload["data"]["route"] if r["stationCode"] != "CNGR"]
        with self.assertRaisesRegex(TrainDataError, "CNGR not found"):
            extract_snapshot(payload, "16630", "CNGR", IST)

    def test_missing_predicted_arrival_fields(self):
        payload = load_fixture()
        del cngr(payload)["actualArrival"]
        cngr(payload)["scheduledArrival"] = ""
        snap = extract_snapshot(payload, "16630", "CNGR", IST)
        self.assertIsNone(snap.station.actual_arrival)
        self.assertIsNone(snap.station.scheduled_arrival)

    def test_invalid_timestamp_recorded(self):
        payload = load_fixture()
        cngr(payload)["actualArrival"] = 12345
        snap = extract_snapshot(payload, "16630", "CNGR", IST)
        self.assertIsNone(snap.station.actual_arrival)
        self.assertEqual(snap.station.invalid_fields, ("actualArrival",))

    def test_invalid_responses(self):
        cases = {
            "not an object": [],
            "success false": {"success": False, "data": {}},
            "no data": {"success": True},
            "no train number": {"success": True, "data": {"train": {}, "route": [{}]}},
            "empty route": {"success": True, "data": {"train": {"number": "16630"}, "route": []}},
        }
        for name, payload in cases.items():
            with self.subTest(name):
                with self.assertRaises(TrainDataError):
                    extract_snapshot(payload, "16630", "CNGR", IST)

    def test_wrong_train_number(self):
        payload = load_fixture()
        payload["data"]["train"]["number"] = 16629
        with self.assertRaisesRegex(TrainDataError, "16629"):
            extract_snapshot(payload, "16630", "CNGR", IST)

    def test_numeric_train_number_accepted(self):
        payload = load_fixture()
        payload["data"]["train"]["number"] = 16630
        self.assertEqual(extract_snapshot(payload, "16630", "CNGR", IST).train_number, "16630")

    def test_null_delay(self):
        payload = load_fixture()
        payload["data"]["delayMinutes"] = None
        self.assertIsNone(extract_snapshot(payload, "16630", "CNGR", IST).delay_minutes)


class ParseTimestampTests(unittest.TestCase):
    def test_ist_offset_preserved(self):
        self.assertEqual(parse_timestamp("2026-11-12T05:14:00+05:30", IST), ist(2026, 11, 12, 5, 14))

    def test_utc_z_converted(self):
        self.assertEqual(parse_timestamp("2026-11-11T23:44:00Z", IST), ist(2026, 11, 12, 5, 14))

    def test_naive_assumed_local(self):
        self.assertEqual(parse_timestamp("2026-11-12T05:14:00", IST), ist(2026, 11, 12, 5, 14))

    def test_empty_and_invalid(self):
        self.assertIsNone(parse_timestamp(None, IST))
        self.assertIsNone(parse_timestamp("  ", IST))
        for bad in ("tomorrow", "2026-13-40T00:00:00", 5):
            with self.assertRaises(InvalidTimestampError):
                parse_timestamp(bad, IST)


if __name__ == "__main__":
    unittest.main()
