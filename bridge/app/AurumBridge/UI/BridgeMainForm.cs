using AurumBridge.Runtime;

namespace AurumBridge.UI;

public sealed class BridgePlatformChangedEventArgs(string platform) : EventArgs
{
    public string Platform { get; } = platform;
}

public sealed class BridgeTerminalChangedEventArgs(string terminalInstanceId) : EventArgs
{
    public string TerminalInstanceId { get; } = terminalInstanceId;
}

public sealed class BridgeMainForm : Form
{
    private readonly Label _statusTitle = new();
    private readonly Label _statusDescription = new();
    private readonly Label _runtimeSummary = new();
    private readonly Panel _statusMarker = new();
    private readonly FlowLayoutPanel _terminalList = new();
    private readonly Button _pairButton = new();
    private readonly Button _detectButton = new();
    private readonly Button _logButton = new();
    private readonly Button _exitButton = new();
    private readonly Button _logoutButton = new();
    private readonly ComboBox _platformSelector = new();
    private readonly ComboBox _terminalSelector = new();
    private readonly TableLayoutPanel _terminalSelectorBar = new();
    private bool _updatingPlatform;
    private bool _updatingTerminal;
    private bool _allowClose;

    public BridgeMainForm()
    {
        Text = "AURUM Bridge";
        AccessibleName = "AURUM Bridge 状态窗口";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new(560, 470);
        ClientSize = new(600, 500);
        BackColor = Color.FromArgb(248, 250, 252);
        Font = new("Microsoft YaHei UI", 9F);
        AutoScaleMode = AutoScaleMode.Dpi;
        MaximizeBox = false;
        BuildLayout();
        FormClosing += HandleFormClosing;
    }

    public event EventHandler? PairRequested;
    public event EventHandler? RedetectRequested;
    public event EventHandler? OpenLogsRequested;
    public event EventHandler? LogoutRequested;
    public event EventHandler? ExitRequested;
    public event EventHandler<BridgePlatformChangedEventArgs>? PlatformChanged;
    public event EventHandler<BridgeTerminalChangedEventArgs>? TerminalChanged;

    public void ApplyStatus(BridgeApplicationStatus status)
    {
        var text = BridgeUiText.ForStatus(status);
        _statusTitle.Text = text.Title;
        _statusDescription.Text = text.Description;
        _statusMarker.BackColor = text.AccentColor;
        _runtimeSummary.Text = BridgeUiText.DescribeRuntimeSummary(status);
        _pairButton.Visible = status.Phase == BridgeApplicationPhase.PairingRequired;
        _logoutButton.Visible = status.SelectedPlatform is not null
            && status.Phase is not (BridgeApplicationPhase.PairingRequired
                or BridgeApplicationPhase.PlatformSelectionRequired);
        ApplyPlatform(status.SelectedPlatform);
        ApplyTerminalCandidates(status);
        _terminalList.SuspendLayout();
        _terminalList.Controls.Clear();
        foreach (var terminal in status.Terminals)
        {
            _terminalList.Controls.Add(CreateTerminalRow(terminal));
        }
        if (status.Terminals.Count == 0)
        {
            _terminalList.Controls.Add(new Label
            {
                AutoSize = true,
                ForeColor = Color.FromArgb(100, 116, 139),
                Text = "尚未识别到交易账户",
                Margin = new Padding(0, 8, 0, 8),
            });
        }
        _terminalList.ResumeLayout();
    }

    public void SetPairingBusy(bool busy)
    {
        _pairButton.Enabled = !busy;
        _pairButton.Text = busy ? "等待浏览器确认…" : "连接账号";
    }

    public void ShowFromTray()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    public void AllowClose() => _allowClose = true;

