"""C4 fix: a failed MT5 exposure read must never be treated as "flat".

Applied once; every replacement asserts that its anchor was found exactly once.
"""
import io

READ_FAIL_FLAG = "    # True when the last MT5 exposure read failed. \"Unknown\" must never be\n" \
                 "    # mistaken for \"flat\", or the tick arms a second straddle on top of the first.\n" \
                 "    _exposure_unknown = False\n\n"

GUARD = (
    "        # A failed MT5 read is unknown, not flat: arming on top of an existing\n"
    "        # straddle would rest a second BuyStop/SellStop pair (both legs can then\n"
    "        # fill and be closed at the spread loss). Skip this cycle instead.\n"
    "        if self._exposure_unknown:\n"
    "            self._exposure_unknown = False\n"
    "            self._log(\"warn\", \"MT5 exposure read failed - tick skipped\")\n"
    "            return\n"
)

FILES = {
    "bot.py": [
        ("        positions = self._all_positions()\n        orders = self._all_orders()\n\n"
         "        # safety: never run Buy and Sell at the same time.",
         "        positions = self._all_positions()\n        orders = self._all_orders()\n"
         + GUARD + "\n        # safety: never run Buy and Sell at the same time."),
    ],
    "trend_bot.py": [
        ("        positions = self._all_positions()\n\n        # 1) Manage open positions",
         "        positions = self._all_positions()\n" + GUARD + "\n        # 1) Manage open positions"),
    ],
    "entry_bot.py": [
        ("        positions = self._all_positions()\n        orders = self._all_orders()\n\n"
         "        self._track(positions)",
         "        positions = self._all_positions()\n        orders = self._all_orders()\n"
         + GUARD + "\n        self._track(positions)"),
    ],
    "reversal_bot.py": [
        ("        positions = self._all_positions()\n        self._track(positions)",
         "        positions = self._all_positions()\n" + GUARD + "\n        self._track(positions)"),
    ],
    "pretrade_bot.py": [
        ("        positions = self._all_positions()\n        orders = self._all_orders()\n\n"
         "        # 1) stats: opened / externally closed positions",
         "        positions = self._all_positions()\n        orders = self._all_orders()\n"
         + GUARD + "\n        # 1) stats: opened / externally closed positions"),
    ],
    "extreme_bot.py": [
        ("        positions = self._all_positions()\n\n        # Check new positions for tracking",
         "        positions = self._all_positions()\n" + GUARD + "\n        # Check new positions for tracking"),
    ],
}

import os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

for fname, tick_patches in FILES.items():
    path = "backend/" + fname
    raw = io.open(path, encoding="utf-8", newline="").read()
    crlf = "\r\n" in raw
    s = raw.replace("\r\n", "\n")
    assert "_exposure_unknown" not in s, fname + " already patched"

    # 1) remember the read failure inside the two exposure helpers
    n = 0
    for call, fallback in (
        ("mt5.positions_get()", "return []"),
        ("mt5.orders_get()", "return []"),
        ("mt5.positions_get(symbol=None if any_symbol else self.symbol) or []", "raw = []"),
        ("mt5.orders_get(symbol=None if any_symbol else self.symbol) or []", "raw = []"),
    ):
        anchor = "            raw = %s\n        except Exception:\n            %s\n" % (call, fallback)
        repl = ("            raw = %s\n        except Exception:\n"
                "            self._exposure_unknown = True\n            %s\n" % (call, fallback))
        if anchor in s:
            n += s.count(anchor)
            s = s.replace(anchor, repl)
    assert n >= 1, fname + ": no exposure read handler found"

    # 2) class-level default
    anchor = "    def _all_positions("
    assert s.count(anchor) == 1, fname + ": _all_positions anchor"
    s = s.replace(anchor, READ_FAIL_FLAG + anchor)

    # 3) bail out of tick() while the exposure is unknown
    for old, new in tick_patches:
        assert s.count(old) == 1, fname + ": tick anchor -> " + repr(old[:60])
        s = s.replace(old, new)

    out = s.replace("\n", "\r\n") if crlf else s
    io.open(path, "w", encoding="utf-8", newline="").write(out)
    print("patched", fname, "| read handlers:", n, "| crlf:", crlf)
