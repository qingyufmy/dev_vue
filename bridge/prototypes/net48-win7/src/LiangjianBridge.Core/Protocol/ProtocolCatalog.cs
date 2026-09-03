using System;
using System.Collections.Generic;

namespace Liangjian.BridgeV4.Protocol
{
    public static class ProtocolCatalog
    {
        private static readonly HashSet<string> QueryResources = new HashSet<string>(StringComparer.Ordinal)
        {
            "terminal.info", "terminal.clock", "account.snapshot", "market.symbols", "market.instrument",
            "market.quote", "market.candles", "trading.positions", "trading.pending_orders",
            "history.orders", "history.trades", "history.deals", "execution.lookup", "diagnostics.health"
        };

        private static readonly HashSet<string> CommandActions = new HashSet<string>(StringComparer.Ordinal)
        {
            "order.place", "position.protection.set", "position.close", "pending_order.modify",
            "pending_order.cancel", "execution.lookup"
        };

        private static readonly HashSet<string> StreamResources = new HashSet<string>(StringComparer.Ordinal)
        {
            "account", "positions", "pending_orders", "quotes", "current_candle", "terminal.status", "terminal.clock"
        };

        public static bool IsQueryResource(string value)
        {
            return value != null && QueryResources.Contains(value);
        }

        public static bool IsCommandAction(string value)
        {
            return value != null && CommandActions.Contains(value);
        }

        public static bool IsStreamResource(string value)
        {
            return value != null && StreamResources.Contains(value);
        }
    }
}
