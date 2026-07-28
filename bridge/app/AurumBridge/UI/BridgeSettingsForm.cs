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
    private readonly TextBox _serverUrl = new();
    private readonly Panel _serverUrlHost = new();
    private readonly Label _testStatus = new();
    private readonly Button _testButton = new();
    private readonly Button _saveButton = new();
    private readonly Button _restoreButton = new();
    private readonly CancellationTokenSource _stop = new();
    private string? _lastSuccessfulTest;
    private string _customServerUrl = string.Empty;
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
        ClientSize = new(620, 490);
        MinimumSize = new(580, 470);
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
            Text = "统一设置桥接服务器地址，行情、交易指令和授权通道会自动完成配置。",
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
            RowCount = 3,
            Margin = new Padding(0, 0, 0, 14),
        };
        fields.RowStyles.Add(new(SizeType.AutoSize));
        fields.RowStyles.Add(new(SizeType.Absolute, 48));
        fields.RowStyles.Add(new(SizeType.AutoSize));
        fields.Controls.Add(FieldLabel("服务器地址"), 0, 0);
        ConfigureTextBox(_serverUrl, _serverUrlHost, "服务器地址");
        fields.Controls.Add(_serverUrlHost, 0, 1);
        fields.Controls.Add(new Label
        {
            AutoSize = true,
            MaximumSize = new(510, 0),
            Text = "远程地址需使用 HTTPS；本机测试可使用 HTTP。实时通道会自动配置。",
            ForeColor = Color.FromArgb(71, 85, 105),
            Margin = Padding.Empty,
        }, 0, 2);
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
            _serverUrl.Text = _view.Effective.ControlBaseUri.AbsoluteUri.TrimEnd('/');
            _customServerUrl = _serverUrl.Text;
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
            _customServerUrl = _serverUrl.Text;
            _serverUrl.Text = _view.Official.ControlBaseUri.AbsoluteUri.TrimEnd('/');
        }
        else if (!_lastModeCustom && custom)
        {
            _serverUrl.Text = _customServerUrl;
        }
        _lastModeCustom = custom;
        _serverUrl.Enabled = custom;
        _serverUrlHost.BackColor = custom ? Color.White : Color.FromArgb(245, 247, 250);
        _serverUrl.BackColor = _serverUrlHost.BackColor;
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
            return BridgeEndpointSettingsStore.FromServerUrl(_serverUrl.Text);
        }
        catch (InvalidDataException)
        {
            _lastSuccessfulTest = null;
            _testStatus.Text = "! 远程地址必须使用 HTTPS（本机测试可使用 HTTP），且不能包含路径或参数。";
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

    private void ConfigureTextBox(
        TextBox input,
        Panel host,
        string accessibleName)
    {
        host.Dock = DockStyle.Top;
        host.Height = 36;
        host.Margin = Padding.Empty;
        host.BackColor = Color.White;
        host.BorderStyle = BorderStyle.FixedSingle;
        host.TabStop = false;
        input.AutoSize = true;
        input.Margin = Padding.Empty;
        input.BorderStyle = BorderStyle.None;
        input.BackColor = Color.White;
        input.ForeColor = Color.FromArgb(15, 23, 42);
        input.AccessibleName = accessibleName;
        input.Anchor = AnchorStyles.Left | AnchorStyles.Right;
        input.TextChanged += (_, _) => InvalidateTest();
        host.Controls.Add(input);
        host.Click += (_, _) => input.Focus();
        void CenterInput(object? sender, EventArgs eventArgs)
        {
            var preferredHeight = input.PreferredHeight;
            input.SetBounds(
                10,
                Math.Max(0, (host.ClientSize.Height - preferredHeight) / 2),
                Math.Max(0, host.ClientSize.Width - 20),
                preferredHeight);
        }
        host.Resize += CenterInput;
        input.FontChanged += CenterInput;
        CenterInput(null, EventArgs.Empty);
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