    private void BuildLayout()
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new(28, 24, 28, 22),
            ColumnCount = 1,
            RowCount = 8,
        };
        root.RowStyles.Add(new(SizeType.AutoSize));
        root.RowStyles.Add(new(SizeType.AutoSize));
        root.RowStyles.Add(new(SizeType.AutoSize));
        root.RowStyles.Add(new(SizeType.Percent, 100));
        root.RowStyles.Add(new(SizeType.AutoSize));
        root.RowStyles.Add(new(SizeType.AutoSize));
        root.RowStyles.Add(new(SizeType.AutoSize));

        var heading = new Label
        {
            AutoSize = true,
            Font = new(Font.FontFamily, 18F, FontStyle.Bold),
            ForeColor = Color.FromArgb(15, 23, 42),
            Text = "AURUM Bridge",
            Margin = new Padding(0, 0, 0, 4),
        };
        var subheading = new Label
        {
            AutoSize = true,
            ForeColor = Color.FromArgb(71, 85, 105),
            Text = "自动连接交易终端与 AURUM 服务器",
            Margin = new Padding(0, 0, 0, 22),
        };
        root.Controls.Add(heading);
        root.Controls.Add(subheading);

        var platformBar = new TableLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            ColumnCount = 4,
            RowCount = 1,
            Margin = new Padding(0, 0, 0, 16),
        };
        platformBar.ColumnStyles.Add(new(SizeType.AutoSize));
        platformBar.ColumnStyles.Add(new(SizeType.Absolute, 120));
        platformBar.ColumnStyles.Add(new(SizeType.Percent, 100));
        platformBar.ColumnStyles.Add(new(SizeType.AutoSize));
        platformBar.Controls.Add(new Label
        {
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            ForeColor = Color.FromArgb(51, 65, 85),
            Text = "交易平台",
            Margin = new Padding(0, 8, 10, 0),
        }, 0, 0);
        _platformSelector.Dock = DockStyle.Fill;
        _platformSelector.DropDownStyle = ComboBoxStyle.DropDownList;
        _platformSelector.AccessibleName = "选择 MT4 或 MT5";
        _platformSelector.Items.AddRange(["MT5", "MT4"]);
        _platformSelector.SelectedIndexChanged += (_, _) =>
        {
            if (!_updatingPlatform && _platformSelector.SelectedItem is string selected)
            {
                PlatformChanged?.Invoke(this, new(selected.ToLowerInvariant()));
            }
        };
        platformBar.Controls.Add(_platformSelector, 1, 0);
        ConfigureButton(_logoutButton, "退出账号", primary:false);
        _logoutButton.MinimumSize = new(88, 34);
        _logoutButton.Visible = false;
        _logoutButton.Click += (_, _) => LogoutRequested?.Invoke(this, EventArgs.Empty);
        platformBar.Controls.Add(_logoutButton, 3, 0);
        root.Controls.Add(platformBar);

        _terminalSelectorBar.AutoSize = true;
        _terminalSelectorBar.Dock = DockStyle.Fill;
        _terminalSelectorBar.ColumnCount = 2;
        _terminalSelectorBar.RowCount = 1;
        _terminalSelectorBar.Margin = new Padding(0, 0, 0, 16);
        _terminalSelectorBar.ColumnStyles.Add(new(SizeType.AutoSize));
        _terminalSelectorBar.ColumnStyles.Add(new(SizeType.Percent, 100));
        _terminalSelectorBar.Controls.Add(new Label
        {
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            ForeColor = Color.FromArgb(51, 65, 85),
            Text = "MT5 账户",
            Margin = new Padding(0, 8, 10, 0),
        }, 0, 0);
        _terminalSelector.Dock = DockStyle.Fill;
        _terminalSelector.DropDownStyle = ComboBoxStyle.DropDownList;
        _terminalSelector.AccessibleName = "选择需要桥接的 MT5 账户";
        _terminalSelector.SelectedIndexChanged += (_, _) =>
        {
            if (!_updatingTerminal
                && _terminalSelector.SelectedItem is TerminalCandidateItem selected)
            {
                TerminalChanged?.Invoke(this, new(selected.TerminalInstanceId));
            }
        };
        _terminalSelectorBar.Controls.Add(_terminalSelector, 1, 0);
        _terminalSelectorBar.Visible = false;
        root.Controls.Add(_terminalSelectorBar);

        var card = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.White,
            Padding = new(20),
            ColumnCount = 2,
            RowCount = 5,
            Margin = new Padding(0, 0, 0, 18),
        };
        card.ColumnStyles.Add(new(SizeType.Absolute, 18));
        card.ColumnStyles.Add(new(SizeType.Percent, 100));
        card.RowStyles.Add(new(SizeType.AutoSize));
        card.RowStyles.Add(new(SizeType.AutoSize));
        card.RowStyles.Add(new(SizeType.AutoSize));
        card.RowStyles.Add(new(SizeType.AutoSize));
        card.RowStyles.Add(new(SizeType.Percent, 100));
        _statusMarker.Size = new(10, 10);
        _statusMarker.Margin = new(0, 7, 8, 0);
        _statusTitle.AutoSize = true;
        _statusTitle.Font = new(Font.FontFamily, 12F, FontStyle.Bold);
        _statusTitle.ForeColor = Color.FromArgb(15, 23, 42);
        _statusDescription.AutoSize = true;
        _statusDescription.MaximumSize = new(430, 0);
        _statusDescription.ForeColor = Color.FromArgb(71, 85, 105);
        _statusDescription.Margin = new(0, 4, 0, 8);
        _runtimeSummary.AutoSize = true;
        _runtimeSummary.ForeColor = Color.FromArgb(100, 116, 139);
        _runtimeSummary.Margin = new(0, 0, 0, 16);
        _terminalList.AutoScroll = true;
        _terminalList.Dock = DockStyle.Fill;
        _terminalList.FlowDirection = FlowDirection.TopDown;
        _terminalList.WrapContents = false;
        card.Controls.Add(_statusMarker, 0, 0);
        card.Controls.Add(_statusTitle, 1, 0);
        card.Controls.Add(_statusDescription, 1, 1);
        card.Controls.Add(_runtimeSummary, 1, 2);
        card.Controls.Add(new Label
        {
            AutoSize = true,
            Font = new(Font.FontFamily, 9F, FontStyle.Bold),
            ForeColor = Color.FromArgb(51, 65, 85),
            Text = "已识别账户",
            Margin = new(0, 0, 0, 5),
        }, 1, 3);
        card.Controls.Add(_terminalList, 1, 4);
        root.Controls.Add(card);

        var safety = new Label
        {
            AutoSize = true,
            ForeColor = Color.FromArgb(100, 116, 139),
            Text = "关闭窗口后仍会在托盘运行。退出桥接不会撤单、平仓或关闭 MT。",
            Margin = new Padding(0, 0, 0, 16),
        };
        root.Controls.Add(safety);

        var actions = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
        };
        ConfigureButton(_pairButton, "连接账号", primary: true);
        ConfigureButton(_detectButton, "重新检测", primary: false);
        ConfigureButton(_logButton, "查看日志", primary: false);
        ConfigureButton(_exitButton, "退出桥接", primary: false);
        _pairButton.Visible = false;
        _pairButton.Click += (_, _) => PairRequested?.Invoke(this, EventArgs.Empty);
        _detectButton.Click += (_, _) => RedetectRequested?.Invoke(this, EventArgs.Empty);
        _logButton.Click += (_, _) => OpenLogsRequested?.Invoke(this, EventArgs.Empty);
        _exitButton.Click += (_, _) => ExitRequested?.Invoke(this, EventArgs.Empty);
        actions.Controls.Add(_pairButton);
        actions.Controls.Add(_detectButton);
        actions.Controls.Add(_logButton);
        actions.Controls.Add(_exitButton);
        root.Controls.Add(actions);
        Controls.Add(root);
    }

    private void ApplyPlatform(string? platform)
    {
        var index = platform switch
        {
            BridgePlatform.Mt5 => 0,
            BridgePlatform.Mt4 => 1,
            _ => -1,
        };
        if (_platformSelector.SelectedIndex == index)
        {
            return;
        }
        _updatingPlatform = true;
        try
        {
            _platformSelector.SelectedIndex = index;
        }
        finally
        {
            _updatingPlatform = false;
        }
    }

    private void ApplyTerminalCandidates(BridgeApplicationStatus status)
    {
        var visible = status.SelectedPlatform == BridgePlatform.Mt5
            && status.TerminalCandidates.Count > 1;
        _terminalSelectorBar.Visible = visible;
        _updatingTerminal = true;
        try
        {
            _terminalSelector.Items.Clear();
            foreach (var candidate in status.TerminalCandidates)
            {
                _terminalSelector.Items.Add(new TerminalCandidateItem(
                    candidate.TerminalInstanceId,
                    $"{candidate.Login}  ·  {candidate.BrokerServer}"));
            }
            var selectedIndex = -1;
            for (var index = 0; index < _terminalSelector.Items.Count; index++)
            {
                if (_terminalSelector.Items[index] is TerminalCandidateItem item
                    && item.TerminalInstanceId == status.SelectedTerminalInstanceId)
                {
                    selectedIndex = index;
                    break;
                }
            }
            _terminalSelector.SelectedIndex = selectedIndex;
        }
        finally
        {
            _updatingTerminal = false;
        }
    }

    private sealed record TerminalCandidateItem(string TerminalInstanceId, string DisplayName)
    {
        public override string ToString() => DisplayName;
    }

    private Panel CreateTerminalRow(BridgeTerminalStatus terminal)
    {
        var state = BridgeUiText.DescribeTerminalState(terminal);
        var row = new Panel
        {
            Width = 430,
            Height = 46,
            BackColor = Color.FromArgb(248, 250, 252),
            Margin = new Padding(0, 4, 0, 4),
        };
        row.Controls.Add(new Label
        {
            AutoSize = true,
            Location = new(12, 7),
            Font = new(Font.FontFamily, 9F, FontStyle.Bold),
            ForeColor = Color.FromArgb(30, 41, 59),
            Text = $"{terminal.Platform.ToUpperInvariant()}  ·  {terminal.Login}",
        });
        row.Controls.Add(new Label
        {
            AutoSize = true,
            Location = new(12, 25),
            ForeColor = Color.FromArgb(100, 116, 139),
            Text = $"{terminal.BrokerServer}  ·  {state}",
        });
        return row;
    }

    private static void ConfigureButton(Button button, string text, bool primary)
    {
        button.AutoSize = true;
        button.MinimumSize = new(104, 38);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = primary ? 0 : 1;
        button.FlatAppearance.BorderColor = Color.FromArgb(203, 213, 225);
        button.BackColor = primary ? Color.FromArgb(37, 99, 235) : Color.White;
        button.ForeColor = primary ? Color.White : Color.FromArgb(30, 41, 59);
        button.Text = text;
        button.Margin = new Padding(8, 0, 0, 0);
        button.Cursor = Cursors.Hand;
    }

    private void HandleFormClosing(object? sender, FormClosingEventArgs eventArgs)
    {
        if (_allowClose)
        {
            return;
        }
        eventArgs.Cancel = true;
        Hide();
    }
}
