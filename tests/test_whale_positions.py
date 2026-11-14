"""Public holdings require authoritative snapshots; no live network in tests."""
import threading
import time
from unittest.mock import Mock

import pytest

from backend.whale_positions import (
    MAX_CHECKS,
    MAX_NEW,
    MAX_TRACKED,
    WhalePositions,
    _position,
    contract_for,
)


def wallet(n):
    return "0x" + f"{n:040x}"


def held(coin="xyz:GOLD", size="30", entry="3900", value="117000"):
    return {"assetPositions": [{"position": {
        "coin": coin, "szi": size, "entryPx": entry, "positionValue": value}}]}


class Provider:
    def __init__(self, coin="xyz:GOLD"):
        self.coin = coin
        self.wallets = [wallet(1), wallet(2)]
        self.positions = {wallet(1): held(coin), wallet(2): held(coin, size="-40", value="156000")}
        self.clock = 1000
        self.calls = []
        self.fail_discovery = False
        self.feed = WhalePositions(request=self.request, clock=lambda: self.clock, background=False, discovery=list)

    def request(self, body):
        self.calls.append(dict(body))
        if body["type"] == "meta":
            return {"universe": [{"name": self.coin}]}
        if body["type"] == "recentTrades":
            if self.fail_discovery:
                raise OSError("offline")
            return [{"coin": self.coin, "users": self.wallets}]
        value = self.positions[body["user"]]
        if isinstance(value, Exception):
            raise value
        return value

    def scan(self, market="XAUUSDm"):
        self.clock += 16
        return self.feed.snapshot(market)


def test_selected_contracts_are_explicit_and_fx_is_not_guessed():
    assert contract_for("XAUUSDm")[0] == "xyz:GOLD"
    assert contract_for("XAUUSD247m")[0] == "xyz:GOLD"
    assert contract_for("XAGUSDm")[0] == "xyz:SILVER"
    assert contract_for("BTCUSDTm")[0] == "BTC"
    for symbol in ("EURUSDm", "XAUGBPm", "SOLBTC", "EURBTC", "unlisted"):
        assert contract_for(symbol) is None
    request = Mock()
    data = WhalePositions(request=request).snapshot("EURUSDm")
    assert data["status"] == "unsupported"
    request.assert_not_called()


def test_wallet_identity_entry_side_counts_and_case_deduplication():
    p = Provider()
    p.wallets += [wallet(1).upper().replace("0X", "0x"), wallet(2)]
    data = p.scan()
    assert data["buy_count"] == data["sell_count"] == 1
    assert len(data["positions"]) == 2
    assert data["positions"][0]["wallet"] == wallet(2)
    assert data["positions"][0]["entry_price"] == 3900
    assert all(call.get("dex") == "xyz" for call in p.calls if call["type"] == "clearinghouseState")
    assert len([call for call in p.calls if call["type"] == "clearinghouseState"]) == 2


def test_reduced_hold_survives_below_threshold_and_exits_only_on_snapshot():
    p = Provider()
    p.scan()
    p.wallets = []  # A quiet wallet must still be checked.
    p.positions[wallet(1)] = held(size="1", value="3900")
    data = p.scan()
    assert data["buy_count"] == 1
    assert next(row for row in data["positions"] if row["side"] == "BUY")["value_usd"] == 3900
    p.positions[wallet(1)] = {"assetPositions": []}
    data = p.scan()
    assert data["buy_count"] == 0 and data["sell_count"] == 1


def test_zero_and_side_reversal_confirm_the_old_side_has_exited():
    p = Provider()
    p.scan()
    p.positions[wallet(1)] = held(size="-1", value="3900")
    p.positions[wallet(2)] = held(size="0", entry=None, value="0")
    data = p.scan()
    assert data["positions"] == []
    p.positions[wallet(1)] = held(size="-40", value="156000")
    data = p.scan()
    assert data["buy_count"] == 0 and data["sell_count"] == 1


def test_failure_keeps_last_verified_position_and_success_recovers():
    p = Provider()
    previous = p.scan()["positions"]
    p.positions[wallet(1)] = OSError("timeout")
    p.positions[wallet(2)] = {"error": "rate limited"}
    p.fail_discovery = True
    data = p.scan()
    assert data["status"] == "partial"
    assert data["buy_count"] == data["sell_count"] == 1
    assert all(row["stale"] for row in data["positions"])
    assert [row["verified_at"] for row in data["positions"]] == [row["verified_at"] for row in previous]
    p.positions[wallet(1)] = {"assetPositions": []}
    p.positions[wallet(2)] = held(size="-20", value="78000")
    p.fail_discovery = False
    data = p.scan()
    assert data["status"] == "ok"
    assert data["buy_count"] == 0 and data["sell_count"] == 1
    assert not data["positions"][0]["stale"]


