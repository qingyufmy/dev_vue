using System.Collections.Concurrent;
using System.Diagnostics;
using AurumBridge.Runtime;
using AurumBridge.Update;
using AurumBridge.Workers;

namespace AurumBridge.UI;

public sealed class BridgeApplicationContext : ApplicationContext
{
    private readonly BridgeMainForm _form;
    private readonly NotifyIcon _notifyIcon;
    private readonly BridgeApplicationController _controller;
    private readonly BridgeFileLogger _logger;
    private readonly BridgeUserPreferencesStore _preferences;
    private readonly BridgeSingleInstanceGuard _singleInstance;
    private readonly BridgeUpdateCoordinator? _updateCoordinator;
    private readonly string? _startupReadyFile;
    private readonly string _profileId;
    private readonly string _rootDataDirectory;
    private readonly bool _backgroundMode;
    private readonly ConcurrentDictionary<string, BridgeTerminalStatus>
        _observerTerminalStatuses = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _stop = new();
    private readonly long _startedTimestamp = Stopwatch.GetTimestamp();
    private Task? _updateTask;
    private Task? _healthTask;
    private BridgeLogViewerForm? _logViewer;
    private int _startupReadyWritten;
    private int _latestPhase = (int)BridgeApplicationPhase.Starting;
    private int _latestTerminalCount;
    private int _canManageObserverSources;
    private bool _shuttingDown;

    public BridgeApplicationContext(
        BridgeSingleInstanceGuard singleInstance,
        string? startupReadyFile = null,
        string profileId = BridgeRuntimeProfile.DefaultId,
        bool backgroundMode = false)
    {
        _singleInstance = singleInstance ?? throw new ArgumentNullException(nameof(singleInstance));
        _startupReadyFile = startupReadyFile;
        _profileId = BridgeRuntimeProfile.Validate(profileId);
        _backgroundMode = backgroundMode;
        if (_backgroundMode && BridgeRuntimeProfile.IsDefault(_profileId))
        {
            throw new ArgumentException("bridge_background_profile_required", nameof(profileId));
        }
        var rootPaths = BridgeRuntimePathResolver.Resolve(AppContext.BaseDirectory);
        _rootDataDirectory = rootPaths.DataDirectory;
        var paths = BridgeRuntimePathResolver.Resolve(
            AppContext.BaseDirectory,
            profileId:_profileId);
        _logger = new(Path.Combine(paths.DataDirectory, "logs"));
        _preferences = new(Path.Combine(paths.DataDirectory, "preferences.json"));
        string? selectedPlatform = null;
        string? selectedMt5TerminalId = null;
        string? selectedMt5TerminalPath = null;
        string? selectedMt4TerminalId = null;
        IReadOnlyList<BridgeObserverTerminalConfiguration> observerTerminals = [];
        try
        {
            var preferences = _preferences.LoadAsync().GetAwaiter().GetResult();
            selectedPlatform = preferences.Platform;
            selectedMt5TerminalId = preferences.Mt5TerminalInstanceId;
            selectedMt5TerminalPath = preferences.Mt5TerminalPath;
            selectedMt4TerminalId = preferences.Mt4TerminalInstanceId;
        }
        catch (Exception error)
        {
            _logger.Error("preferences_load_failed", error);
        }
        if (BridgeRuntimeProfile.IsDefault(_profileId))
        {
            EnsureAutoStart();
            _updateCoordinator = CreateUpdateCoordinator(paths.ServerBaseUri);
            SignalObserverProfilesShutdown();
            try
            {
                observerTerminals = BridgeObserverTerminalCatalog.LoadAsync(
                    _rootDataDirectory).GetAwaiter().GetResult();
                _logger.Info(
                    "observer_terminal_catalog_loaded",
                    $"count={observerTerminals.Count}; mode=single_host");
            }
            catch (Exception error)
            {
                _logger.Error("observer_terminal_catalog_load_failed", error);
            }
        }
        _controller = new(
            paths,
            selectedPlatform,
            selectedMt5TerminalId,
            selectedMt5TerminalPath,
            selectedMt4TerminalId,
            observerTerminals);
        _form = new(_profileId);
        _form.PairRequested += HandlePairRequested;
        _form.ObserverSourcesRequested += HandleObserverSourcesRequested;
        _form.InstallMt4ExpertRequested += HandleInstallMt4ExpertRequested;
        _form.RedetectRequested += (_, _) => _controller.RequestRedetect();
        _form.OpenLogsRequested += HandleOpenLogsRequested;
        _form.LogoutRequested += HandleLogoutRequested;
        _form.PlatformChanged += HandlePlatformChanged;
        _form.TerminalChanged += HandleTerminalChanged;
        _form.ExitRequested += HandleExitRequested;
        _controller.StatusChanged += HandleStatusChanged;
        _controller.ConnectionFailureObserved += error =>
            _logger.Error("bridge_connection_failure", error);
        _singleInstance.ActivationRequested += HandleActivationRequested;
        _singleInstance.ShutdownRequested += HandleShutdownRequested;
        _singleInstance.StartActivationListener();

        var menu = new ContextMenuStrip();
        menu.Items.Add($"打开{BridgeBrand.ProductName}", null, (_, _) => _form.ShowFromTray());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出桥接", null, HandleExitRequested);
        _notifyIcon = new()
        {
            Icon = BridgeBrandIcon.ApplicationIcon,
            Text = BridgeBrand.ProductName,
            ContextMenuStrip = menu,
            Visible = !_backgroundMode,
        };
        _notifyIcon.DoubleClick += (_, _) => _form.ShowFromTray();
        if (_backgroundMode)
        {
            _ = _form.Handle;
        }
        else
        {
            _form.Show();
        }
        _logger.Info("bridge_started");
        _ = ObserveControllerAsync(RunControllerAsync(_stop.Token));
        _healthTask = ObserveHealthAsync(_stop.Token);
        if (_updateCoordinator is not null)
        {
            _updateTask = ObserveUpdatesAsync(_updateCoordinator, _stop.Token);
        }
    }

