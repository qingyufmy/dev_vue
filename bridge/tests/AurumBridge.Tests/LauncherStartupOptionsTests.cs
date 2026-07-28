using AurumBridge.Launcher;

namespace AurumBridge.Tests;

[TestClass]
public sealed class LauncherStartupOptionsTests
{
    [TestMethod]
    public void InteractiveLaunchStartsImmediatelyAndVisible()
    {
        var options = LauncherStartupOptions.Parse([]);

        Assert.IsFalse(options.StartMinimized);
        Assert.AreEqual(TimeSpan.Zero, options.Delay);
    }

    [TestMethod]
    public void WindowsAutoStartUsesAStartupDelayAndStartsMinimized()
    {
        var options = LauncherStartupOptions.Parse(["--autostart"]);

        Assert.IsTrue(options.StartMinimized);
        Assert.AreEqual(TimeSpan.FromSeconds(10), options.Delay);
    }

    [TestMethod]
    public void UnknownOrCombinedArgumentsAreRejected()
    {
        Assert.ThrowsExactly<ArgumentException>(() =>
            LauncherStartupOptions.Parse(["--unknown"]));
        Assert.ThrowsExactly<ArgumentException>(() =>
            LauncherStartupOptions.Parse(["--autostart", "--unknown"]));
    }
}
