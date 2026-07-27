using System.Net;
using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeFailureLogThrottleTests
{
    [TestMethod]
    public void LogsFirstFailureSuppressesDuplicatesAndReportsTheSuppressedCount()
    {
        long now = 1_000;
        var throttle = new BridgeFailureLogThrottle(
            TimeSpan.FromSeconds(60),
            () => now);
        var error = new BridgeApiException(
            "bridge_server_endpoint_unavailable",
            HttpStatusCode.OK);

        var first = throttle.Observe("primary", error);
        var duplicate = throttle.Observe("primary", error);
        now += 60_000;
        var summary = throttle.Observe("primary", error);

        Assert.IsTrue(first.ShouldLog);
        Assert.AreEqual(0, first.SuppressedCount);
        Assert.IsFalse(duplicate.ShouldLog);
        Assert.AreEqual(1, duplicate.SuppressedCount);
        Assert.IsTrue(summary.ShouldLog);
        Assert.AreEqual(1, summary.SuppressedCount);
    }

    [TestMethod]
    public void RecoveryResetMakesTheNextFailureImmediatelyVisible()
    {
        var throttle = new BridgeFailureLogThrottle(
            TimeSpan.FromMinutes(1),
            () => 1_000);
        var error = new HttpRequestException("connection refused");

        Assert.IsTrue(throttle.Observe("observer:one", error).ShouldLog);
        Assert.IsFalse(throttle.Observe("observer:one", error).ShouldLog);
        throttle.Reset("observer:one");

        Assert.IsTrue(throttle.Observe("observer:one", error).ShouldLog);
    }

    [TestMethod]
    public void ProfilesAndStableErrorCodesAreThrottledIndependently()
    {
        var throttle = new BridgeFailureLogThrottle(
            TimeSpan.FromMinutes(1),
            () => 1_000);

        Assert.IsTrue(throttle.Observe(
            "observer:one",
            new BridgeApiException("bridge_server_unavailable", HttpStatusCode.ServiceUnavailable)).ShouldLog);
        Assert.IsTrue(throttle.Observe(
            "observer:two",
            new BridgeApiException("bridge_server_unavailable", HttpStatusCode.ServiceUnavailable)).ShouldLog);
        Assert.IsTrue(throttle.Observe(
            "observer:one",
            new BridgeApiException("bridge_server_protocol_error", HttpStatusCode.OK)).ShouldLog);
    }
}
