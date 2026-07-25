using AurumBridge.Runtime;
using AurumBridge.UI;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeUiTextTests
{
    [TestMethod]
    public void OnlineStateUsesConciseOperationalCopy()
    {
        var text = BridgeUiText.ForStatus(new(
            BridgeApplicationPhase.Online,
            [],
            null));

        Assert.AreEqual("桥接运行中", text.Title);
        StringAssert.Contains(text.Description, "数据");
        StringAssert.Contains(text.Description, "指令");
    }

    [TestMethod]
    public void StopCopyExplicitlyPreservesExistingTrades()
    {
        var text = BridgeUiText.ForStatus(new(
            BridgeApplicationPhase.Stopped,
            [],
            null));

        StringAssert.Contains(text.Description, "不会撤单");
        StringAssert.Contains(text.Description, "平仓");
    }

    [TestMethod]
    public void IdentityMismatchCodesExplainTheAccountAndTerminalProblemInChinese()
    {
        var codes = new[]
        {
            "mt5_probe_identity_mismatch",
            "mt4_ea_identity_mismatch",
            "terminal_runtime_identity_mismatch",
        };

        foreach (var code in codes)
        {
            var text = BridgeUiText.DescribeCode(code, "fallback");
            Assert.AreNotEqual("fallback", text);
            StringAssert.Contains(text, "不匹配");
            StringAssert.Contains(text, "账号");
        }
    }

    [TestMethod]
    public void DetectionCopyUsesTheCustomerSelectedPlatform()
    {
        var mt4 = BridgeUiText.ForStatus(new(
            BridgeApplicationPhase.DetectingTerminal, [], null)
        {
            SelectedPlatform = BridgePlatform.Mt4,
        });
        var selection = BridgeUiText.ForStatus(new(
            BridgeApplicationPhase.PlatformSelectionRequired, [], null));

        StringAssert.Contains(mt4.Title, "MT4");
        StringAssert.Contains(selection.Title, "选择");
        StringAssert.Contains(selection.Description, "MT5");
        StringAssert.Contains(selection.Description, "MT4");
    }
}
