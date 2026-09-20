using System;
using System.Collections.Generic;
using System.Drawing;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Compatibility;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Terminal;
using Liangjian.BridgeV4.Update;

namespace Liangjian.BridgeV4.App
{
    internal sealed partial class MainForm : Form
    {
        private readonly object stateGate = new object();
        private readonly HashSet<string> starting = new HashSet<string>(StringComparer.Ordinal);
        private readonly HashSet<string> cancelledStarts = new HashSet<string>(StringComparer.Ordinal);
        private readonly Dictionary<string, string> operationErrors = new Dictionary<string, string>(StringComparer.Ordinal);
        private readonly string dataRoot;
        private readonly BridgeProfileStore profileStore;
        private readonly InstallationAuthorizationStore authorization;
        private readonly BridgeClientOptions clientOptions;
        private readonly Button authorizeButton = ActionButton("连接账号");
        private readonly Button revokeButton = ActionButton("退出账号");
        private readonly Label accountStatus = new Label { AutoSize = true, Padding = new Padding(0, 10, 0, 0) };
        private bool accountRequest;
        private bool accountDialogOpen;
        private DateTime nextAccountRefresh = DateTime.MinValue;
        private readonly TerminalSessionHost terminalHost;
        private readonly BridgeProfileConnectionManager connections;
        private readonly BridgeProfileRemovalService removals;
        private readonly BridgeUpdateService updates;
        private readonly string installRoot;
        private LegacyLaunchRequest launchRequest;
        private readonly ListView profileList = new BufferedProfileList();
        private readonly Label summary = new Label();
        private readonly Label detail = new Label();
        private readonly System.Windows.Forms.Timer refreshTimer = new System.Windows.Forms.Timer();
        private BridgeProfileCatalog catalog;
        private bool configurationAvailable;
        private bool legacyReadyWritten;
        private volatile bool updateActivationStarted;
        private bool shutdownRequested;
        private bool removalInProgress;

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
            authorization = new InstallationAuthorizationStore(Path.Combine(dataRoot, "installation.authorization"),
                new CurrentUserSecretProtector(), profileStore, new InstallationAuthorizationClient());
            try { clientOptions = BridgeClientOptions.Load(AppDomain.CurrentDomain.BaseDirectory); }
            catch (Exception) { accountStatus.Text = "服务配置不可用，请使用完整安装包。"; }
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
                new HttpBridgeSessionTokenProvider(catalog.InstallationId, clientOptions == null ? null : clientOptions.ApiBase));
            removals = new BridgeProfileRemovalService(profileStore, new HttpBridgeCredentialRevoker(catalog.InstallationId, clientOptions == null ? null : clientOptions.ApiBase),
                delegate(string profileId) { connections.Stop(profileId); });
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
            refreshTimer.Tick += async delegate { RefreshProfiles(); CheckForUpdates(); await RefreshAccount(); };
            refreshTimer.Start();
        }

        protected override void OnShown(EventArgs eventArgs)
        {
            base.OnShown(eventArgs);
            InitializeTray();
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
                if (profile.AutoConnect && !profile.RemovalPending) StartProfile(profile);
        }

        protected override void OnFormClosing(FormClosingEventArgs eventArgs)
        {
            base.OnFormClosing(eventArgs);
            if (eventArgs.Cancel) return;
            if (KeepRunningOnClose(eventArgs.CloseReason)) { eventArgs.Cancel = true; return; }
            if (removalInProgress || accountRequest || accountDialogOpen)
            {
                eventArgs.Cancel = true;
                explicitExit = false;
                detail.Text = "正在完成账号或设备请求，请稍候再关闭窗口。";
                return;
            }
            shutdownRequested = true;
            refreshTimer.Stop();
            addButton.Enabled = editButton.Enabled = connectButton.Enabled = false;
            disconnectButton.Enabled = deleteButton.Enabled = false;
            try
            {
                connections.Dispose();
                terminalHost.Dispose();
            }
            catch (Exception)
            {
                eventArgs.Cancel = true;
                summary.Text = "正在停止连接，尚未安全退出";
                detail.Text = "档案仍保留锁定。请稍候再次关闭窗口，重试完成清理。";
            }
        }

        protected override void OnFormClosed(FormClosedEventArgs eventArgs)
        {
            DisposeTray();
            refreshTimer.Stop();
            connections.StateChanged -= OnRuntimeChanged;
            terminalHost.SessionsChanged -= OnRuntimeChanged;
            terminalHost.HostError -= OnTerminalHostError;
            refreshTimer.Dispose();
            profileMenu.Dispose();
            accountMenu.Dispose();
            moreMenu.Dispose();
            revokeButton.Dispose();
            permissionTip.Dispose();
            base.OnFormClosed(eventArgs);
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

        private async Task AddProfile(bool forcePairing = false)
        {
            if (removalInProgress || shutdownRequested || accountRequest || accountDialogOpen) return;
            accountDialogOpen = true;
            try { await AddProfileCore(forcePairing); }
            finally { accountDialogOpen = false; }
        }

        private async Task AddProfileCore(bool forcePairing)
        {
            if (!configurationAvailable) return;
            try
            {
                var installed = await Task.Run(() => authorization.ReadView());
                if (!forcePairing && installed != null && installed.Status == "approved") { await AddAuthorizedProfile(); return; }
                if (!forcePairing && clientOptions != null)
                {
                    using (InstallationAuthorizationForm form = new InstallationAuthorizationForm(clientOptions, authorization, catalog.InstallationId))
                        if (form.ShowDialog(this) != DialogResult.OK) return;
                    await AddAuthorizedProfile();
                    return;
                }
            }
            catch (Exception) { MessageBox.Show(this, "无法读取软件授权，请使用原 Windows 用户并检查配置目录。", "授权不可用"); return; }
            BridgePairingDraftStore pairing = new BridgePairingDraftStore(Path.Combine(dataRoot, "pairing.pending"),
                new CurrentUserSecretProtector(), profileStore, new BridgePairingClient(clientOptions == null ? null : clientOptions.ApiBase));
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
                DisplayName = "新终端档案", AutoConnect = true
            };
            ApplyPackagedDefaults(profile);
            if (pending != null) profile = pending.Profile.Clone();
            using (ProfileEditorForm editor = new ProfileEditorForm(profile, true, pairing, catalog.InstallationId,
                pending == null ? null : pending.Code, WindowsTerminalDiscovery.Create(terminalHost),
                profileAlreadyExists: ProfileAlreadyExists))
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

        private void ApplyPackagedDefaults(BridgeProfileSettings profile)
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            if (string.IsNullOrWhiteSpace(profile.PythonExecutablePath)) profile.PythonExecutablePath = Path.Combine(root, "runtime", "python", "python.exe");
            if (string.IsNullOrWhiteSpace(profile.WorkerScriptPath)) profile.WorkerScriptPath = Path.Combine(root, "workers", "mt5", "worker.py");
            if (string.IsNullOrWhiteSpace(profile.ServerUri) && clientOptions != null) profile.ServerUri = clientOptions.RealtimeUri;
        }

        private async Task AddAuthorizedProfile()
        {
            try
            {
                BridgeProfileSettings pending = await Task.Run(() => authorization.ReadPendingProfile());
                if (pending != null && catalog.Profiles.Exists(item => item.ProfileId == pending.ProfileId))
                { authorization.CompleteProfile(pending.ProfileId); pending = null; }
                BridgeProfileSettings profile = pending ?? new BridgeProfileSettings
                { ProfileId = "profile-" + Guid.NewGuid().ToString("N"), Platform = "mt5", DisplayName = "新终端档案", AutoConnect = true };
                ApplyPackagedDefaults(profile);
                using (ProfileEditorForm editor = new ProfileEditorForm(profile, true,
                    terminalDiscovery: WindowsTerminalDiscovery.Create(terminalHost), installationAuthorization: authorization,
                    profileAlreadyExists: ProfileAlreadyExists))
                {
                    if (editor.ShowDialog(this) != DialogResult.OK) return;
                    BridgeProfileCatalog candidate = CopyCatalog();
                    candidate.Profiles.Add(editor.Profile);
                    profileStore.Save(candidate);
                    catalog = candidate;
                    RefreshProfiles();
                    SelectProfile(editor.Profile.ProfileId);
                    nextAccountRefresh = DateTime.MinValue;
                    try { authorization.CompleteProfile(editor.Profile.ProfileId); }
                    catch (Exception)
                    {
                        MessageBox.Show(this, "档案已保存，待完成记录暂未清理。下次新增时会继续清理，无需重新授权。", "档案已保存");
                    }
                }
            }
            catch (Exception)
            {
                MessageBox.Show(this, "档案尚未完成保存，授权请求已保留。请检查网络、重复终端和目录权限，再点击新增档案继续。", "请重试", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private bool ProfileAlreadyExists(BridgeProfileSettings candidate)
        {
            return catalog.Profiles.Exists(item => item.Platform == candidate.Platform
                && string.Equals(item.TerminalInstanceId, candidate.TerminalInstanceId, StringComparison.OrdinalIgnoreCase));
        }

        private async Task RefreshAccount()
        {
            if (accountRequest || accountDialogOpen || shutdownRequested || DateTime.UtcNow < nextAccountRefresh) return;
            nextAccountRefresh = DateTime.UtcNow.AddSeconds(5);
            accountRequest = true;
            revokeButton.Enabled = false;
            UpdateSelection();
            try
            {
                InstallationAuthorizationView view = await Task.Run(() => authorization.ReadView());
                if (shutdownRequested || IsDisposed) return;
                authorizeButton.Visible = view == null || view.Status != "approved";
                revokeButton.Visible = view != null && view.Status == "approved";
                if (view == null || view.Status != "approved")
                {
                    accountCapacity.Text = "连接额度：登录后查看";
                    revokeButton.Enabled = view != null && view.Status == "revoked";
                    if (clientOptions != null) accountStatus.Text = view != null && view.Status == "revoked"
                        ? "授权已撤销 · 可退出账号后重新连接" : "未授权软件 · 请点击连接账号";
                    return;
                }
                InstallationStatus status = await Task.Run(() => authorization.Status());
                if (shutdownRequested || IsDisposed) return;
                if (!status.Authorized)
                {
                    authorizeButton.Visible = true;
                    revokeButton.Visible = false;
                    accountCapacity.Text = "连接额度：待核实";
                    accountStatus.Text = "授权已失效 · 可退出账号后重新连接";
                    revokeButton.Enabled = true;
                    return;
                }
                accountStatus.Text = status.DisplayName;
                accountCapacity.Text = "连接额度 " + status.Total + "    ·    已用 " + status.Active + "    ·    可用 " + status.Available;
                accountCapacity.ForeColor = SystemInformation.HighContrast ? SystemColors.WindowText
                    : status.Available == 0 ? Color.FromArgb(145, 92, 24) : Color.FromArgb(65, 75, 90);
                connections.ResumeCapacityWaiters(status.Available);
                revokeButton.Enabled = true;
            }
            catch (Exception)
            {
                if (!shutdownRequested && !IsDisposed)
                { accountCapacity.Text = "连接额度暂不可用 · 正在重试"; revokeButton.Enabled = true; }
            }
            finally { accountRequest = false; if (!shutdownRequested && !IsDisposed) UpdateSelection(); }
        }

        private async Task RevokeAccount()
        {
            if (accountRequest || accountDialogOpen || shutdownRequested || removalInProgress) return;
            if (MessageBox.Show(this, "退出会撤销本软件授权及其终端凭据，并断开本软件的连接。交易终端保持运行，历史记录保留。是否继续？",
                "退出账号", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            accountRequest = true;
            revokeButton.Enabled = authorizeButton.Enabled = false;
            UpdateSelection();
            bool revoked = false;
            try
            {
                await Task.Run(() => authorization.Revoke());
                revoked = true;
                if (shutdownRequested || IsDisposed) return;
                authorizeButton.Visible = true;
                List<string> profileIds = new List<string>();
                foreach (BridgeProfileSettings profile in catalog.Profiles) profileIds.Add(profile.ProfileId);
                lock (stateGate)
                    foreach (string id in profileIds) if (starting.Contains(id)) cancelledStarts.Add(id);
                await Task.Run(delegate
                {
                    List<Exception> failures = new List<Exception>();
                    foreach (string id in profileIds)
                        try { connections.Stop(id); } catch (Exception error) { failures.Add(error); }
                    if (failures.Count != 0) throw new AggregateException("bridge_account_stop_incomplete", failures);
                });
                if (shutdownRequested || IsDisposed) return;
                RefreshProfiles();
                accountStatus.Text = "已退出账号";
                accountCapacity.Text = "连接额度：登录后查看";
                revokeButton.Visible = false;
            }
            catch (Exception)
            {
                if (!shutdownRequested && !IsDisposed) MessageBox.Show(this, revoked
                    ? "软件授权已撤销，部分本地连接尚未停止。请再次退出账号完成清理。"
                    : "退出结果尚未确认，请检查网络后重试。", "请重试");
            }
            finally
            {
                accountRequest = false;
                if (!shutdownRequested && !IsDisposed) { authorizeButton.Enabled = clientOptions != null && configurationAvailable; nextAccountRefresh = DateTime.MinValue; UpdateSelection(); }
            }
        }

        private void EditSelected()
        {
            BridgeProfileSettings current = SelectedProfile();
            if (current == null || !configurationAvailable || current.RemovalPending || removalInProgress || shutdownRequested || accountRequest) return;
            lock (stateGate) if (starting.Contains(current.ProfileId)) return;
            if (updateActivationStarted) return;
            BridgeProfileSettings edited = current.Clone();
            ApplyPackagedDefaults(edited);
            using (ProfileEditorForm editor = new ProfileEditorForm(edited, false,
                terminalDiscovery: WindowsTerminalDiscovery.Create(terminalHost)))
            {
                if (editor.ShowDialog(this) != DialogResult.OK) return;
                try
                {
                    bool connectionChanged = !current.SameConnectionSettings(editor.Profile);
                    // The credential belongs to this paired profile, not to its current account.
                    editor.Profile.ProfileId = current.ProfileId;
                    int index = catalog.Profiles.IndexOf(current);
                    BridgeProfileCatalog candidate = CopyCatalog();
                    candidate.Profiles[index] = editor.Profile;
                    // Save only after the old runtime has released its workers and lease.
                    // A stop timeout leaves the original catalog and configuration intact.
                    if (connectionChanged) StopProfile(current.ProfileId);
                    profileStore.Save(candidate);
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
            if (profile == null || !configurationAvailable || removalInProgress || shutdownRequested || updateActivationStarted || accountRequest) return;
            if (!profile.RemovalPending && MessageBox.Show(this, "确定移除档案“" + profile.DisplayName
                + "”并撤销对应设备凭据吗？账户历史、本地安全账本和缓存会保留。",
                "移除终端档案", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
            try
            {
                catalog = removals.Prepare(catalog, profile.ProfileId);
                lock (stateGate)
                {
                    if (starting.Contains(profile.ProfileId)) cancelledStarts.Add(profile.ProfileId);
                    operationErrors.Remove(profile.ProfileId);
                }
                removalInProgress = true;
                BridgeProfileCatalog pending = catalog;
                RefreshProfiles();
                ThreadPool.QueueUserWorkItem(delegate
                {
                    Exception failure = null;
                    try { removals.Complete(pending, profile.ProfileId); }
                    catch (Exception error) { failure = error; }
                    try
                    {
                        BeginInvoke(new Action(delegate
                        {
                            removalInProgress = false;
                            try { catalog = profileStore.LoadOrCreate(); }
                            catch (Exception) { configurationAvailable = false; }
                            lock (stateGate)
                            {
                                if (failure != null) operationErrors[profile.ProfileId] = "未完成移除，请检查网络或本地配置权限后点击“重试移除”。";
                            }
                            RefreshProfiles();
                        }));
                    }
                    catch (InvalidOperationException) { }
                });
            }
            catch (Exception error)
            {
                removalInProgress = false;
                try { catalog = profileStore.LoadOrCreate(); } catch (Exception) { configurationAvailable = false; }
                RefreshProfiles();
                ShowOperationError(error);
            }
        }

        private void StartProfile(BridgeProfileSettings profile)
        {
            if (profile == null || profile.RemovalPending || shutdownRequested) return;
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
            if (shutdownRequested) return;
            if (IsDisposed) return;
            if (profileMenu.Visible) return;
            {
                Dictionary<string, ListViewItem> existing = new Dictionary<string, ListViewItem>(StringComparer.Ordinal);
                foreach (ListViewItem row in profileList.Items) existing.Add((string)row.Tag, row);
                HashSet<string> retained = new HashSet<string>(StringComparer.Ordinal);
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
                    ListViewItem item;
                    if (!existing.TryGetValue(profile.ProfileId, out item))
                    {
                        item = new ListViewItem(profile.DisplayName) { Tag = profile.ProfileId };
                        for (int column = 1; column < 7; column++) item.SubItems.Add(string.Empty);
                        profileList.Items.Add(item);
                    }
                    retained.Add(profile.ProfileId);
                    SetProfileCell(item, 0, profile.DisplayName);
                    SetProfileCell(item, 1, profile.Platform.ToUpperInvariant());
                    SetProfileCell(item, 2, profile.Login);
                    SetProfileCell(item, 3, profile.BrokerServer);
                    SetProfileCell(item, 4, ProfileStatusText(state));
                    item.SubItems[4].Tag = ProfilePermissionDetails(state);
                    SetProfileCell(item, 5, profile.RemovalPending ? (removalInProgress ? "正在移除" : "待移除，可重试")
                        : busy ? "正在启动" : ConnectionText(state.State));
                    SetProfileCell(item, 6, profile.AutoConnect ? "是" : "否");
                    Color color = !string.IsNullOrEmpty(localError) || (!string.IsNullOrEmpty(state.LastErrorCode) && state.State != "capacity_wait")
                        ? Color.DarkRed : SystemColors.WindowText;
                    if (item.ForeColor != color) item.ForeColor = color;
                }
                foreach (KeyValuePair<string, ListViewItem> row in existing)
                    if (!retained.Contains(row.Key)) profileList.Items.Remove(row.Value);
            }

            int terminalCount = 0, serverCount = 0;
            foreach (BridgeProfileSettings profile in catalog.Profiles)
            {
                BridgeProfileConnectionSnapshot state = connections.Snapshot(profile);
                if (state.TerminalState == "connected") terminalCount++;
                if (state.State == "active") serverCount++;
            }
            summary.Text = "我的终端  " + catalog.Profiles.Count + "    ·    终端在线 " + terminalCount
                + "    ·    服务器已连接 " + serverCount + UpdateSummary();
            emptyState.Visible = catalog.Profiles.Count == 0;
            UpdateSelection();
            UpdatePermissionTip();
            TryWriteLegacyReadySignal();
        }

        private void CheckForUpdates()
        {
            if (shutdownRequested || removalInProgress || accountRequest || accountDialogOpen) return;
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
            RefreshDiagnostics();
            BridgeProfileSettings profile = SelectedProfile();
            bool selected = profile != null;
            bool isStarting;
            lock (stateGate) isStarting = selected && starting.Contains(profile.ProfileId);
            editButton.Enabled = selected && configurationAvailable && !profile.RemovalPending && !removalInProgress && !accountRequest
                && !isStarting && !updateActivationStarted;
            connectButton.Enabled = selected && configurationAvailable && !profile.RemovalPending && !accountRequest;
            disconnectButton.Enabled = selected && !accountRequest;
            deleteButton.Enabled = selected && configurationAvailable && !removalInProgress && !updateActivationStarted && !accountRequest;
            deleteButton.Text = selected && profile.RemovalPending ? "重试移除" : "删除";
            addButton.Enabled = configurationAvailable && !removalInProgress && !accountRequest;
            primaryAdd.Enabled = addButton.Enabled && !accountDialogOpen && !shutdownRequested;
            if (!selected)
            {
                detail.Text = configurationAvailable
                    ? "选择一个终端查看连接情况；双击可编辑备注和设置。"
                    : "配置文件读取失败，本次启动已进入只读保护状态。";
                return;
            }
            BridgeProfileConnectionSnapshot state = connections.Snapshot(profile);
            string error;
            lock (stateGate) operationErrors.TryGetValue(profile.ProfileId, out error);
            if (string.IsNullOrEmpty(error)) error = state.LastErrorCode;
            if (profile.RemovalPending)
            {
                detail.Text = removalInProgress ? "正在停止连接并撤销设备凭据，账户历史和本地账本会保留。"
                    : "此档案等待移除，不会自动连接。请右键选择“重试移除”完成服务器撤销和本地移除。"
                        + (string.IsNullOrEmpty(error) ? string.Empty : "  " + error);
                return;
            }
            detail.Text = ConnectionGuidance(profile, state, error);
            detail.ForeColor = !string.IsNullOrEmpty(error) ? Color.FromArgb(156, 83, 37) : Color.FromArgb(92, 102, 116);
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
            Button button = new Button { Text = text, AutoSize = true, Cursor = Cursors.Hand, MinimumSize = new Size(92, 36),
                Padding = new Padding(10, 0, 10, 0), Margin = new Padding(0, 0, 8, 0),
                FlatStyle = FlatStyle.Flat, BackColor = Color.White, ForeColor = Color.FromArgb(45, 57, 73) };
            button.FlatAppearance.BorderColor = Color.FromArgb(213, 221, 231);
            return button;
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
                case "capacity_wait": return "等待可用额度";
                case "backoff": return "等待重连";
                case "disconnected": return "准备连接";
                case "update_wait": return "等待更新";
                case "stopping": return "正在停止";
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
