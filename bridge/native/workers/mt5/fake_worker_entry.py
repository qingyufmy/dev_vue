from __future__ import annotations

import time
from collections import namedtuple

from worker import run

Account = namedtuple("Account", "login server balance equity margin_free trade_allowed")
Terminal = namedtuple("Terminal", "connected trade_allowed")
Position = namedtuple("Position", "ticket symbol type volume price_open sl tp magic")
Order = namedtuple("Order", "ticket symbol type volume_initial price_open sl tp magic")
Symbol = namedtuple("Symbol", "name trade_mode digits point")
Tick = namedtuple("Tick", "bid ask last time_msc")


class FakeMt5:
    def initialize(self, **_kwargs):
        return True

    def shutdown(self):
        return None

    def account_info(self):
        import os
        return Account(
            int(os.environ["AURUM_BRIDGE_WORKER_LOGIN"]),
            os.environ["AURUM_BRIDGE_WORKER_BROKER_SERVER"],
            10_000.0,
            10_025.0,
            9_500.0,
            True,
        )

    def terminal_info(self):
        return Terminal(True, True)

    def positions_get(self):
        return (Position(101, "XAUUSD.s", 0, 0.01, 2300.0, 2290.0, 2320.0, 234000),)

    def orders_get(self):
        return (Order(202, "XAUUSD.s", 2, 0.01, 2280.0, 2270.0, 2310.0, 234000),)

    def symbols_get(self):
        return (Symbol("XAUUSD.s", 4, 2, 0.01),)

    def symbol_select(self, _symbol, _enabled):
        return True

    def symbol_info(self, _symbol):
        return Symbol("XAUUSD.s", 4, 2, 0.01)

    def symbol_info_tick(self, _symbol):
        now = int(time.time() * 1000)
        return Tick(2300.0, 2300.2, 2300.1, now + 180 * 60_000)


run(FakeMt5())
