using System;
using System.Collections.Generic;
using System.Drawing;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Compatibility;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Terminal;
using Liangjian.BridgeV4.Update;

namespace Liangjian.BridgeV4.App
{
    internal sealed class MainForm : Form
    {
        private readonly object stateGate = new object();
        private readonly HashSet<string> starting = new HashSet<string>(StringComparer.Ordinal);
        private readonly HashSet<string> cancelledStarts = new HashSet<string>(StringComparer.Ordinal);
        private readonly Dictionary<string, string> operationErrors = new Dictionary<string, string>(StringComparer.Ordinal);
        private readonly string dataRoot;
        private readonly BridgeProfileStore profileStore;
        private readonly TerminalSessionHost terminalHost;
        private readonly BridgeProfileConnectionManager connections;
        private readonly BridgeUpdateService updates;
        private readonly string installRoot;
        private LegacyLaunchRequest launchRequest;
        private readonly ListView profileList = new ListView();
        private readonly Label summary = new Label();
        private readonly Label detail = new Label();
        private readonly Button addButton = ActionButton("新增档案");
        private readonly Button editButton = ActionButton("编辑");
        private readonly Button connectButton = ActionButton("连接");
        private readonly Button disconnectButton = ActionButton("断开");
        private readonly Button deleteButton = ActionButton("删除");
        private readonly System.Windows.Forms.Timer refreshTimer = new System.Windows.Forms.Timer();
        private BridgeProfileCatalog catalog;
        private bool configurationAvailable;
        private bool legacyReadyWritten;
        private volatile bool updateActivationStarted;

        public MainForm()
            : this(new LegacyLaunchRequest())
        {
        }

        public MainForm(LegacyLaunchRequest startupRequest)
        {
            if (startupRequest == null) throw new ArgumentNullException("startupRequest");
            launchRequest = startupRequest;
            Text = "量见智桥 V4";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(820, 520);
            Size = new Size(1040, 650);
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            BackColor = Color.FromArgb(247, 249, 252);

            dataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Liangjian", "BridgeV4");
            profileStore = new BridgeProfileStore(Path.Combine(dataRoot, "profiles.json"),
                new CurrentUserSecretProtector());
            try
            {
                catalog = profileStore.LoadOrCreate();
                if (!File.Exists(profileStore.FilePath)) profileStore.Save(catalog);
                configurationAvailable = true;
            }
            catch (Exception error)
            {
                catalog = new BridgeProfileCatalog { InstallationId = "configuration-unavailable" };
                configurationAvailable = false;
                operationErrors["configuration"] = SafeError(error);
            }

            terminalHost = new TerminalSessionHost(TerminalSessionHost.DefaultPipeName);
            connections = new BridgeProfileConnectionManager(terminalHost, profileStore,
                catalog.InstallationId, dataRoot,
                new HttpBridgeSessionTokenProvider(catalog.InstallationId));
            string detectedInstallRoot;
            if (BridgeInstallLayout.TryResolve(AppDomain.CurrentDomain.BaseDirectory, out detectedInstallRoot))
            {
                installRoot = detectedInstallRoot;
                updates = new BridgeUpdateService(installRoot, dataRoot, "4.0.0.0");
            }
            BuildLayout(RuntimePrerequisite.Detect());

            terminalHost.SessionsChanged += OnRuntimeChanged;
            terminalHost.HostError += OnTerminalHostError;
            connections.StateChanged += OnRuntimeChanged;
            terminalHost.Start();

            refreshTimer.Interval = 1000;
            refreshTimer.Tick += delegate { RefreshProfiles(); CheckForUpdates(); };
            refreshTimer.Start();
        }

