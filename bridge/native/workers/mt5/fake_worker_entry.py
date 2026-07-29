from __future__ import annotations

import time
from collections import namedtuple
from types import SimpleNamespace

from worker import run

Account = namedtuple("Account", "login server balance equity margin_free trade_allowed trade_expert")
Terminal = namedtuple("Terminal", "connected trade_allowed tradeapi_disabled")
Position = namedtuple("Position", "ticket symbol type volume price_open sl tp magic comment")
Order = namedtuple("Order", "ticket symbol type volume_initial volume_current price_open sl tp magic comment")
Symbol = namedtuple("Symbol", "name trade_mode digits point trade_tick_size volume_min volume_max volume_step filling_mode")
Tick = namedtuple("Tick", "bid ask last time_msc")


class FakeMt5:
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_PENDING = 5
    TRADE_ACTION_SLTP = 6
    TRADE_ACTION_MODIFY = 7
    TRADE_ACTION_REMOVE = 8
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_TYPE_BUY_LIMIT = 2
    ORDER_TYPE_SELL_LIMIT = 3
    ORDER_TYPE_BUY_STOP = 4
    ORDER_TYPE_SELL_STOP = 5
    ORDER_TYPE_BUY_STOP_LIMIT = 6
    ORDER_TYPE_SELL_STOP_LIMIT = 7
    POSITION_TYPE_BUY = 0
    ORDER_TIME_GTC = 0
    ORDER_FILLING_FOK = 0
    ORDER_FILLING_IOC = 1
    ORDER_FILLING_RETURN = 2
    TRADE_RETCODE_PLACED = 10008
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_DONE_PARTIAL = 10010

    def __init__(self):
        self.positions = [Position(101, "XAUUSD.s", 0, 0.01, 2300.0, 2290.0, 2320.0,
                                   234000, "AURUM:command_01JRECOVER01")]
        self.orders = [Order(202, "XAUUSD.s", 2, 0.01, 0.01, 2280.0, 2270.0,
                             2310.0, 234000, "AI-PENDING")]

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
            True,
        )

    def terminal_info(self):
        return Terminal(True, True, False)

    def positions_get(self, **kwargs):
        ticket = kwargs.get("ticket")
        symbol = kwargs.get("symbol")
        return tuple(row for row in self.positions
                     if (ticket is None or row.ticket == ticket)
                     and (symbol is None or row.symbol == symbol))

    def orders_get(self, **kwargs):
        ticket = kwargs.get("ticket")
        symbol = kwargs.get("symbol")
        return tuple(row for row in self.orders
                     if (ticket is None or row.ticket == ticket)
                     and (symbol is None or row.symbol == symbol))

    def symbols_get(self):
        return (self.symbol_info("XAUUSD.s"),)

    def symbol_select(self, _symbol, _enabled):
        return True

    def symbol_info(self, _symbol):
        return Symbol("XAUUSD.s", 4, 2, 0.01, 0.01, 0.01, 100.0, 0.01, 2)

    def symbol_info_tick(self, _symbol):
        now = int(time.time() * 1000)
        return Tick(2300.0, 2300.2, 2300.1, now + 180 * 60_000)

    def order_check(self, _request):
        return SimpleNamespace(retcode=0, comment="ok")

    def order_send(self, request):
        import os
        from pathlib import Path
        count_file = os.environ.get("AURUM_TEST_WORKER_ORDER_SEND_COUNT_FILE")
        if count_file:
            path = Path(count_file)
            count = int(path.read_text(encoding="ascii")) if path.exists() else 0
            path.write_text(str(count + 1), encoding="ascii")
        return SimpleNamespace(retcode=10009, order=1001, deal=2001, comment="done")

    def history_orders_get(self, *_args, **_kwargs):
        return ()

    def history_deals_get(self, *_args, **_kwargs):
        return ()


run(FakeMt5())