    private BridgeUpdateCoordinator? CreateUpdateCoordinator(Uri serverBaseUri)
    {
        try
        {
            return BridgeUpdateCoordinator.CreateIfInstalled(AppContext.BaseDirectory, serverBaseUri);
        }
        catch (Exception error)
        {
            _logger.Error("update_initialization_failed", error);
            return null;
        }
    }

    private async Task RunControllerAsync(CancellationToken cancellationToken)
    {
        if (BridgeRuntimeProfile.IsDefault(_profileId))
        {
            var profiles = BridgeRuntimeProfile.ListObserverProfiles(_rootDataDirectory);
            var releases = await Task.WhenAll(profiles.Select(profileId =>
                BridgeSingleInstanceGuard.WaitForReleaseAsync(
                    BridgeRuntimeProfile.InstanceId(profileId),
                    TimeSpan.FromSeconds(10),
                    cancellationToken:cancellationToken)));
            if (releases.Any(released => !released))
            {
                _logger.Info("legacy_observer_profile_stop_timeout");
            }
        }
        await _controller.RunAsync(cancellationToken);
    }

    private void EnsureAutoStart()
    {
        try
        {
            var registration = new BridgeAutoStartRegistration(new WindowsAutoStartValueStore());
            if (registration.EnsureForInstalledApplication(AppContext.BaseDirectory))
            {
                _logger.Info("autostart_registered");
            }
        }
        catch (Exception error)
        {
            _logger.Error("autostart_registration_failed", error);
        }
    }

    private void HandleActivationRequested()
    {
        if (_backgroundMode)
        {
            return;
        }
        TryBeginInvoke(() =>
        {
            if (!_shuttingDown)
            {
                _form.ShowFromTray();
            }
        });
    }

    private void HandleShutdownRequested()
    {
        if (_shuttingDown)
        {
            return;
        }
        TryBeginInvoke(() => _ = ShutdownAsync(stopObserverProfiles:false));
    }

