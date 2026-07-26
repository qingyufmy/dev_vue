using AurumBridge.Runtime;

namespace AurumBridge.UI;

public sealed class BridgeObserverProfileDialog : Form
{
    private readonly TextBox _profileId = new();

    public BridgeObserverProfileDialog()
    {
        Text = "新增观摩源";
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new(390, 180);
        MinimumSize = new(390, 180);
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        Font = new("Microsoft YaHei UI", 9F);

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new(20),
            ColumnCount = 1,
            RowCount = 4,
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
        layout.Controls.Add(_profileId);

        var actions = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            Margin = new Padding(0, 16, 0, 0),
        };
        var confirm = new Button { Text = "创建并启动", AutoSize = true, DialogResult = DialogResult.OK };
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
                eventArgs = EventArgs.Empty;
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
}
