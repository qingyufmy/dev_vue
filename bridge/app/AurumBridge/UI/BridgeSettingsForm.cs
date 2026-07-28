using AurumBridge.Runtime;

namespace AurumBridge.UI;

public sealed record BridgeEndpointSettingsView(
    BridgeEndpointConfiguration Official,
    BridgeEndpointConfiguration Effective,
    bool CustomActive);

public sealed record BridgeEndpointSettingsSelection(
    bool FollowOfficial,
    BridgeEndpointConfiguration Configuration);

public sealed class BridgeSettingsForm : Form
{
    private readonly BridgeEndpointSettingsView _view;
    private readonly BridgeEndpointConnectivityTester _tester;
    private readonly RadioButton _officialMode = new();
    private readonly RadioButton _customMode = new();
    private readonly TextBox _controlUrl = new();
    private readonly TextBox _realtimeUrl = new();
    private readonly Label _testStatus = new();
    private readonly Button _testButton = new();
    private readonly Button _saveButton = new();
    private readonly Button _restoreButton = new();
    private readonly CancellationTokenSource _stop = new();
    private string? _lastSuccessfulTest;
    private string _customControlUrl = string.Empty;
    private string _customRealtimeUrl = string.Empty;
    private bool _lastModeCustom;
    private bool _updatingMode;

    public BridgeSettingsForm(
        BridgeEndpointSettingsView view,
        BridgeEndpointConnectivityTester? tester = null)
    {
        _view = view ?? throw new ArgumentNullException(nameof(view));
        _tester = tester ?? new BridgeEndpointConnectivityTester();
        Text = $"{BridgeBrand.ProductName} · 管理员设置";
        AccessibleName = "量见智桥管理员连接设置";
        Icon = BridgeBrandIcon.ApplicationIcon;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new(620, 540);
        MinimumSize = new(580, 520);
        MaximizeBox = false;
        MinimizeBox = false;
        BackColor = Color.FromArgb(248, 250, 252);
        Font = new("Microsoft YaHei UI", 9F);
        AutoScaleMode = AutoScaleMode.Dpi;
        BuildLayout();
        ApplyInitialState();
        FormClosed += (_, _) =>
        {
            _stop.Cancel();
            _stop.Dispose();
        };
    }

    public BridgeEndpointSettingsSelection? Selection { get; private set; }

