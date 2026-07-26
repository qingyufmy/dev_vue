using System.Diagnostics;
using AurumBridge.Runtime;
using AurumBridge.Update;

namespace AurumBridge.UI;

public sealed class BridgeFirstAuthorizationGate
{
    private int _started;

    public bool TryStart(BridgeApplicationPhase phase) =>
        phase == BridgeApplicationPhase.PairingRequired
        && Interlocked.Exchange(ref _started, 1) == 0;
}

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
    private readonly CancellationTokenSource _stop = new();
    private readonly long _startedTimestamp = Stopwatch.GetTimestamp();
    private Task? _updateTask;
    private Task? _healthTask;
    private BridgeLogViewerForm? _logViewer;
    private int _startupReadyWritten;
    private readonly BridgeFirstAuthorizationGate _firstAuthorization = new();
    private int _latestPhase = (int)BridgeApplicationPhase.Starting;
    private int _latestTerminalCount;
    private bool _shuttingDown;

    public BridgeApplicationContext(
        BridgeSingleInstanceGuard singleInstance,
        string? startupReadyFile = null)
    {
        _singleInstance = singleInstance ?? throw new ArgumentNullException(nameof(singleInstance));
        _startupReadyFile = startupReadyFile;
        var paths = BridgeRuntimePathResolver.Resolve(AppContext.BaseDirectory);
        _logger = new(Path.Combine(paths.DataDirectory, "logs"));
        _preferences = new(Path.Combine(paths.DataDirectory, "preferences.json"));
        string? selectedPlatform = null;
        string? selectedMt5TerminalId = null;
        try
        {
            var preferences = _preferences.LoadAsync().GetAwaiter().GetResult();
            selectedPlatform = preferences.Platform;
            selectedMt5TerminalId = preferences.Mt5TerminalInstanceId;
        }
        catch (Exception error)
        {
            _logger.Error("preferences_load_failed", error);
        }
        EnsureAutoStart();
        _updateCoordinator = CreateUpdateCoordinator(paths.ServerBaseUri);
        _controller = new(paths, selectedPlatform, selectedMt5TerminalId);
        _form = new();
        _form.PairRequested += HandlePairRequested;
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
        _singleInstance.StartActivationListener();

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开 AURUM Bridge", null, (_, _) => _form.ShowFromTray());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出桥接", null, HandleExitRequested);
        _notifyIcon = new()
        {
            Icon = SystemIcons.Shield,
            Text = "AURUM Bridge",
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

    private void HandleStatusChanged(BridgeApplicationStatus status)
    {
        Volatile.Write(ref _latestPhase, (int)status.Phase);
        Volatile.Write(ref _latestTerminalCount, status.Terminals.Count);
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
                ? "AURUM Bridge · 运行中"
                : "AURUM Bridge";
            if (_firstAuthorization.TryStart(status.Phase))
            {
                _logger.Info("automatic_pairing_started");
                HandlePairRequested(_form, EventArgs.Empty);
            }
        });
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
            await _preferences.SaveMt5TerminalAsync(eventArgs.TerminalInstanceId, _stop.Token);
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
            MessageBox.Show(
                _form,
                "MT5 账户选择未能保存，请重新选择。",
                "选择 MT5 账户",
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
            "确定退出 AURUM Bridge？\n\n退出只会停止数据与指令转发，不会撤单、平仓或关闭 MT。",
            "退出桥接",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes)
        {
            return;
        }
        _shuttingDown = true;
        _logger.Info("bridge_stopping");
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
        _updateCoordinator?.Dispose();
        _logger.Dispose();
        ExitThread();
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
            _stop.Cancel();
            if (_healthTask is not null)
            {
                await IgnoreCancellationAsync(_healthTask);
            }
            await _controller.DisposeAsync();
            _singleInstance.ActivationRequested -= HandleActivationRequested;
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
                    "更新已准备完成，但自动重启失败。请手动重新打开 AURUM Bridge。",
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
