using System;
using System.Drawing;
using System.Windows.Forms;
using System.Threading.Tasks;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Terminal;
using System.IO;

namespace Liangjian.BridgeV4.App
{
    internal sealed class ProfileEditorForm : Form
    {
        private readonly TextBox displayName = Field();
        private readonly ComboBox platform = new ComboBox();
        private readonly Button installMt4 = new Button { Text = "安装 MT4 适配器…", AutoSize = true, Height = 34 };
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
        private readonly InstallationAuthorizationStore authorization;
        private readonly string installationId;
        private readonly Func<BridgeProfileSettings, bool> profileAlreadyExists;
        private bool saving;
        private string identifiedPlatform;
        private string identifiedPath;
        private bool identifiedPortable;
        private Button save;
        private Button cancel;
        private readonly TerminalDiscovery discovery;
        private readonly ComboBox candidates = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList };
        private readonly Label discoveryStatus = new Label { AutoSize = true, MaximumSize = new Size(440, 0) };
        private readonly CheckBox portable = new CheckBox { Text = "便携模式（/portable）", AutoSize = true };

        public ProfileEditorForm(BridgeProfileSettings profileValue, bool isNew,
            BridgePairingDraftStore pairingStore = null, string installation = null, string resumeCode = null,
            TerminalDiscovery terminalDiscovery = null, InstallationAuthorizationStore installationAuthorization = null,
            Func<BridgeProfileSettings, bool> profileAlreadyExists = null)
        {
            if (profileValue == null) throw new ArgumentNullException("profileValue");
            Profile = profileValue;
            identifiedPath = profileValue.TerminalPath;
            identifiedPortable = profileValue.Mt5Portable;
            identifiedPlatform = profileValue.Platform;
            this.profileAlreadyExists = profileAlreadyExists;
            newProfile = isNew;
            pairing = pairingStore;
            authorization = installationAuthorization;
            installationId = installation;
            discovery = terminalDiscovery;
            Text = isNew ? "新增终端档案" : "编辑终端档案";
            StartPosition = FormStartPosition.CenterParent;
            MinimumSize = new Size(620, 590);
            Size = new Size(700, 700);
            Font = new Font("Microsoft YaHei UI", 9F);

            platform.DropDownStyle = ComboBoxStyle.DropDownList;
            platform.Items.AddRange(new object[] { "MT5", "MT4" });
            platform.SelectedIndexChanged += async delegate
            {
                candidates.Items.Clear();
                string selectedPlatform = (platform.SelectedItem as string) == "MT4" ? "mt4" : "mt5";
                if (selectedPlatform != identifiedPlatform) InvalidateRecognition();
                discoveryStatus.Text = "先刷新列表，再选择已启动的终端。不会启动终端或切换其账号。";
                ApplyPlatformVisibility();
                if (IsHandleCreated && Visible) await Discover(false);
            };
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
            installMt4.Click += delegate
            {
                using (Mt4SetupForm form = new Mt4SetupForm(System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory,
                    "adapters", "mt4", "BridgeV4MT4.ex4"))) form.ShowDialog(this);
            };
            AddRow("首次使用 MT4", installMt4);
            if (discovery != null)
            {
                terminalId.ReadOnly = broker.ReadOnly = login.ReadOnly = true;
                candidates.SelectedIndexChanged += async delegate
                {
                    if (saving) return;
                    DiscoveredTerminal selected = candidates.SelectedItem as DiscoveredTerminal;
                    if (selected == null) return;
                    InvalidateRecognition();
                    if (selected.Platform == "mt5")
                    {
                        terminal.Text = selected.TerminalPath ?? string.Empty;
                        portable.Checked = selected.Portable;
                    }
                    await Discover(true);
                };
                AddRow("已启动终端", candidates);
                FlowLayoutPanel actions = new FlowLayoutPanel { AutoSize = true, WrapContents = true };
                Button refresh = new Button { Text = "刷新列表", Width = 110, Height = 44 };
                Button identify = new Button { Text = "识别并填入", Width = 120, Height = 44 };
                refresh.Click += async delegate { await Discover(false); };
                identify.Click += async delegate { await Discover(true); };
                actions.Controls.Add(refresh);
                actions.Controls.Add(identify);
                Button locate = new Button { Text = "选择路径/快捷方式", Width = 150, Height = 44 };
                locate.Click += delegate
                {
                    using (OpenFileDialog picker = new OpenFileDialog { Filter = "交易终端或快捷方式|*.exe;*.lnk", CheckFileExists = true })
                        if (picker.ShowDialog(this) == DialogResult.OK) SelectLocation(picker.FileName);
                };
                actions.Controls.Add(locate);
                AddRow("", actions);
                AddRow("", discoveryStatus);
                candidates.AccessibleName = "选择已启动的交易终端";
                AllowDrop = true;
                DragEnter += delegate(object sender, DragEventArgs args)
                {
                    args.Effect = !saving && args.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;
                };
                DragDrop += delegate(object sender, DragEventArgs args)
                {
                    string[] paths = args.Data.GetData(DataFormats.FileDrop) as string[];
                    if (!saving && paths != null && paths.Length == 1) SelectLocation(paths[0]);
                    else discoveryStatus.Text = "请一次拖入一个终端程序、文件夹或快捷方式。";
                };
            }
            AddRow("终端实例 ID", terminalId);
            AddRow("经纪商服务器", broker);
            AddRow("交易账号", login);
            AddRow("Bridge 实时地址", serverUri);
            serverUri.ReadOnly = authorization != null;
            if (isNew && authorization == null)
            {
                AddRow("网页配对码", pairingCode);
                AddRow("", new Label { AutoSize = true, MaximumSize = new Size(440, 0),
                    Text = "在交易实验室的“量见智桥”页面生成并复制。网络中断后可重新打开本窗口继续配对。" });
            }
            AddRow("", autoConnect);
            python.ReadOnly = true;
            worker.ReadOnly = true;
            AddRow("terminal64.exe", terminal);
            AddRow("", portable);