    private void BuildLayout()
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new(28, 24, 28, 22),
            ColumnCount = 1,
            RowCount = 7,
        };
        root.RowStyles.Add(new(SizeType.AutoSize));
        root.RowStyles.Add(new(SizeType.AutoSize));
        root.RowStyles.Add(new(SizeType.AutoSize));
        root.RowStyles.Add(new(SizeType.AutoSize));
        root.RowStyles.Add(new(SizeType.AutoSize));
        root.RowStyles.Add(new(SizeType.Percent, 100));
        root.RowStyles.Add(new(SizeType.AutoSize));

        root.Controls.Add(new Label
        {
            AutoSize = true,
            Text = "连接设置",
            Font = new(Font.FontFamily, 16F, FontStyle.Bold),
            ForeColor = Color.FromArgb(15, 23, 42),
            Margin = new Padding(0, 0, 0, 4),
        }, 0, 0);
        root.Controls.Add(new Label
        {
            AutoSize = true,
            MaximumSize = new(550, 0),
            Text = "控制服务负责授权和配置，实时通道负责行情与交易指令。修改后将安全重启桥接。",
            ForeColor = Color.FromArgb(71, 85, 105),
            Margin = new Padding(0, 0, 0, 18),
        }, 0, 1);

        var modes = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Margin = new Padding(0, 0, 0, 16),
        };
        ConfigureRadio(_officialMode, "跟随官方配置");
        ConfigureRadio(_customMode, "使用管理员自定义地址");
        _officialMode.CheckedChanged += HandleModeChanged;
        _customMode.CheckedChanged += HandleModeChanged;
        modes.Controls.Add(_officialMode);
        modes.Controls.Add(_customMode);
        root.Controls.Add(modes, 0, 2);

        var fields = new TableLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            BackColor = Color.White,
            Padding = new(18, 16, 18, 16),
            ColumnCount = 1,
            RowCount = 6,
            Margin = new Padding(0, 0, 0, 14),
        };
        fields.Controls.Add(FieldLabel("控制服务地址（HTTPS）"), 0, 0);
        ConfigureTextBox(_controlUrl, "控制服务地址");
        fields.Controls.Add(_controlUrl, 0, 1);
        fields.Controls.Add(new Label
        {
            AutoSize = true,
            Text = "登录、授权、更新检查和管理接口始终通过该地址访问。",
            ForeColor = Color.FromArgb(100, 116, 139),
            Margin = new Padding(0, 4, 0, 14),
        }, 0, 2);
        fields.Controls.Add(FieldLabel("实时通信地址（WSS / WS）"), 0, 3);
        ConfigureTextBox(_realtimeUrl, "实时通信地址");
        fields.Controls.Add(_realtimeUrl, 0, 4);
        fields.Controls.Add(new Label
        {
            AutoSize = true,
            Text = "WS 仅传输短期连接票据、行情与指令，不发送长期登录凭据。",
            ForeColor = Color.FromArgb(100, 116, 139),
            Margin = new Padding(0, 4, 0, 0),
        }, 0, 5);
        root.Controls.Add(fields, 0, 3);

        var testRow = new TableLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
            Margin = new Padding(0, 0, 0, 12),
        };
        testRow.ColumnStyles.Add(new(SizeType.Percent, 100));
        testRow.ColumnStyles.Add(new(SizeType.AutoSize));
        _testStatus.AutoSize = true;
        _testStatus.Anchor = AnchorStyles.Left;
        _testStatus.ForeColor = Color.FromArgb(71, 85, 105);
        _testStatus.Text = "保存前需要完成一次连接测试。";
        _testStatus.Margin = Padding.Empty;
        testRow.Controls.Add(_testStatus, 0, 0);
        ConfigureButton(_testButton, "测试连接", primary:false);
        _testButton.Click += async (_, _) => await TestCurrentAsync();
        testRow.Controls.Add(_testButton, 1, 0);
        root.Controls.Add(testRow, 0, 4);

        root.Controls.Add(new Label
        {
            AutoSize = true,
            MaximumSize = new(550, 0),
            Text = "切换控制服务时会清除旧服务器授权，重启后需在新服务器重新授权一次。",
            ForeColor = Color.FromArgb(146, 64, 14),
            BackColor = Color.FromArgb(255, 251, 235),
            Padding = new Padding(12, 9, 12, 9),
            Margin = Padding.Empty,
        }, 0, 5);

        var actions = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
            Margin = new Padding(0, 16, 0, 0),
        };
        ConfigureButton(_saveButton, "保存并重启", primary:true);
        _saveButton.Click += async (_, _) => await SaveAsync();
        var cancel = new Button();
        ConfigureButton(cancel, "取消", primary:false);
        cancel.DialogResult = DialogResult.Cancel;
        ConfigureButton(_restoreButton, "恢复官方配置", primary:false);
        _restoreButton.Click += (_, _) => _officialMode.Checked = true;
        actions.Controls.Add(_saveButton);
        actions.Controls.Add(cancel);
        actions.Controls.Add(_restoreButton);
        root.Controls.Add(actions, 0, 6);
        AcceptButton = _saveButton;
        CancelButton = cancel;
        Controls.Add(root);
    }

    private void ApplyInitialState()
    {
        _updatingMode = true;
        try
        {
            _controlUrl.Text = _view.Effective.ControlBaseUri.AbsoluteUri.TrimEnd('/');
            _realtimeUrl.Text = _view.Effective.RealtimeBaseUri.AbsoluteUri.TrimEnd('/');
            _customControlUrl = _controlUrl.Text;
            _customRealtimeUrl = _realtimeUrl.Text;
            _customMode.Checked = _view.CustomActive;
            _officialMode.Checked = !_view.CustomActive;
            _lastModeCustom = _view.CustomActive;
        }
        finally
        {
            _updatingMode = false;
        }
        UpdateMode();
    }

    private void HandleModeChanged(object? sender, EventArgs eventArgs)
    {
        if (!_updatingMode)
        {
            UpdateMode();
        }
    }

    private void UpdateMode()
    {
        var custom = _customMode.Checked;
        if (_lastModeCustom && !custom)
        {
            _customControlUrl = _controlUrl.Text;
            _customRealtimeUrl = _realtimeUrl.Text;
            _controlUrl.Text = _view.Official.ControlBaseUri.AbsoluteUri.TrimEnd('/');
            _realtimeUrl.Text = _view.Official.RealtimeBaseUri.AbsoluteUri.TrimEnd('/');
        }
        else if (!_lastModeCustom && custom)
        {
            _controlUrl.Text = _customControlUrl;
            _realtimeUrl.Text = _customRealtimeUrl;
        }
        _lastModeCustom = custom;
        _controlUrl.Enabled = custom;
        _realtimeUrl.Enabled = custom;
        _restoreButton.Enabled = custom;
        InvalidateTest();
    }

    private async Task SaveAsync()
    {
        var configuration = TryReadConfiguration();
        if (configuration is null)
        {
            return;
        }
        var fingerprint = Fingerprint(configuration);
        if (_lastSuccessfulTest != fingerprint && !await TestCurrentAsync())
        {
            return;
        }
        Selection = new(!_customMode.Checked, configuration);
        DialogResult = DialogResult.OK;
        Close();
    }

    private async Task<bool> TestCurrentAsync()
    {
        var configuration = TryReadConfiguration();
        if (configuration is null)
        {
            return false;
        }
        SetBusy(true);
        try
        {
            var result = await _tester.TestAsync(configuration, _stop.Token);
            _testStatus.Text = result.Success
                ? $"✓ {result.Description}"
                : $"! {result.Description}";
            _testStatus.ForeColor = result.Success
                ? Color.FromArgb(4, 120, 87)
                : Color.FromArgb(185, 28, 28);
            _lastSuccessfulTest = result.Success ? Fingerprint(configuration) : null;
            return result.Success;
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
            return false;
        }
        finally
        {
            SetBusy(false);
        }
    }

    private BridgeEndpointConfiguration? TryReadConfiguration()
    {
        try
        {
            return BridgeEndpointSettingsStore.Normalize(_controlUrl.Text, _realtimeUrl.Text);
        }
        catch (InvalidDataException error)
        {
            _lastSuccessfulTest = null;
            _testStatus.Text = error.Message == "bridge_realtime_url_invalid"
                ? "! 实时通信地址必须使用 ws:// 或 wss://，且不能包含路径或参数。"
                : "! 控制服务必须使用 HTTPS，且不能包含路径或参数。";
            _testStatus.ForeColor = Color.FromArgb(185, 28, 28);
            return null;
        }
    }

    private void InvalidateTest()
    {
        _lastSuccessfulTest = null;
        _testStatus.Text = "保存前需要完成一次连接测试。";
        _testStatus.ForeColor = Color.FromArgb(71, 85, 105);
    }

    private void SetBusy(bool busy)
    {
        _testButton.Enabled = !busy;
        _saveButton.Enabled = !busy;
        _officialMode.Enabled = !busy;
        _customMode.Enabled = !busy;
        _testButton.Text = busy ? "正在测试…" : "测试连接";
    }

    private static string Fingerprint(BridgeEndpointConfiguration configuration) =>
        $"{configuration.ControlBaseUri.AbsoluteUri}|{configuration.RealtimeBaseUri.AbsoluteUri}";

    private static Label FieldLabel(string text) => new()
    {
        AutoSize = true,
        Text = text,
        Font = new("Microsoft YaHei UI", 9F, FontStyle.Bold),
        ForeColor = Color.FromArgb(51, 65, 85),
        Margin = new Padding(0, 0, 0, 6),
    };

    private void ConfigureRadio(RadioButton radio, string text)
    {
        radio.AutoSize = true;
        radio.Text = text;
        radio.ForeColor = Color.FromArgb(30, 41, 59);
        radio.Margin = new Padding(0, 0, 24, 0);
    }

    private void ConfigureTextBox(TextBox input, string accessibleName)
    {
        input.Dock = DockStyle.Top;
        input.MinimumSize = new(0, 36);
        input.BorderStyle = BorderStyle.FixedSingle;
        input.BackColor = Color.White;
        input.ForeColor = Color.FromArgb(15, 23, 42);
        input.AccessibleName = accessibleName;
        input.TextChanged += (_, _) => InvalidateTest();
    }

    private static void ConfigureButton(Button button, string text, bool primary)
    {
        button.AutoSize = true;
        button.MinimumSize = new(primary ? 112 : 96, 36);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 1;
        button.FlatAppearance.BorderColor = primary
            ? Color.FromArgb(212, 175, 55)
            : Color.FromArgb(203, 213, 225);
        button.BackColor = primary ? Color.FromArgb(212, 175, 55) : Color.White;
        button.ForeColor = primary ? Color.FromArgb(15, 23, 42) : Color.FromArgb(30, 41, 59);
        button.Text = text;
        button.Margin = new Padding(8, 0, 0, 0);
        button.Cursor = Cursors.Hand;
    }
}
