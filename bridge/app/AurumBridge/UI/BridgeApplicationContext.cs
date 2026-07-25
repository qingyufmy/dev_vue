using System.Diagnostics;
using AurumBridge.Runtime;
using AurumBridge.Update;

namespace AurumBridge.UI;

public sealed class BridgeApplicationContext : ApplicationContext
{
    private readonly BridgeMainForm _form;
    private readonly NotifyIcon _notifyIcon;
    private readonly BridgeApplicationController _controller;
    private readonly BridgeFileLogger _logger;
    private readonly BridgeSingleInstanceGuard _singleInstance;
    private readonly BridgeUpdateCoordinator? _updateCoordinator;
    private readonly string? _startupReadyFile;
    private readonly CancellationTokenSource _stop = new();
    private Task? _updateTask;
    private int _startupReadyWritten;
    private bool _shuttingDown;

    public BridgeApplicationContext(
        BridgeSingleInstanceGuard singleInstance,
        string? startupReadyFile = null)
    {
        _singleInstance = singleInstance ?? throw new ArgumentNullException(nameof(singleInstance));
        _startupReadyFile = startupReadyFile;
        var paths = BridgeRuntimePathResolver.Resolve(AppContext.BaseDirectory);
        _logger = new(Path.Combine(paths.DataDirectory, "logs"));
        EnsureAutoStart();
        _updateCoordinator = CreateUpdateCoordinator(paths.ServerBaseUri);
        _controller = new(paths);
        _form = new();
        _form.PairRequested += HandlePairRequested;
        _form.RedetectRequested += (_, _) => _controller.RequestRedetect();
        _form.OpenLogsRequested += HandleOpenLogsRequested;
        _form.ExitRequested += HandleExitRequested;
        _controller.StatusChanged += HandleStatusChanged;
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
                Process.Start(new ProcessStartInfo(prompt.VerificationUri.AbsoluteUri)
                {
                    UseShellExecute = true,
                });
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
            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                ArgumentList = { _logger.LogDirectory },
                UseShellExecute = true,
            });
        }
        catch (Exception error)
        {
            _logger.Error("open_logs_failed", error);
            MessageBox.Show(
                _form,
                "暂时无法打开日志目录，请稍后重试。",
                "查看日志",
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
        await _controller.DisposeAsync();
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
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
            await _controller.DisposeAsync();
            _singleInstance.ActivationRequested -= HandleActivationRequested;
            _singleInstance.Dispose();
            coordinator.StartLauncher();
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
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