    private void HandleStatusChanged(BridgeApplicationStatus status)
    {
        Volatile.Write(ref _latestPhase, (int)status.Phase);
        Volatile.Write(ref _latestTerminalCount, status.Terminals.Count);
        Volatile.Write(
            ref _canManageObserverSources,
            status.CanManageObserverSources ? 1 : 0);
        _observerTerminalStatuses.Clear();
        foreach (var terminal in status.Terminals.Where(terminal =>
            terminal.ObserverProfileId is not null))
        {
            _observerTerminalStatuses[terminal.ObserverProfileId!] = terminal;
        }
        _logger.Info(
            "bridge_status_changed",
            $"phase={status.Phase}; terminals={status.Terminals.Count}; detail={status.DetailCode ?? "none"}");
        if (status.Phase == BridgeApplicationPhase.Online
            && _startupReadyFile is not null
            && Interlocked.Exchange(ref _startupReadyWritten, 1) == 0)
        {
            _ = WriteStartupReadyAsync(_startupReadyFile);
        }
        TryBeginInvoke(() =>
        {
            if (_shuttingDown)
            {
                return;
            }
            _form.ApplyStatus(status);
            _notifyIcon.Text = status.Phase == BridgeApplicationPhase.Online
                ? $"{BridgeBrand.ProductName} · 运行中"
                : BridgeBrand.ProductName;
        });
    }