            FlowLayoutPanel footer = new FlowLayoutPanel
            {
                Dock = DockStyle.Bottom, Height = 58, FlowDirection = FlowDirection.RightToLeft,
                Padding = new Padding(12)
            };
            save = new Button { Text = isNew && authorization == null ? "配对并保存" : "保存", DialogResult = DialogResult.None, Width = 120, Height = 36 };
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
            autoConnect.Checked = newProfile || Profile.AutoConnect;
            python.Text = Profile.PythonExecutablePath ?? string.Empty;
            worker.Text = Profile.WorkerScriptPath ?? string.Empty;
            terminal.Text = Profile.TerminalPath ?? string.Empty;
            portable.Checked = Profile.Mt5Portable;
            ApplyPlatformVisibility();
            Shown += async delegate { await Discover(false); };
        }

        public BridgeProfileSettings Profile { get; private set; }
        private void InvalidateRecognition()
        {
            terminalId.Clear(); broker.Clear(); login.Clear();
            Profile.Mt5DataPath = string.Empty;
            identifiedPath = null; identifiedPlatform = null;
        }
        private void SelectLocation(string path)
        {
            try
            {
                string targetPlatform = (platform.SelectedItem as string) == "MT4" ? "mt4" : "mt5";
                TerminalLocation location = TerminalLocation.Resolve(path, targetPlatform);
                InvalidateRecognition();
                terminal.Text = location.ExecutablePath;
                portable.Checked = location.Portable;
                candidates.Items.Clear();
                foreach (DiscoveredTerminal item in discovery.List(targetPlatform))
                {
                    candidates.Items.Add(item);
                    if (string.Equals(item.TerminalPath, location.ExecutablePath, StringComparison.OrdinalIgnoreCase))
                        candidates.SelectedItem = item;
                }
                discoveryStatus.Text = candidates.SelectedItem == null
                    ? "路径已选择。请先打开该终端并登录；MT4 还需加载 EA，然后刷新列表。"
                    : "已定位终端，请点击“识别并填入”核对账户。也可拖入桌面快捷方式。";
            }
            catch (Exception)
            {
                discoveryStatus.Text = "无法定位终端。请选择已安装的终端程序或快捷方式，不支持安装包、压缩包或启动脚本。";
            }
        }
        private async Task Discover(bool identify)
        {
            if (saving || discovery == null) return;
            DiscoveredTerminal selected = candidates.SelectedItem as DiscoveredTerminal;
            string targetPlatform = (platform.SelectedItem as string) == "MT4" ? "mt4" : "mt5";
            if (identify && selected == null && targetPlatform == "mt5" && !string.IsNullOrWhiteSpace(terminal.Text))
            {
                try
                {
                    TerminalLocation location = TerminalLocation.Resolve(terminal.Text.Trim(), "mt5");
                    selected = null;
                    foreach (DiscoveredTerminal candidate in discovery.List("mt5"))
                        if (string.Equals(candidate.TerminalPath, location.ExecutablePath, StringComparison.OrdinalIgnoreCase)) selected = candidate;
                    terminal.Text = location.ExecutablePath;
                    if (location.Portable) portable.Checked = true;
                }
                catch (Exception) { discoveryStatus.Text = "路径无效，请选择已安装的终端程序或快捷方式。"; return; }
            }
            if (identify && selected == null)
            {
                discoveryStatus.Text = "请先刷新列表并选择一个终端。";
                candidates.Focus();
                return;
            }
            if (identify && targetPlatform == "mt5" && !string.IsNullOrWhiteSpace(terminal.Text))
            {
                try
                {
                    TerminalLocation location = TerminalLocation.Resolve(terminal.Text.Trim(), "mt5");
                    if (!string.Equals(location.ExecutablePath, selected.TerminalPath, StringComparison.OrdinalIgnoreCase))
                    { discoveryStatus.Text = "填写路径与列表终端不同，请选择路径后重新识别。"; return; }
                }
                catch (Exception) { discoveryStatus.Text = "终端路径无效，请重新选择。"; return; }
            }
            string pythonPath = python.Text.Trim(), workerPath = worker.Text.Trim();
            bool portableMode = portable.Checked;
            saving = true;
            fields.Enabled = save.Enabled = cancel.Enabled = false;
            discoveryStatus.Text = identify ? "正在读取所选终端的当前账号…" : "正在查找已启动的终端…";
            try
            {
                if (!identify)
                {
                    var found = await Task.Run(() => discovery.List(targetPlatform));
                    candidates.Items.Clear();
                    foreach (DiscoveredTerminal item in found) candidates.Items.Add(item);
                    // A list is not a selection: never silently choose one of several terminals.
                    discoveryStatus.Text = found.Count == 0
                        ? (targetPlatform == "mt4" ? "未找到在线 MT4 EA。请在 MT4 加载桥接 EA 后刷新。"
                            : "未找到可读取的 MT5。请先打开 MT5 并登录账号，再刷新列表。")
                        : "选择终端后将自动读取账号，请核对后保存。";
                }
                else
                {
                    DiscoveredTerminal result = await Task.Run(() => discovery.Identify(selected, pythonPath, workerPath, portableMode));
                    // Preserve an existing instance identity when recognizing the same MT5 path.
                    bool sameMt5 = result.Platform == "mt5" && Profile.Mt5Portable == result.Portable
                        && string.Equals(Profile.Mt5DataPath, result.DataPath, StringComparison.OrdinalIgnoreCase)
                        && !string.IsNullOrWhiteSpace(Profile.TerminalPath)
                        && string.Equals(Path.GetFullPath(Profile.TerminalPath), result.TerminalPath, StringComparison.OrdinalIgnoreCase)
                        && !string.IsNullOrWhiteSpace(Profile.TerminalInstanceId);
                    terminalId.Text = sameMt5 ? Profile.TerminalInstanceId : result.TerminalInstanceId;
                    broker.Text = result.BrokerServer;
                    login.Text = result.Login;
                    displayName.Text = result.Login;
                    terminal.Text = result.TerminalPath ?? string.Empty;
                    Profile.Mt5DataPath = result.DataPath ?? string.Empty;
                    identifiedPath = result.TerminalPath;
                    identifiedPortable = result.Portable;
                    identifiedPlatform = result.Platform;
                    discoveryStatus.Text = "已填入 " + result.Login + " · " + result.BrokerServer
                        + "。请核对后保存；此结果不代表桥接已连接。";
                }
            }
            catch (Exception error)
            {
                discoveryStatus.Text = DiscoveryError(error.Message);
            }
            finally
            {
                saving = false;
                fields.Enabled = save.Enabled = cancel.Enabled = true;
                ApplyPlatformVisibility();
            }
        }

        private static string DiscoveryError(string code)
        {
            switch (code)
            {
                case "bridge_discovery_paths_invalid": return "MT5 运行组件未就绪。请从包含 runtime 和 workers 的完整程序目录启动桥接，并确认 MT5 仍在运行。";
                case "bridge_discovery_terminal_changed": return "终端已退出或账号发生变化，请刷新列表后重新识别。原填写内容已保留。";
                case "bridge_discovery_probe_timeout": return "读取超时，请检查 MT5 是否已登录并正常联网，然后重试。";
                default: return "未能识别账号。请确认所选终端已登录，且桥接安装完整，再重试。原填写内容已保留。";
            }
        }

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
            Profile.Mt5Portable = Profile.Platform == "mt5" && portable.Checked;
            if (Profile.Platform != "mt5") Profile.Mt5DataPath = string.Empty;
            try
            {
                if (discovery != null && identifiedPlatform != Profile.Platform)
                    throw new InvalidOperationException("bridge_terminal_recognition_required");
                if (Profile.Platform == "mt5" && (string.IsNullOrWhiteSpace(Profile.Mt5DataPath)
                    || !string.Equals(identifiedPath, Profile.TerminalPath, StringComparison.OrdinalIgnoreCase)
                    || identifiedPortable != Profile.Mt5Portable)) throw new InvalidOperationException("bridge_terminal_recognition_required");
                BridgeProfileStore.ValidateProfile(Profile, true);
                if (newProfile && profileAlreadyExists != null && profileAlreadyExists(Profile))
                    throw new InvalidOperationException("bridge_profile_catalog_duplicate");
                if (newProfile)
                {
                    string code = pairingCode.Text.Trim();
                    if (pairing == null && authorization == null) throw new InvalidOperationException("bridge_pairing_unavailable");
                    saving = true;
                    fields.Enabled = false;
                    save.Enabled = false;
                    cancel.Enabled = false;
                    save.Text = "正在保存授权…";
                    Profile = await Task.Run(() => authorization != null ? authorization.RegisterProfile(Profile) : pairing.Pair(Profile, installationId, code));
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
                if (!IsDisposed)
                {
                    fields.Enabled = true;
                    save.Enabled = true;
                    cancel.Enabled = true;
                    save.Text = newProfile && authorization == null ? "配对并保存" : "保存";
                }
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
            installMt4.Visible = !mt5;
            Control installLabel = fields.GetControlFromPosition(0, fields.GetPositionFromControl(installMt4).Row);
            if (installLabel != null) installLabel.Visible = !mt5;
            python.Enabled = mt5;
            worker.Enabled = mt5;
            terminal.Enabled = mt5;
            portable.Enabled = mt5;
        }

        private static TextBox Field() { return new TextBox { Height = 28 }; }

        private static string Friendly(string code)
        {
            switch (code)
            {
                case "bridge_terminal_recognition_required": return "终端路径或模式发生变化，请先点击“识别并填入”，核对账号后保存。";
                case "bridge_profile_catalog_duplicate": return "该终端已有档案，请编辑现有档案。本次未申请新的终端凭据。";
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
