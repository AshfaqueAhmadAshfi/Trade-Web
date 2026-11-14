"""Keep the unit suite offline; live provider checks are separate diagnostics."""
from unittest.mock import patch

import pytest
from backend.tv_feed import TradingViewError


@pytest.fixture(autouse=True)
def offline_network():
    with patch("urllib.request.urlopen", side_effect=OSError("offline unit test")), \
            patch("requests.sessions.Session.request", side_effect=OSError("offline unit test")), \
            patch("backend.tv_feed.connect", side_effect=TradingViewError("offline unit test")):
        yield