        protected override void OnShown(EventArgs eventArgs)
        {
            base.OnShown(eventArgs);
            if (launchRequest.StartMinimized) WindowState = FormWindowState.Minimized;
            RefreshProfiles();
            if (!configurationAvailable)
            {
                MessageBox.Show(this,
                    "档案配置无法读取。为避免覆盖现有配置，本次不会自动重建文件。\r\n\r\n" + operationErrors["configuration"],
                    "量见智桥", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            foreach (BridgeProfileSettings profile in catalog.Profiles)
                if (profile.AutoConnect) StartProfile(profile);
        }

        protected override void OnFormClosed(FormClosedEventArgs eventArgs)
        {
            refreshTimer.Stop();
            connections.StateChanged -= OnRuntimeChanged;
            terminalHost.SessionsChanged -= OnRuntimeChanged;
            terminalHost.HostError -= OnTerminalHostError;
            connections.Dispose();
            terminalHost.Dispose();
            base.OnFormClosed(eventArgs);
        }

        private void BuildLayout(RuntimeStatus runtime)
        {
            TableLayoutPanel root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(24),
                ColumnCount = 1,
                RowCount = 6
            };
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            TableLayoutPanel heading = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2 };
            heading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            heading.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            Panel titlePanel = new Panel { Dock = DockStyle.Top, Height = 58 };
            Label title = new Label { AutoSize = true, Font = new Font(Font.FontFamily, 18F, FontStyle.Bold), Text = "量见智桥" };
            Label subtitle = new Label { AutoSize = true, Location = new Point(2, 36), ForeColor = Color.DimGray,
                Text = "连接本地 MT4 / MT5，提供数据并执行服务器下发的确定性指令" };
            titlePanel.Controls.Add(title);
            titlePanel.Controls.Add(subtitle);
            heading.Controls.Add(titlePanel, 0, 0);
            Label runtimeBadge = new Label
            {
                AutoSize = true,
                Padding = new Padding(10, 7, 10, 7),
                Anchor = AnchorStyles.Top | AnchorStyles.Right,
                Text = runtime.Supported ? ".NET 4.8 运行正常" : "需要 .NET Framework 4.8",
                BackColor = runtime.Supported ? Color.Honeydew : Color.MistyRose,
                ForeColor = runtime.Supported ? Color.DarkGreen : Color.DarkRed
            };
            heading.Controls.Add(runtimeBadge, 1, 0);
            root.Controls.Add(heading, 0, 0);

            summary.AutoSize = true;
            summary.Margin = new Padding(0, 14, 0, 10);
            summary.ForeColor = Color.FromArgb(65, 75, 90);
            root.Controls.Add(summary, 0, 1);

            FlowLayoutPanel actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top, Margin = new Padding(0, 0, 0, 12) };
            actions.Controls.Add(addButton);
            actions.Controls.Add(editButton);
            actions.Controls.Add(connectButton);
            actions.Controls.Add(disconnectButton);
            actions.Controls.Add(deleteButton);
            root.Controls.Add(actions, 0, 2);

            profileList.Dock = DockStyle.Fill;
            profileList.View = View.Details;
            profileList.FullRowSelect = true;
            profileList.HideSelection = false;
            profileList.MultiSelect = false;
            profileList.BorderStyle = BorderStyle.FixedSingle;
            profileList.Columns.Add("档案", 180);
            profileList.Columns.Add("平台", 65);
            profileList.Columns.Add("交易账户", 105);
            profileList.Columns.Add("服务器", 190);
            profileList.Columns.Add("终端", 90);
            profileList.Columns.Add("服务器连接", 110);
            profileList.Columns.Add("自动连接", 80);
            profileList.SelectedIndexChanged += delegate { UpdateSelection(); };
            profileList.DoubleClick += delegate { EditSelected(); };
            root.Controls.Add(profileList, 0, 3);

            detail.AutoSize = true;
            detail.MaximumSize = new Size(930, 0);
            detail.Margin = new Padding(0, 12, 0, 10);
            detail.ForeColor = Color.FromArgb(92, 102, 116);
            root.Controls.Add(detail, 0, 4);

            Label boundary = new Label
            {
                AutoSize = true,
                ForeColor = Color.DimGray,
                Text = "删除只移除本地档案配置；不会关闭交易终端，也不会删除 SQLite 命令账本、未确认回执或服务端历史。"
            };
            root.Controls.Add(boundary, 0, 5);

