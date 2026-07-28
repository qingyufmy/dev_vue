using AurumBridge.Installation;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeInstallationRegistrationTests
{
    [TestMethod]
    public void BuildsAnUninstallCommandOnlyForTheFixedPerUserInstallRoot()
    {
        var command = BridgeInstallationRegistration.BuildUninstallCommand(
            BridgeInstallationRegistration.DefaultInstallRoot);

        Assert.AreEqual(
            $"\"{Path.Combine(BridgeInstallationRegistration.DefaultInstallRoot, "AURUMBridge.Launcher.exe")}\" --uninstall",
            command);
        Assert.ThrowsExactly<InvalidOperationException>(() =>
            BridgeInstallationRegistration.BuildUninstallCommand(Path.GetTempPath()));
    }

    [TestMethod]
    public void KeepsInstallAndDataDeletionRootsSeparate()
    {
        Assert.IsFalse(string.Equals(
            BridgeInstallationRegistration.DefaultInstallRoot,
            BridgeInstallationRegistration.DefaultDataRoot,
            StringComparison.OrdinalIgnoreCase));
        Assert.IsTrue(BridgeInstallationRegistration.DefaultInstallRoot.EndsWith(
            Path.Combine("AURUM", "LiangjianBridge"),
            StringComparison.OrdinalIgnoreCase));
        Assert.IsTrue(BridgeInstallationRegistration.DefaultDataRoot.EndsWith(
            Path.Combine("AURUM", "BridgeV3"),
            StringComparison.OrdinalIgnoreCase));
    }
}
