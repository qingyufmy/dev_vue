using AurumBridge.Runtime;
using AurumBridge.Workers;

namespace AurumBridge.UI;

public sealed class BridgeObserverProfileDialog : Form
{
    private readonly TextBox _profileId = new();
    private readonly ComboBox _platformSelector = new();
    private readonly Label _directoryLabel = new();
    private readonly Label _directoryHelp = new();
    private readonly TextBox _terminalDirectory = new();
    private readonly string? _existingMt5ExecutablePath;
    private readonly string? _existingMt4TerminalPath;
    private string? _mt5ExecutablePath;
    private Mt4Installation? _mt4Installation;

    public BridgeObserverProfileDialog(
        string? existingProfileId = null,
        string? existingPlatform = null,
        string? existingMt5ExecutablePath = null,
        string? existingMt4TerminalPath = null)
    {
        var editingExisting = !string.IsNullOrWhiteSpace(existingProfileId);
        _existingMt5ExecutablePath = existingMt5ExecutablePath;
        _existingMt4TerminalPath = existingMt4TerminalPath;
        Text = editingExisting ? "设置观摩源" : "新增观摩源";
        Icon = BridgeBrandIcon.ApplicationIcon;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new(520, 380);
        MinimumSize = new(520, 380);
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        Font = new("Microsoft YaHei UI", 9F);

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new(20),
            ColumnCount = 1,
            RowCount = 10,
        };
        layout.Controls.Add(CreateHeading("观摩源名称"));
        layout.Controls.Add(CreateHelp("例如 source-1。每个观摩源独立保存终端和账号数据。"));
        _profileId.Dock = DockStyle.Top;
        _profileId.MaxLength = 40;
        _profileId.PlaceholderText = "source-1";
        if (editingExisting)
        {
            _profileId.Text = BridgeRuntimeProfile.Validate(existingProfileId);
            _profileId.ReadOnly = true;
        }
        layout.Controls.Add(_profileId);

        layout.Controls.Add(CreateHeading("交易平台", topMargin:14));
        _platformSelector.Dock = DockStyle.Top;
        _platformSelector.DropDownStyle = ComboBoxStyle.DropDownList;
        _platformSelector.Items.AddRange(["MT5", "MT4"]);
        _platformSelector.SelectedIndex = existingPlatform == BridgePlatform.Mt4 ? 1 : 0;
        _platformSelector.SelectedIndexChanged += (_, _) => ApplyPlatformCopy();
        layout.Controls.Add(_platformSelector);

        _directoryLabel.AutoSize = true;
        _directoryLabel.Font = new(Font.FontFamily, 10F, FontStyle.Bold);
        _directoryLabel.Margin = new Padding(0, 14, 0, 0);
        layout.Controls.Add(_directoryLabel);
        _directoryHelp.AutoSize = true;
        _directoryHelp.ForeColor = Color.FromArgb(71, 85, 105);
        _directoryHelp.Margin = new Padding(0, 4, 0, 8);
        layout.Controls.Add(_directoryHelp);

