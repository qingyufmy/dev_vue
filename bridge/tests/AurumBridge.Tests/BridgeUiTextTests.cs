using AurumBridge.Runtime;
using AurumBridge.UI;
using AurumBridge.Update;
using System.Drawing;
using System.Text.Json;

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
        Assert.IsTrue(BridgeMainForm.CanShowSettings(
            isDefaultProfile:true,
            isAdministrator:true));
        Assert.IsFalse(BridgeMainForm.CanShowSettings(
            isDefaultProfile:true,
            isAdministrator:false));
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
    public void Mt4PipeRecoveryUsesAConciseNonFatalState()
    {
        var text = BridgeUiText.ForStatus(new(
            BridgeApplicationPhase.Degraded,
            [],
            "mt4_ea_reconnecting")
        {
            SelectedPlatform = BridgePlatform.Mt4,
        });

        Assert.AreEqual("正在恢复 MT4 连接", text.Title);
        StringAssert.Contains(text.Description, "自动重连");
        Assert.AreEqual(Color.FromArgb(0xD9, 0x77, 0x06), text.AccentColor);
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
    public void MultipleMt4TerminalsExplainTheOneTimeInstallationChoice()
    {
        var text = BridgeUiText.ForStatus(new(
            BridgeApplicationPhase.TerminalSelectionRequired, [], null)
        {
            SelectedPlatform = BridgePlatform.Mt4,
        });

        StringAssert.Contains(text.Title, "MT4");
        StringAssert.Contains(text.Description, "安装 EA");
        StringAssert.Contains(text.Description, "选择");
    }

    [TestMethod]
    public void InstalledMt4ExpertExplainsTheOnlyRemainingManualStep()
    {
        var description = BridgeUiText.DescribeCode("mt4_ea_attach_required", "fallback");

        StringAssert.Contains(description, "已安装");
        StringAssert.Contains(description, "任意图表");
        StringAssert.Contains(description, "一次");
    }

    [TestMethod]
    public void ManualMt4ExpertRepairExplainsEveryRequiredSwitchWithoutExtraPermissions()
    {
        var instructions = BridgeUiText.Mt4ExpertSetupInstructions;

        StringAssert.Contains(instructions, "导航器");
        StringAssert.Contains(instructions, "允许实时自动交易");
        StringAssert.Contains(instructions, "顶部“自动交易”");
        StringAssert.Contains(instructions, "无需开启 DLL");
        StringAssert.Contains(instructions, "WebRequest");
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
    public void Mt4ExpertSetupActionIsOnlyVisibleForMt4()
    {
        Assert.IsTrue(BridgeMainForm.CanShowMt4ExpertSetup(BridgePlatform.Mt4));
        Assert.IsFalse(BridgeMainForm.CanShowMt4ExpertSetup(BridgePlatform.Mt5));
        Assert.IsFalse(BridgeMainForm.CanShowMt4ExpertSetup(null));
    }

    [TestMethod]
    public void UpdateNoticeDistinguishesDownloadReadyAndManualRequestStates()
    {
        var downloading = new BridgeUpdateNoticeView(
            "3.1.0", false, BridgeUpdateNoticePhase.Downloading, false);
        var ready = downloading with { Phase = BridgeUpdateNoticePhase.Ready };
        var requested = ready with { ManualActivationRequested = true };
        var urgent = ready with { Urgent = true };
        var waiting = requested with { Phase = BridgeUpdateNoticePhase.Waiting };
        var activating = requested with { Phase = BridgeUpdateNoticePhase.Activating };
        var failed = requested with { Phase = BridgeUpdateNoticePhase.Failed };
        var rolledBack = requested with { Phase = BridgeUpdateNoticePhase.RolledBack };
        var healthy = requested with { Phase = BridgeUpdateNoticePhase.Healthy };

        var downloadingText = BridgeMainForm.DescribeUpdateNotice(downloading);
        var readyText = BridgeMainForm.DescribeUpdateNotice(ready);
        var requestedText = BridgeMainForm.DescribeUpdateNotice(requested);
        var urgentText = BridgeMainForm.DescribeUpdateNotice(urgent);
        var waitingText = BridgeMainForm.DescribeUpdateNotice(waiting);
        var activatingText = BridgeMainForm.DescribeUpdateNotice(activating);
        var failedText = BridgeMainForm.DescribeUpdateNotice(failed);
        var rolledBackText = BridgeMainForm.DescribeUpdateNotice(rolledBack);
        var healthyText = BridgeMainForm.DescribeUpdateNotice(healthy);

        StringAssert.Contains(downloadingText.Description, "不受影响");
        Assert.IsFalse(downloadingText.ButtonVisible);
        StringAssert.Contains(readyText.Description, "休市安全时段");
        Assert.AreEqual("重启更新", readyText.ButtonText);
        Assert.IsTrue(readyText.ButtonEnabled);
        Assert.AreEqual("已请求", requestedText.ButtonText);
        Assert.IsFalse(requestedText.ButtonEnabled);
        StringAssert.Contains(urgentText.Title, "紧急修复");
        Assert.AreEqual("等待安全窗口", waitingText.ButtonText);
        Assert.IsFalse(waitingText.ButtonEnabled);
        Assert.AreEqual("正在重启", activatingText.ButtonText);
        Assert.IsFalse(activatingText.ButtonEnabled);
        StringAssert.Contains(failedText.Description, "当前桥接和交易不受影响");
        Assert.IsFalse(failedText.ButtonVisible);
        Assert.AreEqual("重新尝试", rolledBackText.ButtonText);
        Assert.IsTrue(rolledBackText.ButtonEnabled);
        StringAssert.Contains(healthyText.Title, "已更新到版本");
        Assert.IsFalse(healthyText.ButtonVisible);
    }

    [TestMethod]
    public void Mt4ExpertUpdatePromptOnlyAppearsForAnOutdatedRunningEa()
    {
        var mt4 = new BridgeTerminalStatus(
            "mt4_test",
            BridgePlatform.Mt4,
            "Broker-Demo",
            "1001",
            TerminalRuntimeState.Running,
            null)
        {
            Mt4ExpertRestartRequired = true,
        };

        Assert.AreEqual(
            "EA 已更新，重启 MT4 后生效",
            BridgeMainForm.DescribeMt4ExpertUpdate(mt4));
        Assert.IsNull(BridgeMainForm.DescribeMt4ExpertUpdate(
            mt4 with { Platform = BridgePlatform.Mt5 }));
        Assert.IsNull(BridgeMainForm.DescribeMt4ExpertUpdate(
            mt4 with { Mt4ExpertRestartRequired = false }));
    }

    [TestMethod]
    public void UpdateActivationPolicyDelegatesAutomaticWindowEvidenceToTheServerLeaseGate()
    {
        var state = new BridgeUpdateState
        {
            State = BridgeUpdateStates.WaitingWindow,
            TargetVersion = "3.1.0",
            Priority = "normal",
            StagedAtUtcMsc = 1,
            UpdatedAtUtcMsc = 1,
        };

        Assert.IsTrue(BridgeApplicationContext.ShouldAttemptUpdateActivation(
            state,
            new DateTimeOffset(2026, 7, 28, 12, 0, 0, TimeSpan.FromHours(8))));
        Assert.IsTrue(BridgeApplicationContext.ShouldAttemptUpdateActivation(
            state,
            new DateTimeOffset(2026, 8, 1, 12, 0, 0, TimeSpan.FromHours(8))));
        Assert.IsTrue(BridgeApplicationContext.ShouldAttemptUpdateActivation(
            state with { ManualActivationRequested = true },
            new DateTimeOffset(2026, 7, 28, 12, 0, 0, TimeSpan.FromHours(8))));
        Assert.IsTrue(BridgeApplicationContext.ShouldAttemptUpdateActivation(
            state with { Priority = "urgent" },
            new DateTimeOffset(2026, 7, 28, 12, 0, 0, TimeSpan.FromHours(8))));
        Assert.IsFalse(BridgeApplicationContext.ShouldAttemptUpdateActivation(
            state with { State = BridgeUpdateStates.Downloading },
            new DateTimeOffset(2026, 8, 1, 12, 0, 0, TimeSpan.FromHours(8))));
    }

    [TestMethod]
    public void FinalUpdateStateBecomesAReconnectHelloReportOnlyAfterLauncherVerification()
    {
        var verifying = new BridgeUpdateState
        {
            State = BridgeUpdateStates.Verifying,
            TargetVersion = "3.1.0",
            ReleaseId = "bridge-3.1.0-report-test",
            Priority = "normal",
            StagedAtUtcMsc = 1_800_000_000_000,
            ActivationStartedAtUtcMsc = 1_800_000_010_000,
            MaintenanceLeaseId = "lease_report_test",
            MaintenanceLeaseExpiresAtUtcMsc = 1_800_000_090_000,
            UpdatedAtUtcMsc = 1_800_000_010_000,
        };

        Assert.IsNull(BridgeApplicationContext.CreateClientUpdateReport(verifying));

        var report = BridgeApplicationContext.CreateClientUpdateReport(verifying with
        {
            State = BridgeUpdateStates.Healthy,
            MaintenanceLeaseId = null,
            MaintenanceLeaseExpiresAtUtcMsc = null,
            UpdatedAtUtcMsc = 1_800_000_020_000,
        });

        Assert.IsNotNull(report);
        Assert.AreEqual("bridge-3.1.0-report-test", report.ReleaseId);
        Assert.AreEqual("3.1.0", report.TargetVersion);
        Assert.AreEqual(BridgeUpdateStates.Healthy, report.State);
        Assert.AreEqual(1_800_000_010_000, report.StartedAtUtcMsc);
        Assert.AreEqual(1_800_000_020_000, report.UpdatedAtUtcMsc);
    }

    [TestMethod]
    public void StartupReadinessRequiresTheServerAndEveryPreviouslyOnlineTerminal()
    {
        const string mainId = "mt5_0123456789abcdef01234567";
        const string observerId = "mt4_0123456789abcdef01234567";
        var status = new BridgeApplicationStatus(
            BridgeApplicationPhase.Online,
            [
                new(mainId, BridgePlatform.Mt5, "Broker", "1",
                    TerminalRuntimeState.Running, null),
                new(observerId, BridgePlatform.Mt4, "Broker", "2",
                    TerminalRuntimeState.Restarting, "worker_failed", "source-1"),
            ],
            null)
        {
            ServerConnected = true,
        };
        var expected = new HashSet<string>([mainId, observerId], StringComparer.Ordinal);

        Assert.IsFalse(BridgeApplicationContext.IsStartupReady(status, expected));
        Assert.IsFalse(BridgeApplicationContext.IsStartupReady(
            status with { ServerConnected = false },
            new HashSet<string>([mainId], StringComparer.Ordinal)));
        Assert.IsTrue(BridgeApplicationContext.IsStartupReady(
            status with
            {
                Terminals = status.Terminals.Select(terminal => terminal with
                {
                    RuntimeState = TerminalRuntimeState.Running,
                    ErrorCode = null,
                }).ToArray(),
            },
            expected));
    }

    [TestMethod]
    public void ObserverControlsChooseSafeActionsFromPersistentAndRuntimeState()
    {
        var configured = new BridgeObserverProfileView(
            "source-1", BridgePlatform.Mt5, true, true,
            "mt5_0123456789abcdef01234567");
        var running = new BridgeTerminalStatus(
            "mt5_0123456789abcdef01234567",
            BridgePlatform.Mt5,
            "Broker-Demo",
            "12345678",
            TerminalRuntimeState.Running,
            null,
            "source-1");

        Assert.AreEqual(
            BridgeObserverAction.Pause,
            BridgeMainForm.ResolveObserverPrimaryAction(
                configured with { BridgeUserId = 42 }, running));
        Assert.AreEqual(
            BridgeObserverAction.Retry,
            BridgeMainForm.ResolveObserverPrimaryAction(
                configured with { BridgeUserId = 42 }, null));
        Assert.AreEqual(
            BridgeObserverAction.Start,
            BridgeMainForm.ResolveObserverPrimaryAction(
                configured with { Enabled = false, BridgeUserId = 42 },
                null));
        Assert.IsNull(BridgeMainForm.ResolveObserverPrimaryAction(
            configured with { Configured = false, BridgeUserId = 42 },
            null));
        Assert.AreEqual(
            BridgeObserverAction.Bind,
            BridgeMainForm.ResolveObserverPrimaryAction(configured, null));
    }

    [TestMethod]
    public void StatusFingerprintsIgnoreSynchronizationTicksButTrackVisibleAccountChanges()
    {
        var terminal = new BridgeTerminalStatus(
            "mt5_0123456789abcdef01234567",
            BridgePlatform.Mt5,
            "Broker-Demo",
            "12345678",
            TerminalRuntimeState.Running,
            null);
        var first = new BridgeApplicationStatus(
            BridgeApplicationPhase.Online, [terminal], null)
        {
            ServerConnected = true,
            LastDataSyncUtcMsc = 1_000,
        };
        var laterSync = first with { LastDataSyncUtcMsc = 2_000 };
        var stopped = first with
        {
            Terminals = [terminal with { RuntimeState = TerminalRuntimeState.Stopped }],
        };

        Assert.AreEqual(
            BridgeStatusFingerprint.ForLog(first),
            BridgeStatusFingerprint.ForLog(laterSync));
        Assert.AreEqual(
            BridgeStatusFingerprint.ForAccounts(first, [], []),
            BridgeStatusFingerprint.ForAccounts(laterSync, [], []));
        Assert.AreNotEqual(
            BridgeStatusFingerprint.ForLog(first),
            BridgeStatusFingerprint.ForLog(stopped));
        Assert.AreNotEqual(
            BridgeStatusFingerprint.ForAccounts(first, [], []),
            BridgeStatusFingerprint.ForAccounts(stopped, [], []));
        var permissionChanged = first with
        {
            Terminals = [terminal with { TerminalTradingAllowed = false }],
        };
        Assert.AreNotEqual(
            BridgeStatusFingerprint.ForAccounts(first, [], []),
            BridgeStatusFingerprint.ForAccounts(permissionChanged, [], []));
        var expertRestartChanged = first with
        {
            Terminals = [terminal with { Mt4ExpertRestartRequired = true }],
        };
        Assert.AreNotEqual(
            BridgeStatusFingerprint.ForAccounts(first, [], []),
            BridgeStatusFingerprint.ForAccounts(expertRestartChanged, [], []));
    }

    [TestMethod]
    public void AccountCardsFlowHorizontallyAndCollapseToOneColumnWhenNarrow()
    {
        Assert.AreEqual(1, BridgeMainForm.ResolveAccountColumnCount(600));
        Assert.AreEqual(2, BridgeMainForm.ResolveAccountColumnCount(820));
        Assert.AreEqual(3, BridgeMainForm.ResolveAccountColumnCount(1_220));
    }

    [TestMethod]
    public void TradingPermissionCopyUsesPlatformSpecificSwitchNames()
    {
        var mt4 = new BridgeTerminalStatus(
            "mt4_terminal", BridgePlatform.Mt4, "Broker-Demo", "8950701",
            TerminalRuntimeState.Running, null)
        {
            TerminalTradingAllowed = true,
            ProgramTradingAllowed = true,
            AccountTradingAllowed = true,
            AccountExpertTradingAllowed = false,
        };
        var mt5 = mt4 with
        {
            Platform = BridgePlatform.Mt5,
            ProgramTradingAllowed = null,
            AccountExpertTradingAllowed = true,
        };

        var mt4Text = BridgeMainForm.DescribeTradingPermissions(mt4);
        StringAssert.Contains(mt4Text, "MT4 顶部“自动交易”：已开启");
        StringAssert.Contains(mt4Text, "EA“允许实时自动交易”：已开启");
        StringAssert.Contains(mt4Text, "账户 EA 权限：已关闭");
        StringAssert.Contains(mt4Text, "账户级权限已关闭");
        StringAssert.Contains(mt4Text, "重新检测");
        Assert.AreEqual(
            "交易权限异常",
            BridgeMainForm.DescribeTradingPermissionSummary(mt4));
        var mt5Text = BridgeMainForm.DescribeTradingPermissions(mt5);
        StringAssert.Contains(mt5Text, "MT5 工具栏“算法交易”：已开启");
        Assert.IsFalse(mt5Text.Contains("允许实时自动交易", StringComparison.Ordinal));
        StringAssert.Contains(mt5Text, "交易所需开关均已开启");
        Assert.AreEqual(
            "交易权限正常",
            BridgeMainForm.DescribeTradingPermissionSummary(mt5));
        Assert.AreEqual(
            "权限检测中",
            BridgeMainForm.DescribeTradingPermissionSummary(
                mt5 with { TerminalTradingAllowed = null }));
    }

    [TestMethod]
    public void TradingPermissionGuidanceDistinguishesLocalSwitchesFromAccountRestrictions()
    {
        var localSwitch = new BridgeTerminalStatus(
            "mt5_terminal", BridgePlatform.Mt5, "Broker-Demo", "596520",
            TerminalRuntimeState.Running, null)
        {
            TerminalTradingAllowed = false,
            AccountTradingAllowed = true,
            AccountExpertTradingAllowed = true,
        };
        var accountRestriction = localSwitch with
        {
            TerminalTradingAllowed = true,
            AccountExpertTradingAllowed = false,
        };

        StringAssert.Contains(
            BridgeMainForm.DescribeTradingPermissionAction(localSwitch),
            "MT5");
        StringAssert.Contains(
            BridgeMainForm.DescribeTradingPermissionAction(accountRestriction),
            "经纪商");
    }

    [TestMethod]
    public void TradingPermissionDetailColorsFollowSemanticState()
    {
        var enabled = BridgeMainForm.ResolveTradingPermissionDetailColor(true);
        var disabled = BridgeMainForm.ResolveTradingPermissionDetailColor(false);
        var detecting = BridgeMainForm.ResolveTradingPermissionDetailColor(null);

        Assert.IsTrue(enabled.G > enabled.R, "Enabled permissions should be green.");
        Assert.IsTrue(disabled.R > disabled.G, "Disabled permissions should be red.");
        Assert.IsTrue(
            detecting.R > detecting.B && detecting.G > detecting.B,
            "Unknown permissions should use an amber warning color.");
    }

    [TestMethod]
    public void AccountSnapshotsProjectIndependentTradingPermissionLayers()
    {
        var terminal = new BridgeTerminalStatus(
            "mt4_terminal", BridgePlatform.Mt4, "Broker-Demo", "8950701",
            TerminalRuntimeState.Running, null);
        using var document = JsonDocument.Parse(
            """{"trade_allowed":true,"trade_expert":false,"terminal_trade_allowed":true,"program_trade_allowed":true}""");

        var projected = BridgeApplicationController.ApplyTradingPermissions(
            terminal, document.RootElement);

        Assert.IsTrue(projected.TerminalTradingAllowed);
        Assert.IsTrue(projected.ProgramTradingAllowed);
        Assert.IsTrue(projected.AccountTradingAllowed);
        Assert.IsFalse(projected.AccountExpertTradingAllowed);
    }

    [TestMethod]
    public void LogViewerScrollsToTheStartOfTheNewestLine()
    {
        Assert.AreEqual(0, BridgeLogViewerForm.FindLastLineStart("single line"));
        Assert.AreEqual(6, BridgeLogViewerForm.FindLastLineStart("first\nnewest line"));
        Assert.AreEqual(7, BridgeLogViewerForm.FindLastLineStart("first\r\nnewest line"));
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

    [TestMethod]
    public void ServerEndpointAndProtocolFailuresHaveActionableChineseCopy()
    {
        var endpoint = BridgeUiText.DescribeCode(
            "bridge_server_endpoint_unavailable", "fallback");
        var protocol = BridgeUiText.DescribeCode(
            "bridge_server_protocol_error", "fallback");

        StringAssert.Contains(endpoint, "服务器地址");
        StringAssert.Contains(endpoint, "服务恢复");
        StringAssert.Contains(protocol, "响应格式");
        StringAssert.Contains(protocol, "自动重试");
    }
}
