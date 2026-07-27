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

public sealed record BridgeObserverProfileView(
    string ProfileId,
    string? Platform,
    bool Configured,
    bool Enabled,
    string? TerminalInstanceId,
    long? BridgeUserId = null,
    string? ObserverAccountLabel = null,
    string? TradingAccountLabel = null,
    BridgeApplicationPhase? RuntimePhase = null,
    string? RuntimeDetailCode = null);

public enum BridgeObserverAction
{
    Start,
    Pause,
    Retry,
    Bind,
    Configure,
}

public sealed class BridgeObserverActionEventArgs(
    string profileId,
    BridgeObserverAction action) : EventArgs
{
    public string ProfileId { get; } = profileId;
    public BridgeObserverAction Action { get; } = action;
}

public sealed class BridgeMainForm : Form
{
    private readonly Label _statusTitle = new();
    private readonly Label _statusDescription = new();
    private readonly Label _runtimeSummary = new();
    private readonly Label _accountCountLabel = new();
    private readonly Panel _statusMarker = new();
    private readonly FlowLayoutPanel _terminalList = new();
    private readonly Button _pairButton = new();
    private readonly Button _detectButton = new();
    private readonly Button _logButton = new();
    private readonly Button _exitButton = new();
    private readonly Button _logoutButton = new();
    private readonly Button _observerSourcesButton = new();
    private readonly Button _mt4ExpertButton = new();
    private readonly PlatformComboBox _platformSelector = new();
    private readonly Label _platformSelectorLabel = new();
    private readonly ComboBox _terminalSelector = new();
    private readonly Label _terminalSelectorLabel = new();
    private readonly TableLayoutPanel _terminalSelectorBar = new();
    private readonly TableLayoutPanel _mt4SetupBar = new();
    private readonly bool _isDefaultProfile;
    private IReadOnlyList<BridgeObserverProfileView> _observerProfiles = [];
    private readonly HashSet<string> _busyObserverProfiles = new(StringComparer.Ordinal);
    private BridgeApplicationStatus? _lastStatus;
    private string? _lastAccountRenderFingerprint;
    private string? _pendingPlatform;
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
        MinimumSize = new(580, 620);
        ClientSize = new(620, 660);
        BackColor = Color.FromArgb(248, 250, 252);
        Font = new("Microsoft YaHei UI", 9F);
        AutoScaleMode = AutoScaleMode.Dpi;
        MaximizeBox = false;
        BuildLayout(validatedProfileId, isDefaultProfile);
        FormClosing += HandleFormClosing;
    }

    public event EventHandler? PairRequested;
    public event EventHandler? ObserverSourcesRequested;
    public event EventHandler<BridgeObserverActionEventArgs>? ObserverActionRequested;
    public event EventHandler? InstallMt4ExpertRequested;
    public event EventHandler? RedetectRequested;
    public event EventHandler? OpenLogsRequested;
    public event EventHandler? LogoutRequested;
    public event EventHandler? ExitRequested;
    public event EventHandler<BridgePlatformChangedEventArgs>? PlatformChanged;
    public event EventHandler<BridgeTerminalChangedEventArgs>? TerminalChanged;

    public void ApplyStatus(BridgeApplicationStatus status)
    {
        _lastStatus = status;
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
        _mt4SetupBar.Visible = CanShowMt4ExpertSetup(status.SelectedPlatform);
        if (_pendingPlatform is null)
        {
            ApplyPlatform(status.SelectedPlatform);
        }
        else if (status.SelectedPlatform == _pendingPlatform)
        {
            CompletePlatformSwitch();
        }
        ApplyTerminalCandidates(status);
        RenderAccountRows();
    }

    public void ApplyObserverProfiles(IReadOnlyList<BridgeObserverProfileView> profiles)
    {
        ArgumentNullException.ThrowIfNull(profiles);
        _observerProfiles = profiles;
        RenderAccountRows();
    }

    public void SetObserverActionBusy(string profileId, bool busy)
    {
        if (busy)
        {
            _busyObserverProfiles.Add(profileId);
        }
        else
        {
            _busyObserverProfiles.Remove(profileId);
        }
        RenderAccountRows();
    }

    public void SetPairingBusy(bool busy)
    {
        _pairButton.Enabled = !busy;
        _pairButton.Text = busy ? "正在准备授权…" : "连接账号";
    }

    public void SetPairingBrowserOpened() => _pairButton.Text = "等待浏览器确认…";

    public void SetMt4ExpertBusy(bool busy)
    {
        _mt4ExpertButton.Enabled = !busy;
        _mt4ExpertButton.Text = busy ? "正在安装…" : "安装 / 修复 EA";
    }

    public void BeginPlatformSwitch(string platform)
    {
        _pendingPlatform = BridgePlatform.Normalize(platform);
        _platformSelector.Enabled = false;
        _platformSelectorLabel.Text = "正在切换平台…";
    }

    public void CancelPlatformSwitch()
    {
        _pendingPlatform = null;
        _platformSelector.Enabled = true;
        _platformSelectorLabel.Text = "选择交易平台";
        ApplyPlatform(_lastStatus?.SelectedPlatform);
    }

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

    public static bool CanShowMt4ExpertSetup(string? selectedPlatform) =>
        selectedPlatform == BridgePlatform.Mt4;

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
        root.RowStyles.Add(new(SizeType.AutoSize));
        root.RowStyles.Add(new(SizeType.AutoSize));
        root.RowStyles.Add(new(SizeType.Percent, 100));
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
        root.Controls.Add(heading, 0, 0);
        root.Controls.Add(subheading, 0, 1);

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
        _platformSelectorLabel.AutoSize = true;
        _platformSelectorLabel.Anchor = AnchorStyles.Left;
        _platformSelectorLabel.Font = new(Font.FontFamily, 9F, FontStyle.Bold);
        _platformSelectorLabel.ForeColor = Color.FromArgb(51, 65, 85);
        _platformSelectorLabel.Text = "选择交易平台";
        _platformSelectorLabel.Margin = new Padding(0, 0, 12, 0);
        platformField.Controls.Add(_platformSelectorLabel, 0, 0);
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
        ConfigureButton(_observerSourcesButton, "添加观摩源", primary:false);
        _observerSourcesButton.MinimumSize = new(108, 36);
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
        root.Controls.Add(platformBar, 0, 2);

        _terminalSelectorBar.AutoSize = true;
        _terminalSelectorBar.Dock = DockStyle.Fill;
        _terminalSelectorBar.ColumnCount = 2;
        _terminalSelectorBar.RowCount = 1;
        _terminalSelectorBar.Margin = new Padding(0, 0, 0, 16);
        _terminalSelectorBar.ColumnStyles.Add(new(SizeType.AutoSize));
        _terminalSelectorBar.ColumnStyles.Add(new(SizeType.Percent, 100));
        _terminalSelectorLabel.AutoSize = true;
        _terminalSelectorLabel.Anchor = AnchorStyles.Left;
        _terminalSelectorLabel.ForeColor = Color.FromArgb(51, 65, 85);
        _terminalSelectorLabel.Text = "MT5 账户";
        _terminalSelectorLabel.Margin = new Padding(0, 8, 10, 0);
        _terminalSelectorBar.Controls.Add(_terminalSelectorLabel, 0, 0);
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
        root.Controls.Add(_terminalSelectorBar, 0, 3);

        _mt4SetupBar.AutoSize = true;
        _mt4SetupBar.Dock = DockStyle.Fill;
        _mt4SetupBar.BackColor = Color.FromArgb(239, 246, 255);
        _mt4SetupBar.Padding = new(12, 10, 12, 10);
        _mt4SetupBar.ColumnCount = 2;
        _mt4SetupBar.RowCount = 1;
        _mt4SetupBar.Margin = new Padding(0, 0, 0, 16);
        _mt4SetupBar.ColumnStyles.Add(new(SizeType.Percent, 100));
        _mt4SetupBar.ColumnStyles.Add(new(SizeType.AutoSize));
        _mt4SetupBar.Controls.Add(new Label
        {
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            ForeColor = Color.FromArgb(30, 64, 175),
            Text = "MT4 重装或 EA 丢失时，可随时重新安装。",
            Margin = new Padding(0, 8, 12, 0),
        }, 0, 0);
        ConfigureButton(_mt4ExpertButton, "安装 / 修复 EA", primary:false);
        _mt4ExpertButton.MinimumSize = new(124, 36);
        _mt4ExpertButton.Margin = Padding.Empty;
        _mt4ExpertButton.AccessibleName = "安装或修复 MT4 EA";
        _mt4ExpertButton.Click += (_, _) =>
            InstallMt4ExpertRequested?.Invoke(this, EventArgs.Empty);
        _mt4SetupBar.Controls.Add(_mt4ExpertButton, 1, 0);
        _mt4SetupBar.Visible = false;
        root.Controls.Add(_mt4SetupBar, 0, 4);

        var card = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.White,
            Padding = new(20),
            ColumnCount = 1,
            RowCount = 6,
            Margin = new Padding(0, 0, 0, 16),
        };
        card.ColumnStyles.Add(new(SizeType.Percent, 100));
        card.RowStyles.Add(new(SizeType.AutoSize));
        card.RowStyles.Add(new(SizeType.AutoSize));
        card.RowStyles.Add(new(SizeType.AutoSize));
        card.RowStyles.Add(new(SizeType.AutoSize));
        card.RowStyles.Add(new(SizeType.AutoSize));
        card.RowStyles.Add(new(SizeType.Percent, 100));

        var statusHeader = new TableLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
            Margin = Padding.Empty,
        };
        statusHeader.ColumnStyles.Add(new(SizeType.Absolute, 20));
        statusHeader.ColumnStyles.Add(new(SizeType.Percent, 100));
        _statusMarker.Size = new(8, 8);
        _statusMarker.Anchor = AnchorStyles.Left;
        _statusMarker.Margin = new(0, 0, 8, 0);
        _statusTitle.AutoSize = true;
        _statusTitle.Font = new(Font.FontFamily, 12F, FontStyle.Bold);
        _statusTitle.ForeColor = Color.FromArgb(15, 23, 42);
        _statusTitle.Margin = Padding.Empty;
        statusHeader.Controls.Add(_statusMarker, 0, 0);
        statusHeader.Controls.Add(_statusTitle, 1, 0);
        _statusDescription.AutoSize = true;
        _statusDescription.MaximumSize = new(500, 0);
        _statusDescription.ForeColor = Color.FromArgb(71, 85, 105);
        _statusDescription.Margin = new(20, 4, 0, 8);
        _runtimeSummary.AutoSize = true;
        _runtimeSummary.ForeColor = Color.FromArgb(100, 116, 139);
        _runtimeSummary.Margin = new(20, 0, 0, 12);

        var divider = new Panel
        {
            Dock = DockStyle.Top,
            Height = 1,
            BackColor = Color.FromArgb(226, 232, 240),
            Margin = new Padding(0, 0, 0, 12),
        };

        var accountsHeader = new TableLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
            Margin = new Padding(0, 0, 0, 4),
        };
        accountsHeader.ColumnStyles.Add(new(SizeType.Percent, 100));
        accountsHeader.ColumnStyles.Add(new(SizeType.AutoSize));
        accountsHeader.Controls.Add(new Label
        {
            AutoSize = true,
            Font = new(Font.FontFamily, 9F, FontStyle.Bold),
            ForeColor = Color.FromArgb(51, 65, 85),
            Text = "账户连接",
            Margin = Padding.Empty,
        }, 0, 0);
        _accountCountLabel.AutoSize = true;
        _accountCountLabel.Anchor = AnchorStyles.Right;
        _accountCountLabel.ForeColor = Color.FromArgb(100, 116, 139);
        _accountCountLabel.Margin = Padding.Empty;
        accountsHeader.Controls.Add(_accountCountLabel, 1, 0);

        _terminalList.AutoScroll = true;
        _terminalList.Dock = DockStyle.Fill;
        _terminalList.FlowDirection = FlowDirection.TopDown;
        _terminalList.WrapContents = false;
        card.Controls.Add(statusHeader, 0, 0);
        card.Controls.Add(_statusDescription, 0, 1);
        card.Controls.Add(_runtimeSummary, 0, 2);
        card.Controls.Add(divider, 0, 3);
        card.Controls.Add(accountsHeader, 0, 4);
        card.Controls.Add(_terminalList, 0, 5);
        root.Controls.Add(card, 0, 5);

        var safety = new Label
        {
            AutoSize = true,
            ForeColor = Color.FromArgb(100, 116, 139),
            Text = "关闭窗口后仍会在托盘运行。退出桥接不会撤单、平仓或关闭 MT。",
            Margin = new Padding(0, 0, 0, 16),
        };
        root.Controls.Add(safety, 0, 6);

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
        root.Controls.Add(actions, 0, 7);
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

    private void CompletePlatformSwitch()
    {
        _pendingPlatform = null;
        _platformSelector.Enabled = true;
        _platformSelectorLabel.Text = "选择交易平台";
    }

    private void ApplyTerminalCandidates(BridgeApplicationStatus status)
    {
        var visible = status.TerminalCandidates.Count > 1;
        _terminalSelectorBar.Visible = visible;
        var isMt4 = status.SelectedPlatform == BridgePlatform.Mt4;
        _terminalSelectorLabel.Text = isMt4 ? "MT4 终端" : "MT5 账户";
        _terminalSelector.AccessibleName = isMt4
            ? "选择需要安装量见智桥 EA 的 MT4 终端"
            : "选择需要桥接的 MT5 账户";
        _updatingTerminal = true;
        try
        {
            _terminalSelector.Items.Clear();
            foreach (var candidate in status.TerminalCandidates)
            {
                _terminalSelector.Items.Add(new TerminalCandidateItem(
                    candidate.TerminalInstanceId,
                    candidate.DisplayName
                        ?? $"{candidate.Login}  ·  {candidate.BrokerServer}"));
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

    private void RenderAccountRows()
    {
        if (_lastStatus is null || _terminalList.IsDisposed)
        {
            return;
        }
        var fingerprint = BridgeStatusFingerprint.ForAccounts(
            _lastStatus,
            _observerProfiles,
            _busyObserverProfiles);
        if (_lastAccountRenderFingerprint == fingerprint)
        {
            return;
        }
        _lastAccountRenderFingerprint = fingerprint;
        _terminalList.SuspendLayout();
        _terminalList.Controls.Clear();
        var mainTerminals = _lastStatus.Terminals
            .Where(terminal => terminal.ObserverProfileId is null)
            .ToArray();
        foreach (var terminal in mainTerminals)
        {
            _terminalList.Controls.Add(CreateAccountRow(
                terminal,
                "主账户",
                observerProfile:null));
        }
        if (_lastStatus.CanManageObserverSources)
        {
            foreach (var profile in _observerProfiles)
            {
                var terminal = _lastStatus.Terminals.FirstOrDefault(candidate =>
                    candidate.ObserverProfileId == profile.ProfileId);
                _terminalList.Controls.Add(CreateAccountRow(
                    terminal,
                    profile.ProfileId,
                    profile));
            }
        }
        var accountCount = _terminalList.Controls.Count;
        _accountCountLabel.Text = accountCount == 0 ? "暂无账户" : $"{accountCount} 个";
        if (_terminalList.Controls.Count == 0)
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

    private Control CreateAccountRow(
        BridgeTerminalStatus? terminal,
        string role,
        BridgeObserverProfileView? observerProfile)
    {
        var row = new TableLayoutPanel
        {
            Width = 468,
            Height = 70,
            BackColor = Color.FromArgb(248, 250, 252),
            Margin = new Padding(0, 3, 0, 3),
            Padding = new Padding(12, 8, 8, 8),
            ColumnCount = 3,
            RowCount = 1,
        };
        row.ColumnStyles.Add(new(SizeType.Absolute, 18));
        row.ColumnStyles.Add(new(SizeType.Percent, 100));
        row.ColumnStyles.Add(new(SizeType.AutoSize));
        row.RowStyles.Add(new(SizeType.Percent, 100));
        var statusDot = new Panel
        {
            Size = new(8, 8),
            Anchor = AnchorStyles.None,
            BackColor = ResolveAccountStateColor(terminal, observerProfile),
            Margin = Padding.Empty,
        };
        row.Controls.Add(statusDot, 0, 0);
        var copy = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Margin = Padding.Empty,
            ColumnCount = 1,
            RowCount = 2,
        };
        copy.RowStyles.Add(new(SizeType.Percent, 50));
        copy.RowStyles.Add(new(SizeType.Percent, 50));
        var platform = terminal?.Platform
            ?? observerProfile?.Platform
            ?? "terminal";
        var identity = terminal is null || string.IsNullOrWhiteSpace(terminal.Login)
            ? platform.ToUpperInvariant()
            : $"{platform.ToUpperInvariant()} · {terminal.Login}";
        var observerIdentity = observerProfile?.ObserverAccountLabel;
        var title = observerProfile is null
            ? $"主账户  ·  {identity}"
            : string.IsNullOrWhiteSpace(observerIdentity)
                ? $"{role}  ·  {identity}"
                : $"{observerIdentity}  ·  {identity}";
        copy.Controls.Add(new Label
        {
            AutoEllipsis = true,
            Dock = DockStyle.Fill,
            Font = new(Font.FontFamily, 9F, FontStyle.Bold),
            ForeColor = Color.FromArgb(30, 41, 59),
            Text = title,
            Margin = Padding.Empty,
        });
        copy.Controls.Add(new Label
        {
            AutoEllipsis = true,
            Dock = DockStyle.Fill,
            ForeColor = Color.FromArgb(71, 85, 105),
            Text = DescribeAccountState(terminal, observerProfile),
            Margin = new Padding(0, 4, 8, 0),
        });
        row.Controls.Add(copy, 1, 0);
        if (observerProfile is not null)
        {
            row.Controls.Add(CreateObserverActions(observerProfile, terminal), 2, 0);
        }
        return row;
    }

    private Control CreateObserverActions(
        BridgeObserverProfileView profile,
        BridgeTerminalStatus? terminal)
    {
        var primaryAction = ResolveObserverPrimaryAction(profile, terminal);
        var actionCount = primaryAction is null ? 1 : 2;
        var actions = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = false,
            Width = actionCount * 76,
            Height = 54,
            MinimumSize = new(actionCount * 76, 54),
            ColumnCount = actionCount,
            RowCount = 1,
            Margin = Padding.Empty,
        };
        for (var index = 0; index < actionCount; index++)
        {
            actions.ColumnStyles.Add(new(SizeType.Absolute, 76));
        }
        var busy = _busyObserverProfiles.Contains(profile.ProfileId);
        if (primaryAction is not null)
        {
            var action = primaryAction.Value;
            var emphasize = action is BridgeObserverAction.Start
                or BridgeObserverAction.Retry
                or BridgeObserverAction.Bind;
            var button = CreateCompactButton(
                busy ? "处理中…" : DescribeObserverAction(action),
                emphasize);
            button.Enabled = !busy;
            button.Click += (_, _) => ObserverActionRequested?.Invoke(
                this,
                new(profile.ProfileId, action));
            actions.Controls.Add(button, 0, 0);
        }
        var settings = CreateCompactButton("设置", primary:false);
        settings.Enabled = !busy;
        settings.Click += (_, _) => ObserverActionRequested?.Invoke(
            this,
            new(profile.ProfileId, BridgeObserverAction.Configure));
        actions.Controls.Add(settings, actionCount - 1, 0);
        return actions;
    }

    public static BridgeObserverAction? ResolveObserverPrimaryAction(
        BridgeObserverProfileView profile,
        BridgeTerminalStatus? terminal)
    {
        if (profile.BridgeUserId is null)
        {
            return BridgeObserverAction.Bind;
        }
        if (!profile.Configured)
        {
            return null;
        }
        if (!profile.Enabled)
        {
            return BridgeObserverAction.Start;
        }
        return terminal is null
            || terminal.RuntimeState == TerminalRuntimeState.Stopped
            ? BridgeObserverAction.Retry
            : BridgeObserverAction.Pause;
    }

    private static string DescribeObserverAction(BridgeObserverAction action) => action switch
    {
        BridgeObserverAction.Start => "启动",
        BridgeObserverAction.Pause => "暂停",
        BridgeObserverAction.Retry => "重试",
        BridgeObserverAction.Bind => "绑定",
        _ => "设置",
    };

    private static string DescribeAccountState(
        BridgeTerminalStatus? terminal,
        BridgeObserverProfileView? profile)
    {
        if (profile is { BridgeUserId: null })
        {
            return "待绑定观摩账户 · 点击“绑定”完成归属";
        }
        if (profile is { Configured: false })
        {
            return "观摩源 · 需要设置交易终端";
        }
        if (profile is { Enabled: false })
        {
            return "观摩源 · 已暂停，终端配置已保留";
        }
        if (terminal is null)
        {
            if (profile?.RuntimePhase == BridgeApplicationPhase.PairingRequired)
            {
                return "观摩源授权已失效 · 请重新绑定";
            }
            if (profile?.RuntimePhase == BridgeApplicationPhase.TerminalNotFound)
            {
                return "未找到配置的交易终端 · 请检查设置";
            }
            var account = profile?.TradingAccountLabel;
            return profile is null
                ? "等待识别账户"
                : string.IsNullOrWhiteSpace(account)
                    ? "观摩源 · 正在连接交易终端"
                    : $"观摩源 · {account} · 正在连接";
        }
        var broker = string.IsNullOrWhiteSpace(terminal.BrokerServer)
            ? "交易终端"
            : terminal.BrokerServer;
        var prefix = profile is null ? string.Empty : "观摩源 · ";
        return $"{prefix}{broker} · {BridgeUiText.DescribeTerminalState(terminal)}";
    }

    private static Color ResolveAccountStateColor(
        BridgeTerminalStatus? terminal,
        BridgeObserverProfileView? profile)
    {
        if (profile is { Enabled: false })
        {
            return Color.FromArgb(100, 116, 139);
        }
        if (profile is { BridgeUserId: null })
        {
            return Color.FromArgb(217, 119, 6);
        }
        if (profile is { Configured: false } || terminal is null)
        {
            return Color.FromArgb(217, 119, 6);
        }
        return terminal?.RuntimeState == TerminalRuntimeState.Running
            ? Color.FromArgb(5, 150, 105)
            : terminal?.RuntimeState == TerminalRuntimeState.Stopped
                ? Color.FromArgb(220, 38, 38)
                : Color.FromArgb(37, 99, 235);
    }

    private static Button CreateCompactButton(string text, bool primary)
    {
        var button = new Button();
        ConfigureButton(button, text, primary);
        button.AutoSize = false;
        button.Anchor = AnchorStyles.None;
        button.Size = new(70, 34);
        button.MinimumSize = new(70, 34);
        button.Margin = Padding.Empty;
        return button;
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

}