        var pathRow = new TableLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
        };
        pathRow.ColumnStyles.Add(new(SizeType.Percent, 100));
        pathRow.ColumnStyles.Add(new(SizeType.AutoSize));
        _terminalDirectory.Dock = DockStyle.Fill;
        var browse = new Button
        {
            AutoSize = true,
            Text = "浏览…",
            Margin = new Padding(8, 0, 0, 0),
        };
        browse.Click += (_, _) => BrowseForTerminalDirectory();
        pathRow.Controls.Add(_terminalDirectory, 0, 0);
        pathRow.Controls.Add(browse, 1, 0);
        layout.Controls.Add(pathRow);

        var actions = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            Margin = new Padding(0, 16, 0, 0),
        };
        var confirm = new Button
        {
            Text = editingExisting ? "保存并连接" : "创建并连接",
            AutoSize = true,
            DialogResult = DialogResult.OK,
        };
        var cancel = new Button { Text = "取消", AutoSize = true, DialogResult = DialogResult.Cancel };
        confirm.Click += (_, _) => ValidateSelection();
        actions.Controls.Add(confirm);
        actions.Controls.Add(cancel);
        layout.Controls.Add(actions);
        Controls.Add(layout);
        AcceptButton = confirm;
        CancelButton = cancel;
        ApplyPlatformCopy();
    }

    public string ProfileId => BridgeRuntimeProfile.Validate(_profileId.Text);
    public string Platform => _platformSelector.SelectedIndex == 1
        ? BridgePlatform.Mt4
        : BridgePlatform.Mt5;
    public string? Mt5ExecutablePath => _mt5ExecutablePath;
    public Mt4Installation? Mt4Installation => _mt4Installation;
    public string TerminalInstanceId => Platform == BridgePlatform.Mt4
        ? _mt4Installation?.TerminalInstanceId
            ?? throw new InvalidOperationException("observer_mt4_directory_not_selected")
        : Mt5TerminalDiscovery.CreateTerminalInstanceId(
            _mt5ExecutablePath
                ?? throw new InvalidOperationException("observer_mt5_directory_not_selected"));

    private void ApplyPlatformCopy()
    {
        var isMt4 = Platform == BridgePlatform.Mt4;
        _directoryLabel.Text = isMt4 ? "MT4 目录" : "MT5 安装目录";
        _directoryHelp.Text = isMt4
            ? "选择该观摩源专用的 MT4 安装目录或数据目录。保存后会自动安装 EA。"
            : "选择该观摩源专用的 MT5 安装目录，不能与其它观摩源共用。";
        _terminalDirectory.PlaceholderText = isMt4
            ? @"例如 C:\Program Files\Broker MT4"
            : @"例如 C:\Program Files\Broker MT5";
        _terminalDirectory.Text = isMt4
            ? _existingMt4TerminalPath ?? string.Empty
            : Path.GetDirectoryName(_existingMt5ExecutablePath) ?? string.Empty;
    }

    private void ValidateSelection()
    {
        try
        {
            var validated = BridgeRuntimeProfile.Validate(_profileId.Text);
            if (BridgeRuntimeProfile.IsDefault(validated))
            {
                throw new ArgumentException("bridge_profile_id_reserved", "profileId");
            }
            _profileId.Text = validated;
            if (Platform == BridgePlatform.Mt4)
            {
                _mt4Installation = Mt4TerminalDiscovery.ResolveDirectorySelection(
                    _terminalDirectory.Text,
                    Mt4TerminalDiscovery.DiscoverWindows())
                    ?? throw new InvalidDataException("observer_mt4_directory_invalid");
                _terminalDirectory.Text = _mt4Installation.TerminalDataPath;
                _mt5ExecutablePath = null;
                return;
            }

            var installation = Mt5TerminalDiscovery.ResolveCandidates([
                new(_terminalDirectory.Text, "observer_profile"),
            ]).SingleOrDefault()
                ?? throw new InvalidDataException("observer_mt5_directory_invalid");
            var sameExistingTerminal = !string.IsNullOrWhiteSpace(_existingMt5ExecutablePath)
                && string.Equals(
                    Path.GetFullPath(_existingMt5ExecutablePath),
                    Path.GetFullPath(installation.ExecutablePath),
                    StringComparison.OrdinalIgnoreCase);
            using var lease = sameExistingTerminal
                ? null
                : BridgeTerminalExclusiveLease.TryAcquire(installation.TerminalInstanceId);
            if (!sameExistingTerminal && lease is null)
            {
                throw new InvalidOperationException("observer_terminal_in_use");
            }
            _terminalDirectory.Text = Path.GetDirectoryName(installation.ExecutablePath)!;
            _mt5ExecutablePath = installation.ExecutablePath;
            _mt4Installation = null;
        }
        catch (ArgumentException error) when (error.ParamName == "profileId")
        {
            ShowValidationError(
                "请输入 1-40 位英文字母、数字、横线或下划线。",
                "观摩源名称无效");
        }
        catch (ArgumentException)
        {
            ShowValidationError(
                Platform == BridgePlatform.Mt4
                    ? "未找到对应的 MT4。请先启动一次 MT4，再选择它的安装目录或数据目录。"
                    : "所选目录中没有 terminal64.exe 或 terminal.exe，请重新选择 MT5 安装目录。",
                $"{BridgePlatform.DisplayName(Platform)} 目录无效");
        }
        catch (InvalidDataException)
        {
            ShowValidationError(
                Platform == BridgePlatform.Mt4
                    ? "未找到对应的 MT4。请先启动一次 MT4，再选择它的安装目录或数据目录。"
                    : "所选目录中没有 terminal64.exe 或 terminal.exe，请重新选择 MT5 安装目录。",
                $"{BridgePlatform.DisplayName(Platform)} 目录无效");
        }
        catch (InvalidOperationException error) when (
            error.Message == "observer_terminal_in_use")
        {
            ShowValidationError(
                "该终端已被主账户或另一个观摩源使用，请选择独立终端。",
                "终端已被占用");
        }
    }

    private void BrowseForTerminalDirectory()
    {
        using var picker = new BridgeTerminalDirectoryDialog(
            Platform,
            _terminalDirectory.Text,
            DiscoverSuggestedDirectories());
        if (picker.ShowDialog(this) == DialogResult.OK)
        {
            _terminalDirectory.Text = picker.SelectedPath;
        }
    }

    private IReadOnlyList<string> DiscoverSuggestedDirectories()
    {
        if (Platform == BridgePlatform.Mt4)
        {
            return Mt4TerminalDiscovery.DiscoverWindows()
                .SelectMany(installation => new[]
                {
                    installation.InstallationPath,
                    installation.TerminalDataPath,
                })
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
        var mt4InstallationPaths = Mt4TerminalDiscovery.DiscoverWindows()
            .Select(installation => Path.GetFullPath(installation.InstallationPath))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        return Mt5TerminalDiscovery.DiscoverWindows()
            .Select(installation => Path.GetDirectoryName(installation.ExecutablePath))
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Cast<string>()
            .Select(Path.GetFullPath)
            .Where(path => !mt4InstallationPaths.Contains(path))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private void ShowValidationError(string message, string title)
    {
        MessageBox.Show(this, message, title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        DialogResult = DialogResult.None;
    }

    private Label CreateHeading(string text, int topMargin = 0) => new()
    {
        AutoSize = true,
        Font = new(Font.FontFamily, 10F, FontStyle.Bold),
        Text = text,
        Margin = new Padding(0, topMargin, 0, 0),
    };

    private static Label CreateHelp(string text) => new()
    {
        AutoSize = true,
        ForeColor = Color.FromArgb(71, 85, 105),
        Text = text,
        Margin = new Padding(0, 4, 0, 10),
    };
}
