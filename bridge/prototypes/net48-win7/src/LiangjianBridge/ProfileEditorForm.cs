using System;
using System.Drawing;
using System.Windows.Forms;
using Liangjian.BridgeV4.Configuration;

namespace Liangjian.BridgeV4.App
{
    internal sealed class ProfileEditorForm : Form
    {
        private readonly TextBox displayName = Field();
        private readonly ComboBox platform = new ComboBox();
        private readonly TextBox terminalId = Field();
        private readonly TextBox broker = Field();
        private readonly TextBox login = Field();
        private readonly TextBox serverUri = Field();
        private readonly TextBox refreshToken = Field();
        private readonly CheckBox autoConnect = new CheckBox();
        private readonly TextBox python = Field();
        private readonly TextBox worker = Field();
        private readonly TextBox terminal = Field();
        private readonly TableLayoutPanel fields = new TableLayoutPanel();
        private readonly bool newProfile;

        public ProfileEditorForm(BridgeProfileSettings profileValue, bool isNew)
        {
            if (profileValue == null) throw new ArgumentNullException("profileValue");
            Profile = profileValue;
            newProfile = isNew;
            Text = isNew ? "新增终端档案" : "编辑终端档案";
            StartPosition = FormStartPosition.CenterParent;
            MinimumSize = new Size(620, 590);
            Size = new Size(700, 700);
            Font = new Font("Microsoft YaHei UI", 9F);

            platform.DropDownStyle = ComboBoxStyle.DropDownList;
            platform.Items.AddRange(new object[] { "MT5", "MT4" });
            platform.SelectedIndexChanged += delegate { ApplyPlatformVisibility(); };
            refreshToken.UseSystemPasswordChar = true;
            autoConnect.Text = "程序启动后自动连接";
            autoConnect.AutoSize = true;

            fields.Dock = DockStyle.Fill;
            fields.Padding = new Padding(22);
            fields.AutoScroll = true;
            fields.ColumnCount = 2;
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            AddRow("档案名称", displayName);
            AddRow("平台", platform);
            AddRow("终端实例 ID", terminalId);
            AddRow("经纪商服务器", broker);
            AddRow("交易账号", login);
            AddRow("Bridge 实时地址", serverUri);
            AddRow(isNew ? "V4 刷新凭据" : "新 V4 刷新凭据（留空不变）", refreshToken);
            AddRow("", autoConnect);
            AddRow("Python 可执行文件", python);
            AddRow("MT5 Worker 脚本", worker);
            AddRow("terminal64.exe", terminal);

            FlowLayoutPanel footer = new FlowLayoutPanel
            {
                Dock = DockStyle.Bottom, Height = 58, FlowDirection = FlowDirection.RightToLeft,
                Padding = new Padding(12)
            };
            Button save = new Button { Text = "保存", DialogResult = DialogResult.None, Width = 90, Height = 34 };
            Button cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Width = 90, Height = 34 };
            save.Click += delegate { SaveAndClose(); };
            footer.Controls.Add(save);
            footer.Controls.Add(cancel);
            Controls.Add(fields);
            Controls.Add(footer);
            AcceptButton = save;
            CancelButton = cancel;

            displayName.Text = Profile.DisplayName ?? string.Empty;
            platform.SelectedItem = string.Equals(Profile.Platform, "mt4", StringComparison.OrdinalIgnoreCase) ? "MT4" : "MT5";
            terminalId.Text = Profile.TerminalInstanceId ?? string.Empty;
            broker.Text = Profile.BrokerServer ?? string.Empty;
            login.Text = Profile.Login ?? string.Empty;
            serverUri.Text = Profile.ServerUri ?? string.Empty;
            autoConnect.Checked = Profile.AutoConnect;
            python.Text = Profile.PythonExecutablePath ?? string.Empty;
            worker.Text = Profile.WorkerScriptPath ?? string.Empty;
            terminal.Text = Profile.TerminalPath ?? string.Empty;
            ApplyPlatformVisibility();
        }

        public BridgeProfileSettings Profile { get; private set; }
        public string RefreshToken { get; private set; }

        private void SaveAndClose()
        {
            Profile.DisplayName = displayName.Text.Trim();
            Profile.Platform = string.Equals(platform.SelectedItem as string, "MT4", StringComparison.Ordinal) ? "mt4" : "mt5";
            Profile.TerminalInstanceId = terminalId.Text.Trim();
            Profile.BrokerServer = broker.Text.Trim();
            Profile.Login = login.Text.Trim();
            Profile.ServerUri = serverUri.Text.Trim();
            Profile.AutoConnect = autoConnect.Checked;
            Profile.PythonExecutablePath = Profile.Platform == "mt5" ? python.Text.Trim() : string.Empty;
            Profile.WorkerScriptPath = Profile.Platform == "mt5" ? worker.Text.Trim() : string.Empty;
            Profile.TerminalPath = Profile.Platform == "mt5" ? terminal.Text.Trim() : string.Empty;
            RefreshToken = refreshToken.Text;
            try
            {
                if (newProfile && string.IsNullOrWhiteSpace(RefreshToken))
                    throw new InvalidOperationException("新档案必须填写 V4 刷新凭据。");
                BridgeProfileStore.ValidateProfile(Profile, true);
                DialogResult = DialogResult.OK;
                Close();
            }
            catch (Exception error)
            {
                MessageBox.Show(this, Friendly(error.Message), "请检查档案", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void AddRow(string label, Control control)
        {
            int row = fields.RowCount++;
            fields.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Label caption = new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 10, 10, 12) };
            control.Dock = DockStyle.Top;
            control.Margin = new Padding(0, 4, 0, 10);
            fields.Controls.Add(caption, 0, row);
            fields.Controls.Add(control, 1, row);
        }

        private void ApplyPlatformVisibility()
        {
            bool mt5 = string.Equals(platform.SelectedItem as string, "MT5", StringComparison.Ordinal);
            python.Enabled = mt5;
            worker.Enabled = mt5;
            terminal.Enabled = mt5;
        }

        private static TextBox Field() { return new TextBox { Height = 28 }; }

        private static string Friendly(string code)
        {
            switch (code)
            {
                case "bridge_profile_server_uri_invalid": return "实时地址必须是有效的 ws:// 或 wss:// 地址。";
                case "bridge_profile_mt5_path_invalid": return "MT5 档案必须填写三个绝对路径。";
                case "bridge_profile_invalid": return "请完整填写档案名称、终端实例、服务器和交易账号。";
                default: return code;
            }
        }
    }
}
