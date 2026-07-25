using System.Diagnostics;
using AurumBridge.Runtime;

namespace AurumBridge.UI;

public sealed class BridgeApplicationContext : ApplicationContext
{
    private readonly BridgeMainForm _form;
    private readonly NotifyIcon _notifyIcon;
    private readonly BridgeApplicationController _controller;
    private readonly BridgeFileLogger _logger;
    private readonly CancellationTokenSource _stop = new();
    private bool _shuttingDown;

    public BridgeApplicationContext()
    {
        var paths = BridgeRuntimePathResolver.Resolve(AppContext.BaseDirectory);
        _logger = new(Path.Combine(paths.DataDirectory, "logs"));
        _controller = new(paths);
        _form = new();
        _form.PairRequested += HandlePairRequested;
        _form.RedetectRequested += (_, _) => _controller.RequestRedetect();
        _form.OpenLogsRequested += HandleOpenLogsRequested;
        _form.ExitRequested += HandleExitRequested;
        _controller.StatusChanged += HandleStatusChanged;

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
    }

    private void HandleStatusChanged(BridgeApplicationStatus status)
    {
        _logger.Info(
            "bridge_status_changed",
            $"phase={status.Phase}; terminals={status.Terminals.Count}; detail={status.DetailCode ?? "none"}");
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
        await _controller.DisposeAsync();
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _form.AllowClose();
        _form.Close();
        _form.Dispose();
        _stop.Dispose();
        _logger.Dispose();
        ExitThread();
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
