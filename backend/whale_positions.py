"""Bounded, read-only tracking of public Hyperliquid wallet positions.

Recent fills and public holder lists discover wallets; only clearinghouse
snapshots establish holdings and exits. Coverage is partial, with wallet identities.
Network work runs outside the API request, and scans only run while requested.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from http.client import HTTPException
from pathlib import Path

ENDPOINT = "https://api.hyperliquid.xyz/info"
MIN_VALUE = 100_000
SCAN_SECONDS = 15
STALE_SECONDS = 60
MAX_TRACKED = 24
MAX_CHECKS = 24
MAX_NEW = 16
MAX_MARKETS = 16
WALLET = re.compile(r"^0x[0-9a-fA-F]{40}$")
CRYPTO = {"BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "BNB", "LTC", "AVAX", "LINK", "DOT",
          "BCH", "TRX", "SUI", "TON", "NEAR", "APT", "SHIB", "PEPE", "UNI", "AAVE", "ONDO"}
PROVIDER_ERRORS = (OSError, ValueError, TypeError, HTTPException)
logger = logging.getLogger(__name__)
DISCOVERY_URLS = (
    "https://api.hypurrscan.io/holdersWithLimit/USDC/100",
    "https://api.hypurrscan.io/holdersWithLimit/HYPE/100",
)


def _holder_wallets(data):
    """Token balances discover addresses; they never establish perp positions."""
    if not isinstance(data, dict):
        raise TypeError("Invalid wallet discovery response")
    holders = data.get("holders", data.get("addresses"))
    if not isinstance(holders, dict):
        raise TypeError("Invalid wallet discovery response")
    rows = []
    for wallet, balance in list(holders.items())[:1000]:
        if isinstance(wallet, str) and WALLET.fullmatch(wallet):
            try:
                value = _number(balance)
            except (TypeError, ValueError):
                continue
            if value > 0:
                rows.append((wallet.lower(), value))
    return [wallet for wallet, _ in sorted(rows, key=lambda row: -row[1])[:100]]


def _discovery_wallets():
    def read(url):
        with urllib.request.urlopen(url, timeout=6) as response:
            raw = response.read(1_000_001)
        if len(raw) > 1_000_000:
            raise ValueError("Oversized wallet discovery response")
        return _holder_wallets(json.loads(raw))

    groups = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(read, url) for url in DISCOVERY_URLS]
        for future in futures:
            try:
                groups.append(future.result())
            except PROVIDER_ERRORS:
                continue
    if not groups:
        raise OSError("Public wallet discovery unavailable")
    # Alternate both lists so collateral and HYPE holders get checked early.
    wallets = []
    for index in range(max(map(len, groups), default=0)):
        for group in groups:
            if index < len(group) and group[index] not in wallets:
                wallets.append(group[index])
    return {"wallets": wallets[:200], "partial": len(groups) != len(DISCOVERY_URLS)}


def contract_for(market: str):
    """Explicit dollar-market mapping; never guess an inverse/FX exposure."""
    key = str(market).strip().upper()
    key = key.removesuffix("M")
    if key in {"GOLD", "XAUUSD", "XAUUSD247"}:
        return "xyz:GOLD", "xyz", "Gold perpetual"
    if key in {"SILVER", "XAGUSD"}:
        return "xyz:SILVER", "xyz", "Silver perpetual"
    for base in CRYPTO:
        if key in {base, base + "USD", base + "USDT", base + "USDC"}:
            return base, "", base + " perpetual"
    return None


def _http_json(body):
    request = urllib.request.Request(
        ENDPOINT, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "SoftradeX/1.0"})
    with urllib.request.urlopen(request, timeout=4) as response:
        raw = response.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError("Oversized provider response")
    return json.loads(raw)


def _number(value):
    if isinstance(value, bool):
        raise TypeError("Invalid position number")
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("Invalid position number")
    return value


def _position(data, coin):
    """None is a confirmed exit only after validating the position snapshot."""
    if not isinstance(data, dict) or not isinstance(data.get("assetPositions"), list):
        raise TypeError("Invalid position snapshot")
    found = []
    for item in data["assetPositions"]:
        pos = item.get("position") if isinstance(item, dict) else None
        if not isinstance(pos, dict) or not isinstance(pos.get("coin"), str):
            raise TypeError("Invalid position snapshot")
        size = _number(pos.get("szi"))
        if pos["coin"] != coin:
            continue
        found.append(pos)
        if len(found) > 1:
            raise ValueError("Duplicate contract positions")
        if size == 0:
            continue
        entry, value = _number(pos.get("entryPx")), _number(pos.get("positionValue"))
        if entry <= 0 or value <= 0:
            raise ValueError("Invalid open position")
    if not found or _number(found[0]["szi"]) == 0:
        return None
    pos = found[0]
    size = _number(pos["szi"])
    return {"side": "BUY" if size > 0 else "SELL", "size": abs(size),
            "entry_price": _number(pos["entryPx"]), "value_usd": _number(pos["positionValue"])}


@dataclass
class MarketState:
    coin: str
    dex: str
    label: str
    rows: dict = field(default_factory=dict)
    checked: dict = field(default_factory=dict)
    last_request: float = 0
    completed: float = 0
    scanning: bool = False
    status: str = "scanning"
    message: str = "Discovering public wallets"
    discovery_at: float = 0
    metadata_at: float = 0
    wallets_checked: int = 0
    candidates_total: int = 0


class WhalePositions:
    def __init__(self, request=None, clock=None, background=True, discovery=None, cache_path=None):
        self._request = request or _http_json
        self._clock = clock or time.time
        self._background = background
        self._discovery = discovery or _discovery_wallets
        self._cache_path = Path(cache_path) if cache_path else None
        self._cache_lock = threading.Lock()
        self._lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(2)
        self._states = {}
        self._pool = []
        self._pool_at = 0
        self._pool_partial = False
        self._load_cache()

    def _load_cache(self):
        if not self._cache_path:
            return
        try:
            if self._cache_path.stat().st_size > 1_000_000:
                return
            data = json.loads(self._cache_path.read_text(encoding="utf-8"))
            for saved in data.get("markets", [])[:MAX_MARKETS]:
                mapping = contract_for(saved.get("market", ""))
                if not mapping:
                    continue
                state = MarketState(*mapping)
                for row in saved.get("positions", [])[:MAX_TRACKED]:
                    if row.get("contract") != state.coin or not WALLET.fullmatch(str(row.get("wallet", ""))):
                        continue
                    if row.get("side") not in {"BUY", "SELL"}:
                        continue
                    if not all(_number(row.get(key)) > 0 for key in
                               ("size", "entry_price", "value_usd", "verified_at", "first_seen_at")):
                        continue
                    state.rows[row["wallet"].lower()] = dict(row, failed=True)
                state.message = "Rechecking cached public holdings"
                self._states[state.coin] = state
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError, AttributeError):
            logger.warning("Public wallet cache unavailable; discovering afresh")

    def _save_cache(self):
        if not self._cache_path:
            return
        with self._cache_lock:
            with self._lock:
                data = {"markets": [{"market": state.coin.replace("xyz:GOLD", "GOLD").replace("xyz:SILVER", "SILVER"),
                                     "positions": list(state.rows.values())} for state in self._states.values()]}
            try:
                self._cache_path.parent.mkdir(parents=True, exist_ok=True)
                from .cache_io import write_json
                write_json(self._cache_path, data)
            except OSError:
                logger.warning("Could not save public wallet cache")

    def snapshot(self, market: str):
        mapping = contract_for(market)
        base = {"market": market, "provider": "Hyperliquid", "scanner_version": 2, "threshold_usd": MIN_VALUE,
                "scan_seconds": SCAN_SECONDS, "max_tracked": MAX_TRACKED,
                "coverage": "Recent fills and public Hypurrscan USDC/HYPE wallet lists; partial coverage",
                "discovery_sources": ["Hyperliquid recent trades", "Hypurrscan public holders"],
                "identity": "Public wallet address; company and order names are not disclosed"}
        if not mapping:
            return dict(base, status="unsupported", message="No public held-position coverage for this market",
                        contract="", contract_label="", positions=[], buy_count=0, sell_count=0,
                        scanning=False, updated_at=0, discovery_at=0)
        now = self._clock()
        with self._lock:
            state = self._states.get(mapping[0])
            if state is None:
                # Never evict an open position to make space or pretend it exited.
                if len(self._states) >= MAX_MARKETS:
                    idle = [s for s in self._states.values() if not s.rows and not s.scanning
                            and now - s.last_request > 60]
                    if idle:
                        self._states.pop(min(idle, key=lambda s: s.last_request).coin)
                    else:
                        return dict(base, status="unavailable", message="Scanner capacity reached; retry later",
                                    contract=mapping[0], contract_label=mapping[2], positions=[],
                                    buy_count=0, sell_count=0, scanning=False, updated_at=0, discovery_at=0)
                state = MarketState(*mapping)
                self._states[state.coin] = state
            state.last_request = now
            due = not state.scanning and (not state.completed or now - state.completed >= SCAN_SECONDS)
            if due and self._slots.acquire(blocking=False):
                state.scanning = True
            else:
                due = False
        if due:
            if self._background:
                try:
                    threading.Thread(target=self._run_scan, args=(state,), daemon=True,
                                     name="public-whale-scan").start()
                except RuntimeError:
                    with self._lock:
                        state.scanning = False
                        state.status, state.message = "unavailable", "Scanner could not start; retrying"
                    self._slots.release()
            else:
                self._run_scan(state)
        with self._lock:
            positions = [dict(row, stale=row.get("failed", False) or now - row["verified_at"] / 1000 > STALE_SECONDS)
                         for row in state.rows.values()]
            positions.sort(key=lambda row: (-row["value_usd"], row["wallet"]))
            return dict(base, status=state.status, message=state.message, contract=state.coin,
                        contract_label=state.label, positions=positions,
                        buy_count=sum(row["side"] == "BUY" for row in positions),
                        sell_count=sum(row["side"] == "SELL" for row in positions),
                        scanning=state.scanning, updated_at=int(state.completed * 1000),
                        wallets_checked=state.wallets_checked, candidates_total=state.candidates_total,
                        discovery_at=int(state.discovery_at * 1000))

    def _run_scan(self, state):
        try:
            self._scan(state)
        except PROVIDER_ERRORS:
            # A provider failure never constitutes a closed position.
            with self._lock:
                state.status, state.message = "unavailable", "Provider unavailable; keeping last verified positions"
                for row in state.rows.values():
                    row["failed"] = True
        except Exception:
            logger.exception("Public wallet scanner failed")
            with self._lock:
                state.status, state.message = "unavailable", "Scanner unavailable; keeping last verified positions"
                for row in state.rows.values():
                    row["failed"] = True
        finally:
            with self._lock:
                state.scanning = False
                state.completed = self._clock()
            self._slots.release()
            self._save_cache()

    def _scan(self, state):
        now = self._clock()
        if not state.metadata_at or now - state.metadata_at > 3600:
            body = {"type": "meta"}
            if state.dex:
                body["dex"] = state.dex
            meta = self._request(body)
            if not isinstance(meta, dict) or not isinstance(meta.get("universe"), list):
                raise ValueError("Invalid contract metadata")
            if not any(isinstance(row, dict) and row.get("name") == state.coin for row in meta["universe"]):
                with self._lock:
                    state.status, state.message = "unsupported", "Selected contract is not listed by the provider"
                    for row in state.rows.values():
                        row["failed"] = True
                return
            state.metadata_at = now
        discovery_failed = False
        pool_failed = False
        if not self._pool_at or now - self._pool_at >= 900:
            try:
                result = self._discovery()
                pool = result.get("wallets") if isinstance(result, dict) else result
                if not isinstance(pool, list):
                    raise TypeError("Invalid public wallet list")
                with self._lock:
                    self._pool = list(dict.fromkeys(wallet.lower() for wallet in pool
                                                   if isinstance(wallet, str) and WALLET.fullmatch(wallet)))[:200]
                    self._pool_at = now
                    self._pool_partial = isinstance(result, dict) and bool(result.get("partial"))
            except PROVIDER_ERRORS:
                pool_failed = True
        candidates = []
        try:
            trades = self._request({"type": "recentTrades", "coin": state.coin})
            if not isinstance(trades, list):
                raise TypeError("Invalid recent fills")
            seen = set()
            for trade in trades[:50]:
                if not isinstance(trade, dict) or trade.get("coin") != state.coin or not isinstance(trade.get("users"), list):
                    raise ValueError("Invalid recent fills")
                for wallet in trade["users"]:
                    if isinstance(wallet, str) and WALLET.fullmatch(wallet):
                        wallet = wallet.lower()
                        if wallet not in seen:
                            seen.add(wallet)
                            candidates.append(wallet)
            with self._lock:
                state.discovery_at = self._clock()
        except PROVIDER_ERRORS:
            discovery_failed = True
        with self._lock:
            tracked = sorted(state.rows, key=lambda wallet: state.checked.get(wallet, 0))
            broad = sorted((wallet for wallet in self._pool if wallet not in state.rows),
                           key=lambda wallet: state.checked.get(wallet, 0))
            recent = sorted((wallet for wallet in candidates if wallet not in state.rows),
                            key=lambda wallet: state.checked.get(wallet, 0))
            # Scan old holders alongside new traders, without starving either.
            new = list(dict.fromkeys(broad[:12] + recent[:4] + broad[12:] + recent[4:]))
            new = new[:min(MAX_NEW, MAX_TRACKED - len(tracked))]
            # Every tracked wallet gets checked even if absent from recent fills.
            wallets = tracked[:MAX_CHECKS - len(new)] + new
            state.wallets_checked = 0
            state.candidates_total = len(set(candidates) | set(self._pool) | set(tracked))
        failures = 0
        if wallets:
            with ThreadPoolExecutor(max_workers=4, thread_name_prefix="public-wallet") as pool:
                futures = [(wallet, pool.submit(self._read_wallet, wallet, state)) for wallet in wallets]
                for wallet, future in futures:
                    try:
                        position = future.result()
                    except PROVIDER_ERRORS:
                        failures += 1
                        with self._lock:
                            state.checked[wallet] = self._clock()
                            if wallet in state.rows:
                                state.rows[wallet]["failed"] = True
                        continue
                    at = self._clock()
                    with self._lock:
                        state.wallets_checked += 1
                        state.checked[wallet] = at
                        previous = state.rows.get(wallet)
                        if position is None:
                            state.rows.pop(wallet, None)
                        elif (previous and previous["side"] == position["side"]) or position["value_usd"] >= MIN_VALUE:
                            state.rows[wallet] = dict(position, wallet=wallet, contract=state.coin,
                                                     verified_at=int(at * 1000), failed=False,
                                                     first_seen_at=previous["first_seen_at"] if previous else int(at * 1000))
                        else:
                            # A side reversal confirms the prior side has exited.
                            state.rows.pop(wallet, None)
            # Bounded bookkeeping: closed and unqualified candidate wallets are
            # not an ever-growing historical ledger.
            with self._lock:
                keep = set(state.rows) | set(candidates) | set(self._pool)
                state.checked = {wallet: at for wallet, at in state.checked.items() if wallet in keep}
        with self._lock:
            if failures or discovery_failed or pool_failed or self._pool_partial:
                state.status = "partial" if state.rows or failures < len(wallets) else "unavailable"
                state.message = "Some checks failed; keeping last verified positions"
            else:
                state.status, state.message = "ok", "Auto scan active · tracked wallet positions"

    def _read_wallet(self, wallet, state):
        body = {"type": "clearinghouseState", "user": wallet}
        if state.dex:
            body["dex"] = state.dex
        return _position(self._request(body), state.coin)


feed = WhalePositions(cache_path=Path(__file__).resolve().parent.parent / "data" / "whale_positions.json")
