using AurumBridge.Runtime;
using AurumBridge.UI;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeUiTextTests
{
    [TestMethod]
    public void ObserverSourcesAreVisibleOnlyForAnAuthenticatedAdministratorDefaultProfile()
    {
        Assert.IsTrue(BridgeMainForm.CanShowObserverSources(
            isDefaultProfile:true,
            canManageObserverSources:true));
        Assert.IsFalse(BridgeMainForm.CanShowObserverSources(
            isDefaultProfile:true,
            canManageObserverSources:false));
        Assert.IsFalse(BridgeMainForm.CanShowObserverSources(
            isDefaultProfile:false,
            canManageObserverSources:true));
    }

    [TestMethod]
    public void OnlineStateUsesConciseOperationalCopy()
    {
        var text = BridgeUiText.ForStatus(new(
            BridgeApplicationPhase.Online,
            [],
            null));

        Assert.AreEqual("量见智桥运行中", text.Title);
        StringAssert.Contains(text.Description, "数据");
        StringAssert.Contains(text.Description, "指令");
    }

    [TestMethod]
    public void StartupErrorsUseTheProductBrand()
    {
        var description = BridgeUiText.DescribeError(new InvalidOperationException("failure"));

        StringAssert.Contains(description, BridgeBrand.ProductName);
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

    [TestMethod]
    public void TerminalFailureLimitExplainsThatOnlyThisTerminalNeedsRedetection()
    {
        var terminal = new BridgeTerminalStatus(
            "terminal_01", "mt5", "Broker-Demo", "12345678",
            TerminalRuntimeState.Stopped, "terminal_worker_failure_limit");

        Assert.AreEqual("已暂停，请重新检测", BridgeUiText.DescribeTerminalState(terminal));
        var description = BridgeUiText.DescribeCode(
            terminal.ErrorCode, "fallback");
        StringAssert.Contains(description, "该终端");
        StringAssert.Contains(description, "重新检测");
    }

    [TestMethod]
    public void DuplicateTerminalUseExplainsThatObserverProfilesNeedSeparateMt5Directories()
    {
        var description = BridgeUiText.DescribeCode(
            "mt5_terminal_already_in_use", "fallback");

        StringAssert.Contains(description, "另一个桥接档案");
        StringAssert.Contains(description, "独立");
        StringAssert.Contains(description, "MT5");
    }

    [TestMethod]
    public void MultipleMt5TerminalsRequireAConciseAccountSelection()
    {
        var text = BridgeUiText.ForStatus(new(
            BridgeApplicationPhase.TerminalSelectionRequired, [], null));

        StringAssert.Contains(text.Title, "MT5");
        StringAssert.Contains(text.Description, "多个");
        StringAssert.Contains(text.Description, "选择");
    }

    [TestMethod]
    public void RuntimeSummaryShowsServerSynchronizationAndVersion()
    {
        var status = new BridgeApplicationStatus(
            BridgeApplicationPhase.Online, [], null)
        {
            ServerConnected = true,
            LastDataSyncUtcMsc = 1_800_000_000_000,
            BridgeVersion = "3.2.1",
        };

        var summary = BridgeUiText.DescribeRuntimeSummary(status);

        StringAssert.Contains(summary, "服务器已连接");
        StringAssert.Contains(summary, "最近同步");
        StringAssert.Contains(summary, "3.2.1");
    }

    [TestMethod]
    public void FirstAuthorizationCopyExplainsTheManualOneTimeBrowserLogin()
    {
        var text = BridgeUiText.ForStatus(new(
            BridgeApplicationPhase.PairingRequired, [], null));

        StringAssert.Contains(text.Description, "浏览器");
        StringAssert.Contains(text.Description, "手动点击");
        StringAssert.Contains(text.Description, "长期保持登录");
    }

    [TestMethod]
    public void RefreshFailuresDistinguishRetryFromExplicitReauthorization()
    {
        var unavailable = BridgeUiText.DescribeCode("bridge_refresh_unavailable", "fallback");
        var revoked = BridgeUiText.DescribeCode("bridge_refresh_revoked", "fallback");
        var membership = BridgeUiText.DescribeCode("bridge_membership_required", "fallback");

        StringAssert.Contains(unavailable, "保留");
        StringAssert.Contains(unavailable, "自动重试");
        StringAssert.Contains(revoked, "重新连接");
        StringAssert.Contains(membership, "无需重新授权");
    }
}
