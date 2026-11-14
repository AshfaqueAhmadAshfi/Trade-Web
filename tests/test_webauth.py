"""Regression tests for dashboard authentication defaults."""
import os
import unittest
from unittest.mock import patch

from backend import webauth


class DashboardPasswordTests(unittest.TestCase):
    def test_missing_password_has_no_public_default(self):
        with patch.dict(os.environ, {"SOFTRADEX_DASHBOARD_PASSWORD": ""}):
            config = {}
            self.assertEqual(webauth.expected_password(config.get), "")
            self.assertFalse(webauth.password_ok("0186", config.get))

    def test_environment_password_overrides_config(self):
        with patch.dict(os.environ, {"SOFTRADEX_DASHBOARD_PASSWORD": "env-secret"}):
            config = {"dashboard_password": "config-secret"}
            self.assertEqual(webauth.expected_password(config.get), "env-secret")
            self.assertTrue(webauth.password_ok("env-secret", config.get))
            self.assertFalse(webauth.password_ok("config-secret", config.get))

    def test_config_password_works_without_environment_override(self):
        with patch.dict(os.environ, {"SOFTRADEX_DASHBOARD_PASSWORD": ""}):
            config = {"dashboard_password": "custom-secret"}
            self.assertEqual(webauth.expected_password(config.get), "custom-secret")
            self.assertTrue(webauth.password_ok("custom-secret", config.get))


if __name__ == "__main__":
    unittest.main()