@pytest.mark.parametrize("bad", [None, {}, {"assetPositions": None}, {"assetPositions": [None]},
                                  held(size="NaN"), held(entry="0"), held(value="inf"),
                                  {"assetPositions": [{"position": {"coin": "ETH"}}]}])
def test_malformed_snapshots_are_never_exits(bad):
    p = Provider()
    p.scan()
    p.positions[wallet(1)] = bad
    data = p.scan()
    assert data["buy_count"] == 1
    assert next(row for row in data["positions"] if row["side"] == "BUY")["stale"]


def test_exact_coin_matching_never_substitutes_another_market():
    assert _position(held("BTC"), "xyz:GOLD") is None
    p = Provider("BTC")
    data = p.scan("BTCUSDTm")
    assert data["contract"] == "BTC" and data["buy_count"] == 1
    assert not any("dex" in call for call in p.calls)
    # A Gold request against native BTC metadata has explicit unavailable coverage.
    assert p.scan("XAUUSDm")["status"] == "unsupported"


def test_discovery_rotates_candidates_and_scans_are_bounded():
    p = Provider()
    p.wallets = [wallet(n) for n in range(1, 41)]
    p.positions = {w: held(value="120000") for w in p.wallets}
    for _ in range(9):
        p.calls.clear()
        data = p.scan()
        assert len([call for call in p.calls if call["type"] == "clearinghouseState"]) <= MAX_CHECKS
    assert len(data["positions"]) == MAX_TRACKED
    # A small print can discover a large holding; never filter on fill notional.
    assert data["buy_count"] == MAX_TRACKED


def test_small_candidates_rotate_instead_of_starving_later_whales():
    p = Provider()
    p.wallets = [wallet(n) for n in range(1, MAX_NEW + 5)]
    p.positions = {w: held(value="1000") for w in p.wallets}
    p.positions[wallet(MAX_NEW + 1)] = held(value="100000")
    assert p.scan()["positions"] == []
    assert p.scan()["positions"][0]["wallet"] == wallet(MAX_NEW + 1)


def test_broad_public_discovery_finds_old_holders_without_recent_fills():
    p = Provider()
    p.wallets = []
    p.feed._discovery = lambda: [wallet(1), wallet(2)]
    data = p.scan()
    assert data["buy_count"] == data["sell_count"] == 1
    assert data["wallets_checked"] == 2
    assert data["candidates_total"] == 2
    assert data["scanner_version"] == 2


def test_public_holdings_survive_restart_and_reduction_then_confirmed_exit(tmp_path):
    p = Provider()
    cache = tmp_path / "wallets.json"
    p.feed = WhalePositions(request=p.request, clock=lambda: p.clock, background=False,
                            discovery=list, cache_path=cache)
    p.scan()
    assert cache.exists()
    p.wallets = []
    p.positions[wallet(1)] = held(size="1", value="3900")
    p.positions[wallet(2)] = {"assetPositions": []}
    p.feed = WhalePositions(request=p.request, clock=lambda: p.clock, background=False,
                            discovery=list, cache_path=cache)
    data = p.scan()
    assert data["buy_count"] == 1 and data["sell_count"] == 0
    assert data["positions"][0]["value_usd"] == 3900
    p.positions[wallet(1)] = {"assetPositions": []}
    assert p.scan()["positions"] == []


def test_aliases_share_scan_cache_and_staleness_is_time_based():
    p = Provider()
    p.scan()
    p.calls.clear()
    data = p.feed.snapshot("GOLD")
    assert data["market"] == "GOLD" and data["buy_count"] == 1
    assert p.calls == []
    p.feed._states["xyz:GOLD"].scanning = True
    p.clock += 61
    assert all(row["stale"] for row in p.feed.snapshot("GOLD")["positions"])


def test_first_provider_failure_is_unavailable_not_a_healthy_empty_scan():
    feed = WhalePositions(request=Mock(side_effect=OSError("offline")), background=False)
    data = feed.snapshot("XAUUSDm")
    assert data["status"] == "unavailable" and data["positions"] == []


def test_background_scans_return_immediately_and_do_not_overlap():
    entered, release = threading.Event(), threading.Event()
    calls = []

    def blocked(body):
        calls.append(body)
        entered.set()
        release.wait(3)
        return {"universe": []}

    feed = WhalePositions(request=blocked)
    before = time.monotonic()
    data = feed.snapshot("XAUUSDm")
    assert time.monotonic() - before < 0.5
    assert data["scanning"]
    assert entered.wait(1)
    try:
        assert feed.snapshot("GOLD")["scanning"]
        assert len(calls) == 1
    finally:
        release.set()
