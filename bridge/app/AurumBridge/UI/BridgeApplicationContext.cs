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
        string profileId = BridgeRuntimeProfile.DefaultId)
    {
        _singleInstance = singleInstance ?? throw new ArgumentNullException(nameof(singleInstance));
        _startupReadyFile = startupReadyFile;
        _profileId = BridgeRuntimeProfile.Validate(profileId);
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
        }
        _controller = new(
            paths,
            selectedPlatform,
            selectedMt5TerminalId,
            selectedMt5TerminalPath,
            selectedMt4TerminalId);
        _form = new(_profileId);
        _form.PairRequested += HandlePairRequested;
        _form.ObserverSourcesRequested += HandleObserverSourcesRequested;
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
            Visible = true,
        };
        _notifyIcon.DoubleClick += (_, _) => _form.ShowFromTray();
        _form.Show();
        _logger.Info("bridge_started");
        _ = ObserveControllerAsync(_controller.RunAsync(_stop.Token));
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
        if (_form.IsDisposed)
        {
            return;
        }
        _form.BeginInvoke(_form.ShowFromTray);
    }

    private void HandleShutdownRequested()
    {
        if (_form.IsDisposed || _shuttingDown)
        {
            return;
        }
        _form.BeginInvoke(() => _ = ShutdownAsync(stopObserverProfiles:false));
    }

    private void HandleStatusChanged(BridgeApplicationStatus status)
    {
        Volatile.Write(ref _latestPhase, (int)status.Phase);
        Volatile.Write(ref _latestTerminalCount, status.Terminals.Count);
        Volatile.Write(
            ref _canManageObserverSources,
            status.CanManageObserverSources ? 1 : 0);
        _logger.Info(
            "bridge_status_changed",
            $"phase={status.Phase}; terminals={status.Terminals.Count}; detail={status.DetailCode ?? "none"}");
        if (status.Phase == BridgeApplicationPhase.Online
            && _startupReadyFile is not null
            && Interlocked.Exchange(ref _startupReadyWritten, 1) == 0)
        {
            _ = WriteStartupReadyAsync(_startupReadyFile);
        }
        if (_form.IsDisposed)
        {
            return;
        }
        _form.BeginInvoke(() =>
        {
            _form.ApplyStatus(status);
            _notifyIcon.Text = status.Phase == BridgeApplicationPhase.Online
                ? $"{BridgeBrand.ProductName} · 运行中"
                : BridgeBrand.ProductName;
        });
    }

    private void HandleObserverSourcesRequested(object? sender, EventArgs eventArgs)
    {
        if (Volatile.Read(ref _canManageObserverSources) != 1)
        {
            _logger.Info("observer_profiles_access_rejected");
            return;
        }
        try
        {
            var profiles = BridgeRuntimeProfile.ListObserverProfiles(_rootDataDirectory);
            _form.ShowObserverSourcesMenu(
                profiles,
                LaunchObserverProfile,
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
            var profileDirectory = BridgeRuntimeProfile.CreateObserverProfile(
                _rootDataDirectory,
                dialog.ProfileId);
            await SaveObserverProfilePreferencesAsync(
                profileDirectory,
                dialog.Mt5ExecutablePath);
            _logger.Info("observer_profile_created", $"profile={dialog.ProfileId}");
            LaunchObserverProfile(dialog.ProfileId);
        }
        catch (Exception error)
        {
            _logger.Error("observer_profile_create_failed", error);
            MessageBox.Show(
                _form,
                "观摩源名称无效或无法创建。请使用 1-40 位英文字母、数字、横线或下划线。",
                "新增观摩源",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private async void LaunchObserverProfile(string profileId)
    {
        try
        {
            var profileDirectory = BridgeRuntimeProfile.CreateObserverProfile(
                _rootDataDirectory,
                profileId);
            var preferences = new BridgeUserPreferencesStore(
                Path.Combine(profileDirectory, "preferences.json"));
            var current = await preferences.LoadAsync(_stop.Token);
            if (string.IsNullOrWhiteSpace(current.Mt5TerminalPath))
            {
                using var dialog = new BridgeObserverProfileDialog(profileId);
                if (dialog.ShowDialog(_form) != DialogResult.OK)
                {
                    return;
                }
                await SaveObserverProfilePreferencesAsync(
                    profileDirectory,
                    dialog.Mt5ExecutablePath);
                _logger.Info(
                    "observer_profile_mt5_configured",
                    $"profile={profileId}; terminal_id={Mt5TerminalDiscovery.CreateTerminalInstanceId(dialog.Mt5ExecutablePath)}");
            }
            _ = Process.Start(BridgeRuntimeProfile.BuildLaunchInfo(profileId))
                ?? throw new InvalidOperationException("observer_profile_start_failed");
            _logger.Info("observer_profile_started", $"profile={profileId}");
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

    private async Task SaveObserverProfilePreferencesAsync(
        string profileDirectory,
        string terminalExecutablePath)
    {
        var preferences = new BridgeUserPreferencesStore(
            Path.Combine(profileDirectory, "preferences.json"));
        var terminalId = Mt5TerminalDiscovery.CreateTerminalInstanceId(
            terminalExecutablePath);
        await preferences.SavePlatformAsync(BridgePlatform.Mt5, _stop.Token);
        await preferences.SaveMt5TerminalAsync(terminalId, _stop.Token);
        await preferences.SaveMt5TerminalPathAsync(terminalExecutablePath, _stop.Token);
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
                        _form.BeginInvoke(() => _ = ApplyStagedUpdateAsync(coordinator, staged));
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
            if (!_form.IsDisposed)
            {
                _form.BeginInvoke(() => MessageBox.Show(
                    _form,
                    BridgeUiText.DescribeError(error),
                    "桥接运行异常",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error));
            }
        }
    }
}
