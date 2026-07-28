namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeProgramArgumentsTests
{
    [TestMethod]
    public void StartMinimizedArgumentIsRemovedBeforeReadyArgumentsAreParsed()
    {
        var readyFile = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "bridge-ready.json"));
        var parsed = AurumBridge.Program.ReadStartMinimizedArgument([
            "--start-minimized",
            "--ready-file",
            readyFile,
            "--expected-terminal",
            "mt4_0123456789abcdef01234567",
        ]);

        Assert.IsTrue(parsed.StartMinimized);
        var ready = AurumBridge.Program.ReadStartupReadyArguments(parsed.RuntimeArgs);
        Assert.AreEqual(readyFile, ready.ReadyFile);
        CollectionAssert.AreEqual(
            new[] { "mt4_0123456789abcdef01234567" },
            ready.ExpectedTerminalInstanceIds.ToArray());
    }

    [TestMethod]
    public void DuplicateStartMinimizedArgumentsAreRejected()
    {
        Assert.ThrowsExactly<ArgumentException>(() =>
            AurumBridge.Program.ReadStartMinimizedArgument([
                "--start-minimized",
                "--start-minimized",
            ]));
    }
}
