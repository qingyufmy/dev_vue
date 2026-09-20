using System;
using Liangjian.BridgeV4.Runtime;
namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class MarketStateSmokeTests
    {
        public static void RunAll()
        {
            long monday = 1789380000000;
            Assert("open", BridgeMarketState.Classify(4, monday - 1000, monday, true)["state"]);
            Assert("closed", BridgeMarketState.Classify(0, monday - 1000, monday, true)["state"]);
            Assert("restricted", BridgeMarketState.Classify(3, monday - 1000, monday, true)["state"]);
            Assert("stale", BridgeMarketState.Classify(4, monday - 120001, monday, true)["state"]);
            long sunday = monday - 86400000;
            Assert("closed", BridgeMarketState.Classify(4, sunday - 120001, sunday, true)["state"]);
            Assert("unknown", BridgeMarketState.Classify(4, null, monday, true)["state"]);
            Assert("unknown", BridgeMarketState.Classify(4, monday + 20000, monday, true)["state"]);
            Assert("unknown", BridgeMarketState.Classify(0, monday, monday, false)["state"]);
        }
        private static void Assert(string expected, object actual) { if (!Equals(expected, actual)) throw new Exception("market_state_expected_" + expected); }
    }
}
