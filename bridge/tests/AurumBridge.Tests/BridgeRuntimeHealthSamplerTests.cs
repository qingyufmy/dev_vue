using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeRuntimeHealthSamplerTests
{
    [TestMethod]
    public void FormatsAStableNonSensitiveHealthSample()
    {
        var sample = new BridgeRuntimeHealthSnapshot(
            3600,
            50_000_000,
            25_000_000,
            4_000_000,
            12_345,
            10,
            3,
            1,
            BridgeApplicationPhase.Online,
            2);

        var value = BridgeRuntimeHealthSampler.Format(sample);

        StringAssert.Contains(value, "uptime_seconds=3600");
        StringAssert.Contains(value, "working_set_bytes=50000000");
        StringAssert.Contains(value, "private_memory_bytes=25000000");
        StringAssert.Contains(value, "managed_heap_bytes=4000000");
        StringAssert.Contains(value, "gc_collections=10,3,1");
        StringAssert.Contains(value, "phase=Online");
        StringAssert.Contains(value, "terminals=2");
        Assert.DoesNotContain("login", value);
        Assert.DoesNotContain("token", value);
        Assert.DoesNotContain("account", value);
    }

    [TestMethod]
    public void CapturesCurrentProcessMetricsWithoutForcingGarbageCollection()
    {
        var started = System.Diagnostics.Stopwatch.GetTimestamp();

        var sample = BridgeRuntimeHealthSampler.Capture(
            started,
            BridgeApplicationPhase.Starting,
            0);

        Assert.IsGreaterThan(0, sample.WorkingSetBytes);
        Assert.IsGreaterThan(0, sample.PrivateMemoryBytes);
        Assert.IsGreaterThanOrEqualTo(0, sample.ManagedHeapBytes);
        Assert.AreEqual(BridgeApplicationPhase.Starting, sample.Phase);
        Assert.AreEqual(0, sample.TerminalCount);
    }
}
