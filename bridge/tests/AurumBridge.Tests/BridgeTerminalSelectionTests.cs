using AurumBridge.Runtime;
using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeTerminalSelectionTests
{
    private static readonly BridgeTerminalCandidate First = new(
        "mt5_0123456789abcdef01234567", "mt5", "Broker-One", "1001");
    private static readonly BridgeTerminalCandidate Second = new(
        "mt5_89abcdef0123456701234567", "mt5", "Broker-Two", "1002");

    [TestMethod]
    public void ASingleMt5TerminalIsSelectedAutomatically()
    {
        Assert.AreEqual(
            First.TerminalInstanceId,
            BridgeApplicationController.ResolveMt5TerminalSelection([First], null));
    }

    [TestMethod]
    public void MultipleMt5TerminalsRequireAnExplicitValidSelection()
    {
        Assert.IsNull(BridgeApplicationController.ResolveMt5TerminalSelection(
            [First, Second], null));
        Assert.IsNull(BridgeApplicationController.ResolveMt5TerminalSelection(
            [First, Second], "mt5_stale"));
        Assert.AreEqual(
            Second.TerminalInstanceId,
            BridgeApplicationController.ResolveMt5TerminalSelection(
                [First, Second], Second.TerminalInstanceId));
    }

    [TestMethod]
    public void ObserverProfileUsesOnlyItsConfiguredMt5Installation()
    {
        var discovered = new Mt5Installation(
            Path.Combine(Path.GetTempPath(), "auto", "terminal64.exe"),
            "registry_hkcu",
            IsRunning:true);
        var configuredPath = Path.Combine(
            Path.GetTempPath(), "observer", "terminal64.exe");

        var result = BridgeApplicationController.ResolveMt5Installations(
            [discovered],
            configuredPath);

        Assert.HasCount(1, result);
        Assert.AreEqual(Path.GetFullPath(configuredPath), result[0].ExecutablePath);
        Assert.AreEqual("observer_profile", result[0].Source);
        Assert.IsFalse(result[0].IsRunning);
    }

    [TestMethod]
    public void DefaultProfileKeepsAutomaticMt5Discovery()
    {
        IReadOnlyList<Mt5Installation> discovered = [new(
            Path.Combine(Path.GetTempPath(), "auto", "terminal64.exe"),
            "registry_hkcu",
            IsRunning:true)];

        Assert.AreSame(
            discovered,
            BridgeApplicationController.ResolveMt5Installations(discovered, null));
    }

    [TestMethod]
    public void ObserverMt5InstallationsAreExcludedFromPrimarySelectionButKeptInTheHost()
    {
        var primary = new Mt5Installation(
            Path.Combine(Path.GetTempPath(), "primary", "terminal64.exe"),
            "registry",
            IsRunning:true);
        var observer = new Mt5Installation(
            Path.Combine(Path.GetTempPath(), "observer", "terminal64.exe"),
            "observer_profile:source-1",
            IsRunning:false);
        var observerIds = new HashSet<string>(StringComparer.Ordinal)
        {
            observer.TerminalInstanceId,
        };

        var primaryChoices = BridgeApplicationController.ResolvePrimaryMt5Installations(
            [primary, observer],
            configuredTerminalPath:null,
            observerIds,
            selectedTerminalId:null);
        var hostInstallations = BridgeApplicationController.MergeMt5Installations(
            primaryChoices,
            [observer, observer]);

        CollectionAssert.AreEqual(
            new[] { primary.TerminalInstanceId },
            primaryChoices.Select(value => value.TerminalInstanceId).ToArray());
        CollectionAssert.AreEqual(
            new[] { primary.TerminalInstanceId, observer.TerminalInstanceId },
            hostInstallations.Select(value => value.TerminalInstanceId).ToArray());
    }

    [TestMethod]
    public void ExplicitlySelectedObserverTerminalCanAlsoServeAsThePrimaryAccount()
    {
        var observer = new Mt5Installation(
            Path.Combine(Path.GetTempPath(), "shared", "terminal64.exe"),
            "observer_profile:source-1",
            IsRunning:false);

        var primaryChoices = BridgeApplicationController.ResolvePrimaryMt5Installations(
            [observer],
            configuredTerminalPath:null,
            new HashSet<string>(StringComparer.Ordinal) { observer.TerminalInstanceId },
            observer.TerminalInstanceId);

        Assert.HasCount(1, primaryChoices);
        Assert.AreEqual(observer.TerminalInstanceId, primaryChoices[0].TerminalInstanceId);
    }

    [TestMethod]
    public void Mt4ExpertRepairUsesTheOnlyInstallationOrTheExplicitSelection()
    {
        var first = new Mt4Installation(
            Path.Combine(Path.GetTempPath(), "mt4-one"),
            Path.Combine(Path.GetTempPath(), "broker-one"),
            "test",
            IsRunning:true);
        var second = new Mt4Installation(
            Path.Combine(Path.GetTempPath(), "mt4-two"),
            Path.Combine(Path.GetTempPath(), "broker-two"),
            "test",
            IsRunning:false);

        Assert.AreSame(
            first,
            BridgeApplicationController.ResolveMt4InstallationSelection([first], null));
        Assert.IsNull(BridgeApplicationController.ResolveMt4InstallationSelection(
            [first, second],
            null));
        Assert.AreSame(
            second,
            BridgeApplicationController.ResolveMt4InstallationSelection(
                [first, second],
            second.TerminalInstanceId));
    }

    [TestMethod]
    public void ObserverMt4InstallationsAreExcludedFromPrimarySelectionButKeptInTheHost()
    {
        var primary = new Mt4Installation(
            Path.Combine(Path.GetTempPath(), "mt4-primary"),
            Path.Combine(Path.GetTempPath(), "broker-primary"),
            "test",
            IsRunning:true);
        var observer = new Mt4Installation(
            Path.Combine(Path.GetTempPath(), "mt4-observer"),
            Path.Combine(Path.GetTempPath(), "broker-observer"),
            "observer_profile:source-1",
            IsRunning:true);
        var observerIds = new HashSet<string>(StringComparer.Ordinal)
        {
            observer.TerminalInstanceId,
        };

        var primaryChoices = BridgeApplicationController.ResolvePrimaryMt4Installations(
            [primary, observer],
            observerIds,
            selectedTerminalId:null);
        var hostInstallations = BridgeApplicationController.MergeMt4Installations(
            primaryChoices,
            [observer, observer]);

        CollectionAssert.AreEqual(
            new[] { primary.TerminalInstanceId },
            primaryChoices.Select(value => value.TerminalInstanceId).ToArray());
        CollectionAssert.AreEqual(
            new[] { primary.TerminalInstanceId, observer.TerminalInstanceId },
            hostInstallations.Select(value => value.TerminalInstanceId).ToArray());
    }
}
