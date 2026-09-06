using System;
using System.Drawing;
using System.Windows.Forms;
using System.Threading.Tasks;
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
        private readonly TextBox pairingCode = Field();
        private readonly CheckBox autoConnect = new CheckBox();
        private readonly TextBox python = Field();
        private readonly TextBox worker = Field();
        private readonly TextBox terminal = Field();
        private readonly TableLayoutPanel fields = new TableLayoutPanel();
        private readonly bool newProfile;
        private readonly BridgePairingDraftStore pairing;
        private readonly string installationId;
        private bool saving;
        private Button save;
        private Button cancel;

        public ProfileEditorForm(BridgeProfileSettings profileValue, bool isNew,
            BridgePairingDraftStore pairingStore = null, string installation = null, string resumeCode = null)
        {
            if (profileValue == null) throw new ArgumentNullException("profileValue");
            Profile = profileValue;
            newProfile = isNew;
            pairing = pairingStore;
            installationId = installation;
            Text = isNew ? "新增终端档案" : "编辑终端档案";
            StartPosition = FormStartPosition.CenterParent;
            MinimumSize = new Size(620, 590);
            Size = new Size(700, 700);
            Font = new Font("Microsoft YaHei UI", 9F);

            platform.DropDownStyle = ComboBoxStyle.DropDownList;
            platform.Items.AddRange(new object[] { "MT5", "MT4" });
            platform.SelectedIndexChanged += delegate { ApplyPlatformVisibility(); };
            pairingCode.UseSystemPasswordChar = true;
            pairingCode.Text = resumeCode ?? string.Empty;
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
            if (isNew)
            {
                AddRow("网页配对码", pairingCode);
                AddRow("", new Label { AutoSize = true, MaximumSize = new Size(440, 0),
                    Text = "在交易实验室的“量见智桥”页面生成并复制。网络中断后可重新打开本窗口继续配对。" });
            }
            AddRow("", autoConnect);
            AddRow("Python 可执行文件", python);
            AddRow("MT5 Worker 脚本", worker);
            AddRow("terminal64.exe", terminal);

            FlowLayoutPanel footer = new FlowLayoutPanel
            {
                Dock = DockStyle.Bottom, Height = 58, FlowDirection = FlowDirection.RightToLeft,
                Padding = new Padding(12)
            };
            save = new Button { Text = isNew ? "配对并保存" : "保存", DialogResult = DialogResult.None, Width = 120, Height = 36 };
            cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Width = 90, Height = 36 };
            save.Click += async delegate { await SaveAndClose(); };
            FormClosing += delegate(object sender, FormClosingEventArgs args) { if (saving) args.Cancel = true; };
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
        private async Task SaveAndClose()
        {
            if (saving) return;
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
            try
            {
                BridgeProfileStore.ValidateProfile(Profile, true);
                if (newProfile)
                {
                    string code = pairingCode.Text.Trim();
                    if (pairing == null) throw new InvalidOperationException("bridge_pairing_unavailable");
                    saving = true;
                    fields.Enabled = false;
                    save.Enabled = false;
                    cancel.Enabled = false;
                    save.Text = "正在配对…";
                    Profile = await Task.Run(() => pairing.Pair(Profile, installationId, code));
                }
                saving = false;
                DialogResult = DialogResult.OK;
                Close();
            }
            catch (Exception error)
            {
                MessageBox.Show(this, Friendly(error.Message), "请检查档案", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            finally
            {
                saving = false;
                fields.Enabled = true;
                save.Enabled = true;
                cancel.Enabled = true;
                save.Text = newProfile ? "配对并保存" : "保存";
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
                case "bridge_pairing_code_invalid": return "请粘贴网页生成的完整配对码。";
                case "bridge_pairing_server_changed": return "此配对码已用于原服务地址。请恢复原地址，或生成新码后再配对。";
                case "bridge_pairing_exchange_failed": return "暂未确认配对结果。请检查网络后重试；若配对码已过期或撤销，请从网页重新生成。";
                case "bridge_pairing_draft_unavailable": return "无法读取已保存的配对请求。请使用原 Windows 用户重试，不要删除现有档案。";
                default: return "未能保存档案，请检查填写内容及本地文件访问权限后重试。";
            }
        }
    }
}
