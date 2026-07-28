using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeUpdateDrainGroupTests
{
    [TestMethod]
    public async Task PausesEveryTargetAndResumesInReverseWhenActivationIsAbandoned()
    {
        var events = new List<string>();
        var first = new Target("main", events);
        var second = new Target("observer", events);

        using (await BridgeUpdateDrainGroup.AcquireAsync(
            [first, second], TimeSpan.FromSeconds(1)))
        {
            CollectionAssert.AreEqual(
                new[] { "pause:main", "pause:observer" },
                events);
        }

        CollectionAssert.AreEqual(
            new[] { "pause:main", "pause:observer", "resume:observer", "resume:main" },
            events);
    }

    [TestMethod]
    public async Task ResumesAlreadyPausedTargetsWhenAnyObserverFailsToDrain()
    {
        var events = new List<string>();
        var first = new Target("main", events);
        var failing = new Target("observer", events, fail:true);

        await Assert.ThrowsExactlyAsync<InvalidOperationException>(() =>
            BridgeUpdateDrainGroup.AcquireAsync(
                [first, failing], TimeSpan.FromSeconds(1)));

        CollectionAssert.AreEqual(
            new[] { "pause:main", "pause:observer", "resume:main" },
            events);
    }

    [TestMethod]
    public async Task CommittedDrainDoesNotReopenDispatchersDuringShutdown()
    {
        var events = new List<string>();
        var scope = await BridgeUpdateDrainGroup.AcquireAsync(
            [new Target("main", events)], TimeSpan.FromSeconds(1));

        scope.Commit();
        scope.Dispose();

        CollectionAssert.AreEqual(new[] { "pause:main" }, events);
    }

    private sealed class Target(
        string name,
        List<string> events,
        bool fail = false) : IBridgeUpdateDrainTarget
    {
        public Task PauseForUpdateAsync(
            TimeSpan timeout,
            CancellationToken cancellationToken = default)
        {
            events.Add($"pause:{name}");
            if (fail)
            {
                throw new InvalidOperationException("drain_failed");
            }
            return Task.CompletedTask;
        }

        public void ResumeAfterFailedUpdate() => events.Add($"resume:{name}");
    }
}
