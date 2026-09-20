using System;
using System.Collections.Generic;
using System.IO;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Storage;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class ProjectionSourceSmokeTests
    {
        public static void TestCursorAndWindowAreBounded()
        {
            var dense = new ProjectionSourceCursor { WindowStartUtcMsc = 1000, WindowEndUtcMsc = 9000, NativeTimeUtcMsc = 1000, NativeTicket = "0" };
            Assert(ProjectionSourceSupport.ShrinkFreshHistoryWindow(dense) && dense.WindowEndUtcMsc == 5000, "dense_window_not_split");
            dense.NativeTicket = "9";
            Assert(!ProjectionSourceSupport.ShrinkFreshHistoryWindow(dense) && dense.WindowEndUtcMsc == 5000, "dense_cursor_group_skipped");
            dense.NativeTicket = "0"; dense.WindowEndUtcMsc = 2000;
            Assert(!ProjectionSourceSupport.ShrinkFreshHistoryWindow(dense), "dense_window_unbounded_split");
            ProjectionSyncRequest request = Request("mt5", "history.deals", "*",
                1000, 1000 + (35L * 24L * 60L * 60L * 1000L));
            ProjectionSourceCursor first = ProjectionSourceSupport.ResolveWindow(
                request, ProjectionSourceSupport.HistoryWindowMsc);
            Assert(first.WindowEndUtcMsc - first.WindowStartUtcMsc
                == ProjectionSourceSupport.HistoryWindowMsc, "history_window_not_bounded");
            first.NativeTimeUtcMsc = 2000;
            first.NativeTicket = "18446744073709551615";
            first.NativeOffset = 7;
            ProjectionSourceCursor decoded = ProjectionSourceSupport.DecodeCursor(
                ProjectionSourceSupport.EncodeCursor(first));
            Assert(decoded.NativeTicket == "18446744073709551615"
                && decoded.NativeTimeUtcMsc == 2000 && decoded.NativeOffset == 7,
                "projection_cursor_round_trip_failed");
            AssertThrows<InvalidDataException>(delegate
            {
                ProjectionSourceSupport.DecodeCursor("not-a-cursor");
            }, "invalid_projection_cursor_accepted");
        }

        public static void TestClosedCandleMapping()
        {
            long observed = 1000000;
            IDictionary<string, object> root = new Dictionary<string, object>
            {
                { "symbol", "XAUUSD" },
                { "timeframe", "M5" },
                { "items", new object[]
                    {
                        Candle(600000, 10, null)
                    }
                }
            };
            IList<CandleRecord> mapped = ProjectionSourceSupport.MapCandles(
                root, "XAUUSD", "M5", 500000, 1200000, observed, "revision-a");
            Assert(mapped.Count == 1 && mapped[0].OpenTimeUtcMsc == 600000
                && mapped[0].TickVolume == 10 && mapped[0].RealVolume == 0
                && mapped[0].Closed, "closed_candle_not_mapped");
            root["items"] = new object[] { Candle(900000, 11, 4) };
            AssertThrows<InvalidDataException>(delegate
            {
                ProjectionSourceSupport.MapCandles(
                    root, "XAUUSD", "M5", 500000, 1200000, observed, "revision-a");
            }, "open_candle_was_published_as_complete");
        }

        public static void TestHistoryIdentityAndFundsMapping()
        {
            object[] deals =
            {
                new Dictionary<string, object>
                {
                    { "ticket", 1001 }, { "order_ticket", 1001 },
                    { "position_ticket", null }, { "symbol", "" },
                    { "type", "balance" }, { "profit", "-50.25" },
                    { "commission", "0" }, { "swap", "0" },
                    { "time_utc_msc", 2000 }
                },
                new Dictionary<string, object>
                {
                    { "deal_ticket", "18446744073709551615" }, { "ticket", "18446744073709551615" },
                    { "order", 2002 }, { "position_id", 3003 }, { "symbol", "XAUUSD" },
                    { "type", 3 }, { "profit", 12.5 }, { "commission", 0 },
                    { "swap", 0 }, { "fee", 0 }, { "time_utc_msc", 3000 }
                }
            };
            IList<HistoryItemRecord> mapped = ProjectionSourceSupport.MapHistory(
                deals, "deals", 1000, 4000, 5000, "revision-b");
            Assert(mapped.Count == 2 && mapped[0].FundsKind == "withdrawal"
                && mapped[0].Amount == -50.25m, "withdrawal_sign_not_preserved");
            Assert(mapped[1].ItemId == "18446744073709551615"
                && mapped[1].OrderId == "2002" && mapped[1].PositionId == "3003"
                && mapped[1].FundsKind == "credit" && mapped[1].Amount == 12.5m,
                "mt5_history_identity_or_credit_wrong");

            IList<HistoryItemRecord> trades = ProjectionSourceSupport.MapHistory(
                new object[]
                {
                    new Dictionary<string, object>
                    {
                        { "ticket", 7001 }, { "close_deal_ticket", 7002 },
                        { "order", 7001 }, { "position_id", 7003 },
                        { "symbol", "EURUSD" }, { "close_time_utc_msc", 3500 }
                    }
                },
                "trades", 1000, 4000, 5000, "revision-c");
            Assert(trades.Count == 1 && trades[0].ItemId == "7002"
                && trades[0].Ticket == "7001", "trade_close_identity_wrong");
        }

        private static ProjectionSyncRequest Request(
            string platform, string resource, string scope, long start, long end)
        {
            return new ProjectionSyncRequest
            {
                ProfileId = "profile-a",
                TerminalInstanceId = "terminal-a",
                Platform = platform,
                BrokerServer = "Demo",
                Login = "10001",
                ConnectionEpoch = 1,
                Resource = resource,
                ScopeKey = scope,
                RangeStartUtcMsc = start,
                RangeEndUtcMsc = end,
                Limit = 500
            };
        }

        private static IDictionary<string, object> Candle(long time, long tickVolume, object realVolume)
        {
            return new Dictionary<string, object>
            {
                { "time_utc_msc", time }, { "open", 10.0 }, { "high", 12.0 },
                { "low", 9.0 }, { "close", 11.0 }, { "tick_volume", tickVolume },
                { "real_volume", realVolume }, { "spread", 2.0 }
            };
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition)
            {
                throw new InvalidOperationException(message);
            }
        }

        private static void AssertThrows<T>(Action action, string message) where T : Exception
        {
            try
            {
                action();
            }
            catch (T)
            {
                return;
            }
            throw new InvalidOperationException(message);
        }
    }
}
