using AurumBridge.Runtime;
using AurumBridge.Workers;

namespace AurumBridge.UI;

public sealed class BridgeObserverProfileDialog : Form
{
    private readonly TextBox _profileId = new();
    private readonly TextBox _mt5Directory = new();
    private string? _mt5ExecutablePath;

    public BridgeObserverProfileDialog(
        string? existingProfileId = null,
        string? existingMt5ExecutablePath = null)
    {
        var editingExisting = !string.IsNullOrWhiteSpace(existingProfileId);
        Text = editingExisting ? "设置观摩源 MT5" : "新增观摩源";
        Icon = BridgeBrandIcon.ApplicationIcon;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new(520, 290);
        MinimumSize = new(520, 290);
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        Font = new("Microsoft YaHei UI", 9F);

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new(20),
            ColumnCount = 1,
            RowCount = 7,
        };
        layout.Controls.Add(new Label
        {
            AutoSize = true,
            Font = new(Font.FontFamily, 10F, FontStyle.Bold),
            Text = "观摩源名称",
        });
        layout.Controls.Add(new Label
        {
            AutoSize = true,
            ForeColor = Color.FromArgb(71, 85, 105),
            Text = "例如 source-1。每个观摩源独立保存账号、终端选择和数据。",
            Margin = new Padding(0, 4, 0, 10),
        });
        _profileId.Dock = DockStyle.Top;
        _profileId.MaxLength = 40;
        _profileId.PlaceholderText = "source-1";
        if (editingExisting)
        {
            _profileId.Text = BridgeRuntimeProfile.Validate(existingProfileId);
            _profileId.ReadOnly = true;
        }
        layout.Controls.Add(_profileId);

        layout.Controls.Add(new Label
        {
            AutoSize = true,
            Font = new(Font.FontFamily, 10F, FontStyle.Bold),
            Text = "MT5 安装目录",
            Margin = new Padding(0, 16, 0, 0),
        });
        layout.Controls.Add(new Label
        {
            AutoSize = true,
            ForeColor = Color.FromArgb(71, 85, 105),
            Text = "请选择该观摩源专用的 MT5 目录，不能与其它桥接档案共用。",
            Margin = new Padding(0, 4, 0, 8),
        });
        var pathRow = new TableLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
        };
        pathRow.ColumnStyles.Add(new(SizeType.Percent, 100));
        pathRow.ColumnStyles.Add(new(SizeType.AutoSize));
        _mt5Directory.Dock = DockStyle.Fill;
        _mt5Directory.PlaceholderText = @"例如 C:\Program Files\Broker MT5";
        if (!string.IsNullOrWhiteSpace(existingMt5ExecutablePath))
        {
            _mt5Directory.Text = Path.GetDirectoryName(existingMt5ExecutablePath) ?? string.Empty;
        }
        var browse = new Button
        {
            AutoSize = true,
            Text = "浏览…",
            Margin = new Padding(8, 0, 0, 0),
        };
        browse.Click += (_, _) => BrowseForMt5Directory();
        pathRow.Controls.Add(_mt5Directory, 0, 0);
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
            Text = editingExisting ? "保存并启动" : "创建并启动",
            AutoSize = true,
            DialogResult = DialogResult.OK,
        };
        var cancel = new Button { Text = "取消", AutoSize = true, DialogResult = DialogResult.Cancel };
        confirm.Click += (_, eventArgs) =>
        {
            try
            {
                var validated = BridgeRuntimeProfile.Validate(_profileId.Text);
                if (BridgeRuntimeProfile.IsDefault(validated))
                {
                    throw new ArgumentException("bridge_profile_id_reserved");
                }
                _profileId.Text = validated;
                var installation = Mt5TerminalDiscovery.ResolveCandidates([
                    new(_mt5Directory.Text, "observer_profile"),
                ]).SingleOrDefault();
                if (installation is null)
                {
                    throw new InvalidDataException("observer_mt5_directory_invalid");
                }
                using var lease = BridgeTerminalExclusiveLease.TryAcquire(
                    installation.TerminalInstanceId);
                if (lease is null)
                {
                    throw new InvalidOperationException("observer_mt5_directory_in_use");
                }
                _mt5Directory.Text = Path.GetDirectoryName(installation.ExecutablePath)!;
                _mt5ExecutablePath = installation.ExecutablePath;
            }
            catch (ArgumentException)
            {
                MessageBox.Show(
                    this,
                    "请输入 1-40 位英文字母、数字、横线或下划线。",
                    "观摩源名称无效",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                DialogResult = DialogResult.None;
            }
            catch (InvalidDataException)
            {
                MessageBox.Show(
                    this,
                    "所选目录中没有 terminal64.exe 或 terminal.exe，请重新选择 MT5 安装目录。",
                    "MT5 目录无效",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                DialogResult = DialogResult.None;
            }
            catch (InvalidOperationException error) when (
                error.Message == "observer_mt5_directory_in_use")
            {
                MessageBox.Show(
                    this,
                    "该 MT5 已被主桥接或另一个观摩源使用，请选择独立的 MT5 安装目录。",
                    "MT5 已被占用",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                DialogResult = DialogResult.None;
            }
        };
        actions.Controls.Add(confirm);
        actions.Controls.Add(cancel);
        layout.Controls.Add(actions);
        Controls.Add(layout);
        AcceptButton = confirm;
        CancelButton = cancel;
    }

    public string ProfileId => BridgeRuntimeProfile.Validate(_profileId.Text);
    public string Mt5ExecutablePath => _mt5ExecutablePath
        ?? throw new InvalidOperationException("observer_mt5_directory_not_selected");

    private void BrowseForMt5Directory()
    {
        using var picker = new FolderBrowserDialog
        {
            Description = "选择观摩源专用的 MT5 安装目录",
            ShowNewFolderButton = false,
            UseDescriptionForTitle = true,
        };
        if (Directory.Exists(_mt5Directory.Text))
        {
            picker.InitialDirectory = _mt5Directory.Text;
        }
        if (picker.ShowDialog(this) == DialogResult.OK)
        {
            _mt5Directory.Text = picker.SelectedPath;
        }
    }
}