    private async void HandleObserverSourcesRequested(object? sender, EventArgs eventArgs)
    {
        if (Volatile.Read(ref _canManageObserverSources) != 1)
        {
            _logger.Info("observer_profiles_access_rejected");
            return;
        }
        try
        {
            var profiles = await LoadObserverProfileMenuItemsAsync(_stop.Token);
            _form.ShowObserverSourcesMenu(
                profiles,
                ConfigureObserverProfile,
                CreateObserverProfile);
        }
        catch (Exception error)
        {
            _logger.Error("observer_profiles_load_failed", error);
            MessageBox.Show(
                _form,
                "暂时无法读取观摩源，请稍后重试。",
                "观摩源",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private async void CreateObserverProfile()
    {
        using var dialog = new BridgeObserverProfileDialog();
        if (dialog.ShowDialog(_form) != DialogResult.OK)
        {
            return;
        }
        try
        {
            if (BridgeRuntimeProfile.ListObserverProfiles(_rootDataDirectory)
                .Contains(dialog.ProfileId, StringComparer.Ordinal))
            {
                MessageBox.Show(
                    _form,
                    "该观摩源名称已经存在，请更换名称，或从观摩源菜单直接打开已有档案。",
                    "观摩源已存在",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return;
            }
            await EnsureObserverTerminalAvailableAsync(
                dialog.ProfileId,
                dialog.TerminalInstanceId,
                _stop.Token);
            var profileDirectory = BridgeRuntimeProfile.CreateObserverProfile(
                _rootDataDirectory,
                dialog.ProfileId);
            await SaveObserverProfilePreferencesAsync(profileDirectory, dialog);
            _logger.Info("observer_profile_created", $"profile={dialog.ProfileId}");
            await ReloadObserverTerminalsAsync(_stop.Token);
            ShowMt4ObserverInstructionsIfNeeded(dialog.Platform);
        }
        catch (InvalidOperationException error) when (
            error.Message == "observer_terminal_already_assigned")
        {
            MessageBox.Show(
                _form,
                "该终端已被主账户或另一个观摩源使用，请选择独立终端。",
                "终端已被占用",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        catch (Exception error)
        {
            _logger.Error("observer_profile_create_failed", error);
            MessageBox.Show(
                _form,
                "观摩源无法创建或启动。名称请使用 1-40 位英文字母、数字、横线或下划线。",
                "新增观摩源",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private async void ConfigureObserverProfile(string profileId)
    {
        try
        {
            var profileDirectory = BridgeRuntimeProfile.CreateObserverProfile(
                _rootDataDirectory,
                profileId);
            var preferences = new BridgeUserPreferencesStore(
                Path.Combine(profileDirectory, "preferences.json"));
            var current = await preferences.LoadAsync(_stop.Token);
            using var dialog = new BridgeObserverProfileDialog(
                profileId,
                current.Platform,
                current.Mt5TerminalPath,
                current.Mt4TerminalPath);
            if (dialog.ShowDialog(_form) != DialogResult.OK)
            {
                return;
            }
            await SaveObserverProfilePreferencesAsync(profileDirectory, dialog);
            _logger.Info(
                "observer_profile_terminal_configured",
                $"profile={profileId}; platform={dialog.Platform}; terminal_id={dialog.TerminalInstanceId}");
            await ReloadObserverTerminalsAsync(_stop.Token);
            ShowMt4ObserverInstructionsIfNeeded(dialog.Platform);
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (InvalidOperationException error) when (
            error.Message == "observer_terminal_already_assigned")
        {
            MessageBox.Show(
                _form,
                "该终端已被主账户或另一个观摩源使用，请选择独立终端。",
                "终端已被占用",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        catch (Exception error)
        {
            _logger.Error("observer_profile_start_failed", error);
            MessageBox.Show(
                _form,
                "观摩源暂时无法启动，请稍后重试。",
                "观摩源",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private async Task<IReadOnlyList<BridgeObserverProfileMenuItem>>
        LoadObserverProfileMenuItemsAsync(CancellationToken cancellationToken)
    {
        var items = new List<BridgeObserverProfileMenuItem>();
        foreach (var profileId in BridgeRuntimeProfile.ListObserverProfiles(_rootDataDirectory))
        {
            var profileDirectory = BridgeRuntimeProfile.ResolveDataDirectory(
                _rootDataDirectory,
                profileId);
            var preferences = new BridgeUserPreferencesStore(
                Path.Combine(profileDirectory, "preferences.json"));
            var current = await preferences.LoadAsync(cancellationToken);
            var configured = current.Platform switch
            {
                BridgePlatform.Mt5 => !string.IsNullOrWhiteSpace(current.Mt5TerminalPath)
                    && File.Exists(current.Mt5TerminalPath),
                BridgePlatform.Mt4 => !string.IsNullOrWhiteSpace(current.Mt4TerminalPath)
                    && !string.IsNullOrWhiteSpace(current.Mt4TerminalInstanceId)
                    && Directory.Exists(Path.Combine(current.Mt4TerminalPath, "MQL4")),
                _ => false,
            };
            _observerTerminalStatuses.TryGetValue(profileId, out var terminalStatus);
            var state = !configured
                ? "需要设置"
                : terminalStatus?.RuntimeState == TerminalRuntimeState.Running
                    ? "运行中"
                    : terminalStatus?.RuntimeState is TerminalRuntimeState.Starting
                        or TerminalRuntimeState.Restarting
                        ? "连接中"
                        : "等待连接";
            var platform = current.Platform is BridgePlatform.Mt4 or BridgePlatform.Mt5
                ? $"{BridgePlatform.DisplayName(current.Platform)} · "
                : string.Empty;
            items.Add(new(
                profileId,
                platform + state));
        }
        return items;
    }

    private async Task ReloadObserverTerminalsAsync(
        CancellationToken cancellationToken)
    {
        var observerTerminals = await BridgeObserverTerminalCatalog.LoadAsync(
            _rootDataDirectory,
            cancellationToken);
        _controller.SetObserverTerminals(observerTerminals);
        _logger.Info(
            "observer_terminals_reloaded",
            $"count={observerTerminals.Count}; mode=single_host");
    }

    private async Task SaveObserverProfilePreferencesAsync(
        string profileDirectory,
        BridgeObserverProfileDialog dialog)
    {
        await EnsureObserverTerminalAvailableAsync(
            dialog.ProfileId,
            dialog.TerminalInstanceId,
            _stop.Token);
        var preferences = new BridgeUserPreferencesStore(
            Path.Combine(profileDirectory, "preferences.json"));
        await preferences.SavePlatformAsync(dialog.Platform, _stop.Token);
        if (dialog.Platform == BridgePlatform.Mt4)
        {
            var installation = dialog.Mt4Installation
                ?? throw new InvalidOperationException("observer_mt4_directory_not_selected");
            await preferences.SaveMt4TerminalAsync(
                installation.TerminalInstanceId,
                _stop.Token);
            await preferences.SaveMt4TerminalPathAsync(
                installation.TerminalDataPath,
                _stop.Token);
            return;
        }
        var terminalPath = dialog.Mt5ExecutablePath
            ?? throw new InvalidOperationException("observer_mt5_directory_not_selected");
        await preferences.SaveMt5TerminalAsync(dialog.TerminalInstanceId, _stop.Token);
        await preferences.SaveMt5TerminalPathAsync(terminalPath, _stop.Token);
    }

    private async Task EnsureObserverTerminalAvailableAsync(
        string profileId,
        string terminalInstanceId,
        CancellationToken cancellationToken)
    {
        var main = await _preferences.LoadAsync(cancellationToken);
        var mainTerminalId = main.Platform == BridgePlatform.Mt4
            ? main.Mt4TerminalInstanceId
            : main.Mt5TerminalInstanceId;
        if (mainTerminalId == terminalInstanceId)
        {
            throw new InvalidOperationException("observer_terminal_already_assigned");
        }
        foreach (var otherProfileId in BridgeRuntimeProfile.ListObserverProfiles(
            _rootDataDirectory).Where(value => value != profileId))
        {
            var directory = BridgeRuntimeProfile.ResolveDataDirectory(
                _rootDataDirectory,
                otherProfileId);
            var preferences = await new BridgeUserPreferencesStore(
                Path.Combine(directory, "preferences.json")).LoadAsync(cancellationToken);
            var otherTerminalId = preferences.Platform == BridgePlatform.Mt4
                ? preferences.Mt4TerminalInstanceId
                : preferences.Mt5TerminalInstanceId;
            if (otherTerminalId == terminalInstanceId)
            {
                throw new InvalidOperationException("observer_terminal_already_assigned");
            }
        }
    }

    private void ShowMt4ObserverInstructionsIfNeeded(string platform)
    {
        if (platform != BridgePlatform.Mt4)
        {
            return;
        }
        MessageBox.Show(
            _form,
            "EA 将自动安装到该 MT4。\n\n" + BridgeUiText.Mt4ExpertSetupInstructions,
            "完成 MT4 观摩源连接",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
    }

    private async Task WriteStartupReadyAsync(string path)
    {
        try
        {
            var version = typeof(BridgeApplicationContext).Assembly.GetName().Version?.ToString(3)
                ?? "3.0.0";
            await BridgeStartupSignal.WriteAsync(path, version, cancellationToken:_stop.Token);
            _logger.Info("startup_ready_confirmed", $"version={version}");
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("startup_ready_signal_failed", error);
        }
    }

    private async void HandlePairRequested(object? sender, EventArgs eventArgs)
    {
        _logger.Info("pairing_started");
        _form.SetPairingBusy(true);
        try
        {
            await _controller.PairAsync(prompt =>
            {
                _ = Process.Start(new ProcessStartInfo(prompt.VerificationUri.AbsoluteUri)
                {
                    UseShellExecute = true,
                }) ?? throw new InvalidOperationException("pairing_browser_start_failed");
                _form.SetPairingBrowserOpened();
                _logger.Info("pairing_browser_opened");
                return Task.CompletedTask;
            }, _stop.Token);
            _logger.Info("pairing_completed");
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("pairing_failed", error);
            MessageBox.Show(
                _form,
                BridgeUiText.DescribeError(error),
                "账号连接未完成",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        finally
        {
            if (!_form.IsDisposed)
            {
                _form.SetPairingBusy(false);
            }
        }
    }

    private async void HandleInstallMt4ExpertRequested(object? sender, EventArgs eventArgs)
    {
        _form.SetMt4ExpertBusy(true);
        try
        {
            var deployment = await _controller.InstallOrRepairMt4ExpertAsync(_stop.Token);
            _logger.Info(
                "mt4_ea_manual_deployment_completed",
                $"terminal_id={deployment.Installation.TerminalInstanceId}; status={deployment.Status}");
            var summary = deployment.Status == Mt4ExpertDeploymentStatus.Installed
                ? "EA 已安装到当前 MT4。"
                : "EA 已经是最新版本。";
            MessageBox.Show(
                _form,
                $"{summary}\n\n{BridgeUiText.Mt4ExpertSetupInstructions}",
                "安装 / 修复 MT4 EA",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("mt4_ea_manual_deployment_failed", error);
            var description = error is FileNotFoundException
                ? BridgeUiText.DescribeError(error)
                : BridgeUiText.DescribeCode(
                    error.Message,
                    "MT4 EA 暂时无法安装，请稍后重试。");
            MessageBox.Show(
                _form,
                description,
                "安装 / 修复 MT4 EA",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        finally
        {
            if (!_form.IsDisposed && !_form.Disposing)
            {
                _form.SetMt4ExpertBusy(false);
            }
        }
    }

    private void HandleOpenLogsRequested(object? sender, EventArgs eventArgs)
    {
        try
        {
            Directory.CreateDirectory(_logger.LogDirectory);
            if (_logViewer is null || _logViewer.IsDisposed)
            {
                _logViewer = new(_logger.LogDirectory);
                _logViewer.Show(_form);
            }
            else if (!_logViewer.Visible)
            {
                _logViewer.Show(_form);
            }
            else
            {
                _ = _logViewer.ReloadAsync();
            }
            _logViewer.BringToFront();
        }
        catch (Exception error)
        {
            _logger.Error("open_logs_failed", error);
            MessageBox.Show(
                _form,
                "暂时无法显示日志，请稍后重试。",
                "查看日志",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private async void HandlePlatformChanged(object? sender, BridgePlatformChangedEventArgs eventArgs)
    {
        try
        {
            await _preferences.SavePlatformAsync(eventArgs.Platform, _stop.Token);
            _controller.SelectPlatform(eventArgs.Platform);
            _logger.Info("bridge_platform_selected", $"platform={eventArgs.Platform}");
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("preferences_save_failed", error);
            MessageBox.Show(
                _form,
                "交易平台选择未能保存，请稍后重试。",
                "选择交易平台",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private async void HandleTerminalChanged(object? sender, BridgeTerminalChangedEventArgs eventArgs)
    {
        try
        {
            var platform = _controller.SelectedPlatform;
            if (platform == BridgePlatform.Mt4)
            {
                await _preferences.SaveMt4TerminalAsync(
                    eventArgs.TerminalInstanceId,
                    _stop.Token);
            }
            else
            {
                await _preferences.SaveMt5TerminalAsync(
                    eventArgs.TerminalInstanceId,
                    _stop.Token);
            }
            _controller.SelectTerminal(eventArgs.TerminalInstanceId);
            _logger.Info(
                "bridge_terminal_selected",
                $"terminal_id={eventArgs.TerminalInstanceId}");
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("terminal_preference_save_failed", error);
            var platformName = BridgePlatform.DisplayName(
                _controller.SelectedPlatform ?? BridgePlatform.Mt5);
            MessageBox.Show(
                _form,
                $"{platformName} 终端选择未能保存，请重新选择。",
                $"选择 {platformName} 终端",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private async void HandleLogoutRequested(object? sender, EventArgs eventArgs)
    {
        var answer = MessageBox.Show(
            _form,
            "确定退出当前 AURUM 账号？\n\n退出后桥接会停止服务器连接；MT 中已有订单不会被撤销或平仓。",
            "退出账号",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes)
        {
            return;
        }
        try
        {
            var revoked = await _controller.LogoutAsync(_stop.Token);
            SignalObserverProfilesShutdown();
            _logger.Info("bridge_account_logged_out", $"server_revoked={revoked}");
            MessageBox.Show(
                _form,
                revoked
                    ? "已退出账号。下次连接需要重新在浏览器中授权。"
                    : "本机已退出账号。服务器暂时无法确认撤销，但本机凭证已经清除。",
                "退出账号",
                MessageBoxButtons.OK,
                revoked ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("bridge_logout_failed", error);
            MessageBox.Show(
                _form,
                "暂时无法退出账号，请稍后重试。",
                "退出账号",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private async void HandleExitRequested(object? sender, EventArgs eventArgs)
    {
        if (_shuttingDown)
        {
            return;
        }
        var answer = MessageBox.Show(
            _form,
            $"确定退出{BridgeBrand.ProductName}？\n\n退出只会停止数据与指令转发，不会撤单、平仓或关闭 MT。",
            "退出桥接",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes)
        {
            return;
        }
        await ShutdownAsync(stopObserverProfiles:BridgeRuntimeProfile.IsDefault(_profileId));
    }

    private async Task ShutdownAsync(bool stopObserverProfiles)
    {
        if (_shuttingDown)
        {
            return;
        }
        _shuttingDown = true;
        _logger.Info("bridge_stopping");
        if (stopObserverProfiles)
        {
            SignalObserverProfilesShutdown();
        }
        _stop.Cancel();
        if (_updateTask is not null)
        {
            await IgnoreCancellationAsync(_updateTask);
        }
        if (_healthTask is not null)
        {
            await IgnoreCancellationAsync(_healthTask);
        }
        await _controller.DisposeAsync();
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _logViewer?.Close();
        _logViewer?.Dispose();
        _form.AllowClose();
        _form.Close();
        _form.Dispose();
        _stop.Dispose();
        _singleInstance.ActivationRequested -= HandleActivationRequested;
        _singleInstance.ShutdownRequested -= HandleShutdownRequested;
        _updateCoordinator?.Dispose();
        _logger.Dispose();
        ExitThread();
    }

    private void SignalObserverProfilesShutdown()
    {
        if (!BridgeRuntimeProfile.IsDefault(_profileId))
        {
            return;
        }
        foreach (var profileId in BridgeRuntimeProfile.ListObserverProfiles(_rootDataDirectory))
        {
            try
            {
                BridgeSingleInstanceGuard.RequestShutdown(
                    BridgeRuntimeProfile.InstanceId(profileId));
            }
            catch (Exception error)
            {
                _logger.Error(
                    "observer_profile_shutdown_signal_failed",
                    new InvalidOperationException($"profile={profileId}", error));
            }
        }
    }

    private async Task ObserveUpdatesAsync(
        BridgeUpdateCoordinator coordinator,
        CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(1), cancellationToken);
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    var staged = await coordinator.CheckAndStageAsync(cancellationToken);
                    if (staged is not null)
                    {
                        TryBeginInvoke(() => _ = ApplyStagedUpdateAsync(coordinator, staged));
                        return;
                    }
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception error)
                {
                    _logger.Error("update_check_failed", error);
                }
                await Task.Delay(TimeSpan.FromHours(6), cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private async Task ObserveHealthAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    var sample = BridgeRuntimeHealthSampler.Capture(
                        _startedTimestamp,
                        (BridgeApplicationPhase)Volatile.Read(ref _latestPhase),
                        Volatile.Read(ref _latestTerminalCount));
                    _logger.Info("bridge_health_sample", BridgeRuntimeHealthSampler.Format(sample));
                }
                catch (Exception error)
                {
                    _logger.Error("bridge_health_sample_failed", error);
                }
                await Task.Delay(TimeSpan.FromMinutes(1), cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private async Task ApplyStagedUpdateAsync(
        BridgeUpdateCoordinator coordinator,
        StagedRelease staged)
    {
        if (_shuttingDown)
        {
            return;
        }
        var admissionPaused = false;
        var activationPrepared = false;
        try
        {
            await _controller.PauseForUpdateAsync(TimeSpan.FromSeconds(30), _stop.Token);
            admissionPaused = true;
            await coordinator.PrepareActivationAsync(staged, _stop.Token);
            activationPrepared = true;
            _shuttingDown = true;
            _logger.Info("update_activation_prepared", $"version={staged.Version}");
            SignalObserverProfilesShutdown();
            _stop.Cancel();
            if (_healthTask is not null)
            {
                await IgnoreCancellationAsync(_healthTask);
            }
            await _controller.DisposeAsync();
            _singleInstance.ActivationRequested -= HandleActivationRequested;
            _singleInstance.ShutdownRequested -= HandleShutdownRequested;
            _singleInstance.Dispose();
            coordinator.StartLauncher();
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            _logViewer?.Close();
            _logViewer?.Dispose();
            _form.AllowClose();
            _form.Close();
            _form.Dispose();
            coordinator.Dispose();
            _logger.Dispose();
            ExitThread();
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("update_activation_failed", error);
            if (admissionPaused && !activationPrepared)
            {
                _controller.ResumeAfterFailedUpdate();
            }
            if (activationPrepared && !_form.IsDisposed)
            {
                MessageBox.Show(
                    _form,
                    $"更新已准备完成，但自动重启失败。请手动重新打开{BridgeBrand.ProductName}。",
                    "更新等待重启",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                _form.AllowClose();
                _form.Close();
                ExitThread();
            }
        }
    }

    private static async Task IgnoreCancellationAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (OperationCanceledException)
        {
        }
    }

    private async Task ObserveControllerAsync(Task runTask)
    {
        try
        {
            await runTask;
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("bridge_runtime_failed", error);
            if (_backgroundMode)
            {
                TryBeginInvoke(() => _ = ShutdownAsync(stopObserverProfiles:false));
                return;
            }
            TryBeginInvoke(() =>
            {
                if (_shuttingDown)
                {
                    return;
                }
                MessageBox.Show(
                    _form,
                    BridgeUiText.DescribeError(error),
                    "桥接运行异常",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            });
        }
    }

    private bool TryBeginInvoke(Action action)
    {
        ArgumentNullException.ThrowIfNull(action);
        if (_form.IsDisposed || _form.Disposing || !_form.IsHandleCreated)
        {
            return false;
        }
        try
        {
            _form.BeginInvoke(() =>
            {
                if (!_form.IsDisposed && !_form.Disposing)
                {
                    action();
                }
            });
            return true;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }
}
