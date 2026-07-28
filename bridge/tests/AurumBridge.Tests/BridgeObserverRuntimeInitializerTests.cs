using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeObserverRuntimeInitializerTests
{
    [TestMethod]
    public async Task OneBrokenProfileDoesNotBlockTheRemainingProfiles()
    {
        var attempts = new List<string>();
        var failures = new List<(string ProfileId, Exception Error)>();

        await BridgeObserverRuntimeInitializer.InitializeIndependentlyAsync(
            ["source-a", "source-b", "source-c"],
            (profileId, _) =>
            {
                attempts.Add(profileId);
                return profileId == "source-a"
                    ? Task.FromException(new IOException("terminal_missing"))
                    : Task.CompletedTask;
            },
            (profileId, error) => failures.Add((profileId, error)),
            CancellationToken.None);

        CollectionAssert.AreEqual(
            new[] { "source-a", "source-b", "source-c" },
            attempts);
        Assert.HasCount(1, failures);
        Assert.AreEqual("source-a", failures[0].ProfileId);
        Assert.IsInstanceOfType<IOException>(failures[0].Error);
    }

    [TestMethod]
    public async Task CancellationStopsInitializationWithoutReportingProfileFailure()
    {
        using var stop = new CancellationTokenSource();
        var attempts = new List<string>();
        var failures = new List<string>();

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            BridgeObserverRuntimeInitializer.InitializeIndependentlyAsync(
                ["source-a", "source-b"],
                (profileId, token) =>
                {
                    attempts.Add(profileId);
                    stop.Cancel();
                    return Task.FromCanceled(token);
                },
                (profileId, _) => failures.Add(profileId),
                stop.Token));

        CollectionAssert.AreEqual(new[] { "source-a" }, attempts);
        Assert.IsEmpty(failures);
    }
}