            addButton.Click += delegate { AddProfile(); };
            editButton.Click += delegate { EditSelected(); };
            connectButton.Click += delegate { BridgeProfileSettings profile = SelectedProfile(); if (profile != null) StartProfile(profile); };
            disconnectButton.Click += delegate { BridgeProfileSettings profile = SelectedProfile(); if (profile != null) StopProfile(profile.ProfileId); };
            deleteButton.Click += delegate { DeleteSelected(); };

            Controls.Add(root);
            UpdateSelection();
        }

        private void TryWriteLegacyReadySignal()
        {
            if (legacyReadyWritten || string.IsNullOrEmpty(launchRequest.ReadyFile)
                || !configurationAvailable) return;
            List<string> running = new List<string>();
            foreach (BridgeProfileSettings profile in catalog.Profiles)
            {
                BridgeProfileConnectionSnapshot state = connections.Snapshot(profile);
                if (state.State == "active" && state.TerminalState == "connected")
                    running.Add(profile.TerminalInstanceId);
            }
            if (running.Count == 0) return;
            foreach (string expected in launchRequest.ExpectedTerminalInstanceIds)
                if (!running.Contains(expected)) return;
            try
            {
                LegacyLauncherContract.WriteReadySignal(launchRequest.ReadyFile, "4.0.0.0", running);
                legacyReadyWritten = true;
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (InvalidDataException) { }
        }

        private void AddProfile()
        {
            if (!configurationAvailable) return;
            BridgePairingDraftStore pairing = new BridgePairingDraftStore(Path.Combine(dataRoot, "pairing.pending"),
                new CurrentUserSecretProtector(), profileStore, new BridgePairingClient());
            BridgePairingDraft pending;
            try
            {
                pending = pairing.Load(catalog.InstallationId);
                if (pending != null && pending.Redeemed && catalog.Profiles.Exists(item => item.ProfileId == pending.Profile.ProfileId))
                {
                    pairing.ClearCompleted(catalog.InstallationId, pending.Profile.ProfileId);
                    pending = null;
                }
            }
            catch (Exception)
            {
                MessageBox.Show(this, "无法读取待配对记录。请确认仍在使用原 Windows 用户，并检查本地配置目录的访问权限。现有档案未修改。",
                    "配对记录不可用", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            BridgeProfileSettings profile = new BridgeProfileSettings
            {
                ProfileId = "profile-" + Guid.NewGuid().ToString("N"), Platform = "mt5",
                DisplayName = "新终端档案", AutoConnect = false
            };
            if (pending != null) profile = pending.Profile.Clone();
            using (ProfileEditorForm editor = new ProfileEditorForm(profile, true, pairing, catalog.InstallationId,
                pending == null ? null : pending.Code, WindowsTerminalDiscovery.Create(terminalHost)))
            {
                if (editor.ShowDialog(this) != DialogResult.OK) return;
                try
                {
                    BridgeProfileCatalog candidate = CopyCatalog();
                    candidate.Profiles.Add(editor.Profile);
                    profileStore.Save(candidate);
                    catalog = candidate;
                    RefreshProfiles();
                    SelectProfile(editor.Profile.ProfileId);
                    try { pairing.ClearCompleted(catalog.InstallationId, editor.Profile.ProfileId); }
                    catch (Exception)
                    {
                        MessageBox.Show(this, "档案已保存，但待配对记录暂未清理。下次新增档案时会再次尝试清理，无需重新配对。",
                            "档案已保存", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                }
                catch (Exception)
                {
                    MessageBox.Show(this, "配对信息已保留，但档案尚未保存。请检查是否重复添加了同一终端，以及本地配置目录的写入权限，再点击“新增档案”继续。",
                        "档案未保存", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            }
        }

        private void EditSelected()
        {
            BridgeProfileSettings current = SelectedProfile();
            if (current == null || !configurationAvailable) return;
            BridgeProfileSettings edited = current.Clone();
            using (ProfileEditorForm editor = new ProfileEditorForm(edited, false,
                terminalDiscovery: WindowsTerminalDiscovery.Create(terminalHost)))
            {
                if (editor.ShowDialog(this) != DialogResult.OK) return;
                try
                {
                    bool routeChanged = !current.SameRoute(editor.Profile);
                    if (routeChanged) editor.Profile.ProfileId = "profile-" + Guid.NewGuid().ToString("N");
                    int index = catalog.Profiles.IndexOf(current);
                    BridgeProfileCatalog candidate = CopyCatalog();
                    candidate.Profiles[index] = editor.Profile;
                    profileStore.Save(candidate);
                    if (routeChanged) StopProfile(current.ProfileId);
                    catalog = candidate;
                    RefreshProfiles();
                    SelectProfile(editor.Profile.ProfileId);
                }
                catch (Exception error) { ShowOperationError(error); }
            }
        }

        private void DeleteSelected()
        {
            BridgeProfileSettings profile = SelectedProfile();
            if (profile == null || !configurationAvailable) return;
            if (MessageBox.Show(this, "确定移除档案“" + profile.DisplayName + "”吗？本地安全账本和缓存会保留。",
                "移除终端档案", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
            try
            {
                BridgeProfileCatalog candidate = CopyCatalog();
                candidate.Profiles.RemoveAt(catalog.Profiles.IndexOf(profile));
                profileStore.Save(candidate);
                StopProfile(profile.ProfileId);
                catalog = candidate;
                RefreshProfiles();
            }
            catch (Exception error) { ShowOperationError(error); }
        }

        private void StartProfile(BridgeProfileSettings profile)
        {
            lock (stateGate)
            {
                if (starting.Contains(profile.ProfileId)) return;
                cancelledStarts.Remove(profile.ProfileId);
                starting.Add(profile.ProfileId);
                operationErrors.Remove(profile.ProfileId);
            }
            RefreshProfiles();
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    bool cancelled;
                    lock (stateGate) cancelled = cancelledStarts.Contains(profile.ProfileId);
                    if (!cancelled) connections.Start(profile);
                    lock (stateGate) cancelled = cancelledStarts.Contains(profile.ProfileId);
                    if (cancelled) connections.Stop(profile.ProfileId);
                }
                catch (Exception error)
                {
                    lock (stateGate) operationErrors[profile.ProfileId] = SafeError(error);
                }
                finally
                {
                    lock (stateGate)
                    {
                        starting.Remove(profile.ProfileId);
                        cancelledStarts.Remove(profile.ProfileId);
                    }
                    SafeBeginRefresh();
                }
            });
        }

        private void StopProfile(string profileId)
        {
            lock (stateGate)
            {
                if (starting.Contains(profileId)) cancelledStarts.Add(profileId);
            }
            connections.Stop(profileId);
            RefreshProfiles();
        }

        private void RefreshProfiles()
        {
            if (IsDisposed) return;
            string selected = SelectedProfileId();
            profileList.BeginUpdate();
            try
            {
                profileList.Items.Clear();
                foreach (BridgeProfileSettings profile in catalog.Profiles)
                {
                    BridgeProfileConnectionSnapshot state = connections.Snapshot(profile);
                    bool busy;
                    string localError;
                    lock (stateGate)
                    {
                        busy = starting.Contains(profile.ProfileId);
                        operationErrors.TryGetValue(profile.ProfileId, out localError);
                    }
                    ListViewItem item = new ListViewItem(profile.DisplayName) { Tag = profile.ProfileId };
                    item.SubItems.Add(profile.Platform.ToUpperInvariant());
                    item.SubItems.Add(profile.Login);
                    item.SubItems.Add(profile.BrokerServer);
                    item.SubItems.Add(TerminalText(state.TerminalState));
                    item.SubItems.Add(busy ? "正在启动" : ConnectionText(state.State));
                    item.SubItems.Add(profile.AutoConnect ? "是" : "否");
                    if (!string.IsNullOrEmpty(localError) || !string.IsNullOrEmpty(state.LastErrorCode))
                        item.ForeColor = Color.DarkRed;
                    profileList.Items.Add(item);
                }
            }
            finally { profileList.EndUpdate(); }
            if (selected != null) SelectProfile(selected);

            int terminalCount = terminalHost.Snapshot().Count;
            summary.Text = catalog.Profiles.Count + " 个终端档案  ·  " + terminalCount
                + " 个 MT4 适配器在线  ·  每个档案独立连接与独立 SQLite"
                + UpdateSummary();
            UpdateSelection();
            TryWriteLegacyReadySignal();
        }

        private void CheckForUpdates()
        {
            if (updates == null || updateActivationStarted || IsDisposed) return;
            PendingBridgeRelease newest = null;
            foreach (PendingBridgeRelease release in connections.ReadObservedReleases())
            {
                if (newest == null || release.RestartNotBeforeUtcMsc > newest.RestartNotBeforeUtcMsc
                    || (release.RestartNotBeforeUtcMsc == newest.RestartNotBeforeUtcMsc
                        && string.CompareOrdinal(release.ReleaseId, newest.ReleaseId) > 0)) newest = release;
            }
            if (newest != null) updates.Observe(newest);
            PendingBridgeRelease ready = updates.ReadyRelease(UtcNowMsc(), connections.ReadUpdateActivity());
            if (ready == null) return;
            updateActivationStarted = true;
            ThreadPool.QueueUserWorkItem(delegate { ActivateUpdate(ready); });
        }

        private void ActivateUpdate(PendingBridgeRelease release)
        {
            bool quiesced = false;
            try
            {
                UpdateActivitySnapshot activity;
                quiesced = connections.TryQuiesceForUpdate(15000, out activity);
                PendingBridgeRelease ready = quiesced ? updates.ReadyRelease(UtcNowMsc(), activity) : null;
                if (ready == null || ready.ReleaseId != release.ReleaseId
                    || !updates.MarkActivating(release.ReleaseId))
                {
                    if (quiesced) connections.ResumeAfterUpdate();
                    updateActivationStarted = false;
                    return;
                }
                string launcher = Path.Combine(AppDomain.CurrentDomain.BaseDirectory,
                    "launcher", "LiangjianBridge.Launcher.exe");
                if (!File.Exists(launcher)) launcher = Path.Combine(installRoot, "LiangjianBridge.Launcher.exe");
                if (!File.Exists(launcher)) throw new FileNotFoundException("bridge_update_launcher_missing", launcher);
                ProcessStartInfo start = new ProcessStartInfo(launcher,
                    "--activate " + release.Version + " --release-id " + release.ReleaseId
                    + " --wait-pid " + Process.GetCurrentProcess().Id.ToString())
                {
                    WorkingDirectory = installRoot,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                start.EnvironmentVariables["LIANGJIAN_BRIDGE_INSTALL_ROOT"] = installRoot;
                Process process = Process.Start(start);
                if (process == null) throw new InvalidOperationException("bridge_update_launcher_failed");
                SafeBeginClose();
            }
            catch (Exception error)
            {
                try { updates.MarkActivationLaunchFailed(release.ReleaseId, UtcNowMsc(), SafeError(error)); }
                catch (Exception) { }
                if (quiesced)
                {
                    try { connections.ResumeAfterUpdate(); }
                    catch (ObjectDisposedException) { }
                }
                updateActivationStarted = false;
                SafeBeginRefresh();
            }
        }

        private void UpdateSelection()
        {
            BridgeProfileSettings profile = SelectedProfile();
            bool selected = profile != null;
            editButton.Enabled = selected && configurationAvailable;
            connectButton.Enabled = selected && configurationAvailable;
            disconnectButton.Enabled = selected;
            deleteButton.Enabled = selected && configurationAvailable;
            addButton.Enabled = configurationAvailable;
            if (!selected)
            {
                detail.Text = configurationAvailable
                    ? "选择一个档案查看连接状态；双击可编辑。"
                    : "配置文件读取失败，本次启动已进入只读保护状态。";
                return;
            }
            BridgeProfileConnectionSnapshot state = connections.Snapshot(profile);
            string error;
            lock (stateGate) operationErrors.TryGetValue(profile.ProfileId, out error);
            if (string.IsNullOrEmpty(error)) error = state.LastErrorCode;
            detail.Text = "实例：" + profile.TerminalInstanceId + "  ·  实时地址：" + profile.ServerUri
                + (string.IsNullOrEmpty(error) ? string.Empty : "  ·  最近错误：" + error);
        }

        private BridgeProfileSettings SelectedProfile()
        {
            string id = SelectedProfileId();
            if (id == null) return null;
            foreach (BridgeProfileSettings profile in catalog.Profiles) if (profile.ProfileId == id) return profile;
            return null;
        }

        private string SelectedProfileId()
        {
            return profileList.SelectedItems.Count == 0 ? null : profileList.SelectedItems[0].Tag as string;
        }

        private void SelectProfile(string profileId)
        {
            foreach (ListViewItem item in profileList.Items)
                if (string.Equals(item.Tag as string, profileId, StringComparison.Ordinal)) { item.Selected = true; item.Focused = true; break; }
        }

        private BridgeProfileCatalog CopyCatalog()
        {
            return new BridgeProfileCatalog
            {
                SchemaVersion = catalog.SchemaVersion,
                InstallationId = catalog.InstallationId,
                Profiles = new List<BridgeProfileSettings>(catalog.Profiles)
            };
        }

        private void OnRuntimeChanged(object sender, EventArgs eventArgs) { SafeBeginRefresh(); }

        private void OnTerminalHostError(object sender, TerminalHostErrorEventArgs eventArgs)
        {
            lock (stateGate) operationErrors["terminal-host"] = SafeError(eventArgs.Error);
            SafeBeginRefresh();
        }

        private void SafeBeginRefresh()
        {
            if (!IsHandleCreated || IsDisposed) return;
            try { BeginInvoke((MethodInvoker)RefreshProfiles); }
            catch (InvalidOperationException) { }
        }

        private void SafeBeginClose()
        {
            if (!IsHandleCreated || IsDisposed) return;
            try { BeginInvoke((MethodInvoker)Close); }
            catch (InvalidOperationException) { }
        }

        private void ShowOperationError(Exception error)
        {
            MessageBox.Show(this, SafeError(error), "操作失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        private static Button ActionButton(string text)
        {
            return new Button { Text = text, AutoSize = true, MinimumSize = new Size(88, 36), Margin = new Padding(0, 0, 8, 0) };
        }

        private static string SafeError(Exception error)
        {
            string value = error == null ? "bridge_operation_failed" : error.Message;
            return string.IsNullOrWhiteSpace(value) ? "bridge_operation_failed" : value;
        }

        private static string ConnectionText(string state)
        {
            switch (state)
            {
                case "active": return "已连接";
                case "awaiting_welcome": return "正在鉴权";
                case "backoff": return "等待重连";
                case "disconnected": return "准备连接";
                case "update_wait": return "等待更新";
                default: return "已断开";
            }
        }

        private string UpdateSummary()
        {
            if (updates == null) return string.Empty;
            BridgeUpdateSnapshot state = updates.Snapshot();
            switch (state.State)
            {
                case "downloading": return "  ·  更新包下载中";
                case "staged": return "  ·  更新已就绪，等待安全重启时间";
                case "activating": return "  ·  正在应用更新";
                case "failed": return "  ·  更新失败：" + state.ErrorCode;
                default: return string.Empty;
            }
        }

        private static string TerminalText(string state) { return state == "connected" ? "已连接" : "未连接"; }

        private static long UtcNowMsc()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }
    }
}
