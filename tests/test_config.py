import unittest
from datetime import time

from src.config import ConfigError, load_settings, parse_weekdays


class ConfigTests(unittest.TestCase):
    def test_defaults(self):
        s = load_settings({})
        self.assertEqual((s.train_number, s.boarding_station_code, s.buffer_minutes), ("16630", "CNGR", 40))
        self.assertEqual(s.timezone, "Asia/Kolkata")
        self.assertEqual(s.monitoring_weekdays, frozenset({0, 1, 2, 3, 4}))
        self.assertEqual(s.fallback_scheduled_arrival, time(4, 51))

    def test_empty_strings_mean_default(self):
        # GitHub expands unset vars to ""
        s = load_settings({"BUFFER_MINUTES": "", "TRAIN_NUMBER": "  ", "NTFY_TOPIC": ""})
        self.assertEqual((s.buffer_minutes, s.train_number, s.ntfy_topic), (40, "16630", ""))

    def test_overrides(self):
        s = load_settings({
            "BUFFER_MINUTES": "30", "BOARDING_STATION_CODE": "ktym", "MONITORING_DAYS": "MON-WED,SAT",
            "FALLBACK_SCHEDULED_ARRIVAL": "03:30", "RAILRADAR_API_KEY": "k", "NTFY_TOPIC": "my_topic-1",
        })
        self.assertEqual(s.buffer_minutes, 30)
        self.assertEqual(s.boarding_station_code, "KTYM")
        self.assertEqual(s.monitoring_weekdays, frozenset({0, 1, 2, 5}))
        self.assertEqual(s.fallback_scheduled_arrival, time(3, 30))

    def test_secrets_hidden_from_repr(self):
        s = load_settings({"RAILRADAR_API_KEY": "supersecret", "NTFY_TOPIC": "secrettopic", "NTFY_TOKEN": "tk"})
        self.assertNotIn("supersecret", repr(s))
        self.assertNotIn("secrettopic", repr(s))

    def test_invalid_values(self):
        for env in ({"BUFFER_MINUTES": "abc"}, {"BUFFER_MINUTES": "500"}, {"TRAIN_NUMBER": "16x30"},
                    {"TIMEZONE": "Mars/Base"}, {"FALLBACK_SCHEDULED_ARRIVAL": "4.51"},
                    {"NTFY_SERVER": "http://ntfy.sh"}, {"MONITORING_DAYS": "FUNDAY"}):
            with self.subTest(env):
                with self.assertRaises(ConfigError):
                    load_settings(env)

    def test_invalid_topic_not_echoed(self):
        with self.assertRaises(ConfigError) as ctx:
            load_settings({"NTFY_TOPIC": "secret/with/slash"})
        self.assertNotIn("secret", str(ctx.exception).replace("NTFY_TOPIC", ""))

    def test_parse_weekdays(self):
        self.assertEqual(parse_weekdays("mon-fri"), frozenset(range(5)))
        with self.assertRaises(ConfigError):
            parse_weekdays("FRI-MON")


if __name__ == "__main__":
    unittest.main()
