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
    private readonly Button _observerSourcesButton = new();
    private readonly PlatformComboBox _platformSelector = new();
    private readonly ComboBox _terminalSelector = new();
    private readonly TableLayoutPanel _terminalSelectorBar = new();
    private readonly bool _isDefaultProfile;
    private ContextMenuStrip? _observerSourcesMenu;
    private bool _updatingPlatform;
    private bool _updatingTerminal;
    private bool _allowClose;

    public BridgeMainForm(string profileId = BridgeRuntimeProfile.DefaultId)
    {
        var validatedProfileId = BridgeRuntimeProfile.Validate(profileId);
        var isDefaultProfile = BridgeRuntimeProfile.IsDefault(validatedProfileId);
        _isDefaultProfile = isDefaultProfile;
        Text = isDefaultProfile
            ? BridgeBrand.ProductName
            : $"{BridgeBrand.ProductName} · 观摩源 {validatedProfileId}";
        Icon = BridgeBrandIcon.ApplicationIcon;
        AccessibleName = $"{BridgeBrand.ProductName}状态窗口";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new(560, 470);
        ClientSize = new(600, 500);
        BackColor = Color.FromArgb(248, 250, 252);
        Font = new("Microsoft YaHei UI", 9F);
        AutoScaleMode = AutoScaleMode.Dpi;
        MaximizeBox = false;
        BuildLayout(validatedProfileId, isDefaultProfile);
        FormClosing += HandleFormClosing;
    }

    public event EventHandler? PairRequested;
    public event EventHandler? ObserverSourcesRequested;
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
        _observerSourcesButton.Visible = CanShowObserverSources(
            _isDefaultProfile,
            status.CanManageObserverSources);
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
        _pairButton.Text = busy ? "正在准备授权…" : "连接账号";
    }

    public void SetPairingBrowserOpened() => _pairButton.Text = "等待浏览器确认…";

    public void ShowFromTray()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    public void AllowClose() => _allowClose = true;

    public static bool CanShowObserverSources(
        bool isDefaultProfile,
        bool canManageObserverSources) => isDefaultProfile && canManageObserverSources;

    public void ShowObserverSourcesMenu(
        IReadOnlyList<string> profileIds,
        Action<string> openProfile,
        Action createProfile)
    {
        ArgumentNullException.ThrowIfNull(profileIds);
        ArgumentNullException.ThrowIfNull(openProfile);
        ArgumentNullException.ThrowIfNull(createProfile);
        _observerSourcesMenu?.Dispose();
        var menu = new ContextMenuStrip();
        _observerSourcesMenu = menu;
        if (profileIds.Count == 0)
        {
            menu.Items.Add("尚未添加观摩源").Enabled = false;
        }
        else
        {
            foreach (var profileId in profileIds)
            {
                var captured = profileId;
                menu.Items.Add($"打开 {captured}", null, (_, _) => openProfile(captured));
            }
        }
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("新增观摩源…", null, (_, _) => createProfile());
        menu.Show(_observerSourcesButton, new Point(0, _observerSourcesButton.Height));
    }

    private void BuildLayout(string profileId, bool isDefaultProfile)
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new(32, 24, 32, 24),
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
            Text = isDefaultProfile
                ? BridgeBrand.ProductName
                : $"{BridgeBrand.ProductName} · {profileId}",
            Margin = new Padding(0, 0, 0, 4),
        };
        var subheading = new Label
        {
            AutoSize = true,
            ForeColor = Color.FromArgb(71, 85, 105),
            Text = isDefaultProfile
                ? BridgeBrand.Subtitle
                : "连接观摩终端与量见 AI交易实验室",
            Margin = new Padding(0, 0, 0, 24),
        };
        root.Controls.Add(heading);
        root.Controls.Add(subheading);

        var platformBar = new TableLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            ColumnCount = 3,
            RowCount = 1,
            Margin = new Padding(0, 0, 0, 16),
        };
        platformBar.ColumnStyles.Add(new(SizeType.AutoSize));
        platformBar.ColumnStyles.Add(new(SizeType.Percent, 100));
        platformBar.ColumnStyles.Add(new(SizeType.AutoSize));

        var platformField = new TableLayoutPanel
        {
            AutoSize = true,
            ColumnCount = 2,
            RowCount = 1,
            Margin = Padding.Empty,
        };
        platformField.ColumnStyles.Add(new(SizeType.AutoSize));
        platformField.ColumnStyles.Add(new(SizeType.Absolute, 136));
        platformField.Controls.Add(new Label
        {
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            Font = new(Font.FontFamily, 9F, FontStyle.Bold),
            ForeColor = Color.FromArgb(51, 65, 85),
            Text = "选择交易平台",
            Margin = new Padding(0, 0, 12, 0),
        }, 0, 0);
        _platformSelector.Dock = DockStyle.Fill;
        _platformSelector.DropDownStyle = ComboBoxStyle.DropDownList;
        _platformSelector.FlatStyle = FlatStyle.Flat;
        _platformSelector.BackColor = Color.White;
        _platformSelector.ForeColor = Color.FromArgb(30, 41, 59);
        _platformSelector.Font = new(Font.FontFamily, 9.5F);
        _platformSelector.MinimumSize = new(136, 36);
        _platformSelector.Margin = Padding.Empty;
        _platformSelector.AccessibleName = "选择 MT4 或 MT5";
        _platformSelector.Items.AddRange(["MT5", "MT4"]);
        _platformSelector.SelectedIndexChanged += (_, _) =>
        {
            if (!_updatingPlatform && _platformSelector.SelectedItem is string selected)
            {
                PlatformChanged?.Invoke(this, new(selected.ToLowerInvariant()));
            }
        };
        platformField.Controls.Add(_platformSelector, 1, 0);
        platformBar.Controls.Add(platformField, 0, 0);

        var platformActions = new FlowLayoutPanel
        {
            AutoSize = true,
            Anchor = AnchorStyles.Right,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Margin = Padding.Empty,
        };
        ConfigureButton(_observerSourcesButton, "观摩源", primary:false);
        _observerSourcesButton.MinimumSize = new(96, 36);
        _observerSourcesButton.Margin = Padding.Empty;
        _observerSourcesButton.Visible = false;
        _observerSourcesButton.Click += (_, _) => ObserverSourcesRequested?.Invoke(this, EventArgs.Empty);
        platformActions.Controls.Add(_observerSourcesButton);
        ConfigureButton(_logoutButton, "退出账号", primary:false);
        _logoutButton.MinimumSize = new(96, 36);
        _logoutButton.Margin = new Padding(8, 0, 0, 0);
        _logoutButton.Visible = false;
        _logoutButton.Click += (_, _) => LogoutRequested?.Invoke(this, EventArgs.Empty);
        platformActions.Controls.Add(_logoutButton);
        platformBar.Controls.Add(platformActions, 2, 0);
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
            Margin = new Padding(0, 0, 0, 16),
        };
        card.ColumnStyles.Add(new(SizeType.Absolute, 16));
        card.ColumnStyles.Add(new(SizeType.Percent, 100));
        card.RowStyles.Add(new(SizeType.AutoSize));
        card.RowStyles.Add(new(SizeType.AutoSize));
        card.RowStyles.Add(new(SizeType.AutoSize));
        card.RowStyles.Add(new(SizeType.AutoSize));
        card.RowStyles.Add(new(SizeType.Percent, 100));
        _statusMarker.Size = new(8, 8);
        _statusMarker.Margin = new(0, 8, 8, 0);
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
            Margin = new(0, 0, 0, 4),
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

    private sealed class PlatformComboBox : ComboBox
    {
        public PlatformComboBox()
        {
            DrawMode = DrawMode.OwnerDrawFixed;
            ItemHeight = 28;
            DropDownStyle = ComboBoxStyle.DropDownList;
            FlatStyle = FlatStyle.Flat;
        }

        protected override void OnDrawItem(DrawItemEventArgs eventArgs)
        {
            var isEditSurface = (eventArgs.State & DrawItemState.ComboBoxEdit) != 0;
            var isSelected = !isEditSurface
                && (eventArgs.State & DrawItemState.Selected) != 0;
            var background = isSelected ? SystemColors.Highlight : BackColor;
            var foreground = isSelected ? SystemColors.HighlightText : ForeColor;
            using var brush = new SolidBrush(background);
            eventArgs.Graphics.FillRectangle(brush, eventArgs.Bounds);
            if (eventArgs.Index >= 0)
            {
                var textBounds = new Rectangle(
                    eventArgs.Bounds.X + 8,
                    eventArgs.Bounds.Y,
                    Math.Max(0, eventArgs.Bounds.Width - 12),
                    eventArgs.Bounds.Height);
                TextRenderer.DrawText(
                    eventArgs.Graphics,
                    GetItemText(Items[eventArgs.Index]),
                    Font,
                    textBounds,
                    foreground,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
            }
            if ((eventArgs.State & DrawItemState.Focus) != 0 && !isEditSurface)
            {
                eventArgs.DrawFocusRectangle();
            }
        }
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
        button.MinimumSize = new(104, 36);
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

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _observerSourcesMenu?.Dispose();
        }
        base.Dispose(disposing);
    }
}
