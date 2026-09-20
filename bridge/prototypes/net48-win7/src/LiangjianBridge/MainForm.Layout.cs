using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Runtime;

namespace Liangjian.BridgeV4.App
{
    internal sealed partial class MainForm
    {
        private readonly Label accountCapacity = new Label { AutoSize = true, Text = "正在获取连接额度…", Margin = new Padding(0, 6, 0, 0) };
        private readonly Label diagnosticsText = new Label { AutoSize = true, ForeColor = Color.FromArgb(92, 102, 116), Margin = new Padding(0, 4, 12, 0) };
        private readonly Button copyDiagnostics = ActionButton("复制信息");
        private RuntimeStatus diagnosticsRuntime;
        private readonly Button primaryAdd = ActionButton("＋ 添加终端");
        private readonly ContextMenuStrip accountMenu = new ContextMenuStrip();
        private readonly ContextMenuStrip moreMenu = new ContextMenuStrip();
        private readonly Label emptyState = new Label { Text = "还没有添加终端\r\n点击“添加终端”，连接你的 MT4 或 MT5 账户。",
            AutoSize = false, TextAlign = ContentAlignment.MiddleCenter, BackColor = Color.White,
            ForeColor = Color.FromArgb(95, 108, 126), Height = 100, Dock = DockStyle.Top };

        private void BuildLayout(RuntimeStatus runtime)
        {
            diagnosticsRuntime = runtime;
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
                Text = "管理 MT4 / MT5 连接与交易权限" };
            titlePanel.Controls.Add(title);
            titlePanel.Controls.Add(subtitle);
            heading.Controls.Add(titlePanel, 0, 0);
            TableLayoutPanel accountArea = new TableLayoutPanel { AutoSize = true, ColumnCount = 2,
                RowCount = 2, Anchor = AnchorStyles.Top | AnchorStyles.Right, Padding = Padding.Empty,
                Margin = Padding.Empty };
            accountStatus.Padding = Padding.Empty;
            accountStatus.Margin = new Padding(0, 0, 16, 0);
            accountStatus.Anchor = AnchorStyles.Left;
            accountStatus.Font = new Font(Font, FontStyle.Bold);
            accountStatus.MaximumSize = new Size(240, 0);
            revokeButton.FlatAppearance.BorderSize = 0;
            revokeButton.BackColor = Color.FromArgb(230, 66, 66);
            revokeButton.ForeColor = Color.White;
            revokeButton.FlatAppearance.MouseOverBackColor = Color.FromArgb(218, 55, 55);
            revokeButton.FlatAppearance.MouseDownBackColor = Color.FromArgb(202, 45, 45);
            revokeButton.Margin = Padding.Empty;
            FlowLayoutPanel accountActions = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = Padding.Empty };
            accountActions.Controls.Add(authorizeButton);
            accountActions.Controls.Add(revokeButton);
            revokeButton.Visible = false;
            accountArea.Controls.Add(accountStatus, 0, 0);
            accountArea.Controls.Add(accountActions, 1, 0);
            accountArea.Controls.Add(accountCapacity, 0, 1);
            accountArea.SetColumnSpan(accountCapacity, 2);
            heading.Controls.Add(accountArea, 1, 0);
            root.Controls.Add(heading, 0, 0);

            summary.AutoSize = true;
            summary.Margin = new Padding(0, 14, 0, 10);
            summary.ForeColor = Color.FromArgb(65, 75, 90);
            root.Controls.Add(summary, 0, 1);

            FlowLayoutPanel actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top, Margin = new Padding(0, 0, 0, 12) };
            primaryAdd.BackColor = Color.FromArgb(39, 101, 207);
            primaryAdd.ForeColor = Color.White;
            if (SystemInformation.HighContrast) { primaryAdd.BackColor = SystemColors.Highlight; primaryAdd.ForeColor = SystemColors.HighlightText; }
            primaryAdd.FlatAppearance.BorderSize = 0;
            primaryAdd.Click += async delegate { await AddProfile(); };
            actions.Controls.Add(primaryAdd);
            Button pairing = ActionButton("配对码接入");
            pairing.Click += async delegate { await AddProfile(true); };
            actions.Controls.Add(pairing);
            Button mt4Install = ActionButton("安装 MT4 EA");
            mt4Install.Click += delegate
            {
                using (Mt4SetupForm form = new Mt4SetupForm(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "adapters", "mt4", "BridgeV4MT4.ex4"))) form.ShowDialog(this);
            };
            actions.Controls.Add(mt4Install);
            root.Controls.Add(actions, 0, 2);

            profileList.Dock = DockStyle.Fill;
            profileList.View = View.Details;
            profileList.FullRowSelect = true;
            profileList.HideSelection = false;
            profileList.MultiSelect = false;
            profileList.BorderStyle = BorderStyle.None;
            profileList.Columns.Add("终端备注", 145);
            profileList.Columns.Add("平台", 65);
            profileList.Columns.Add("交易账户", 105);
            profileList.Columns.Add("券商服务器", 150);
            profileList.Columns.Add("终端 / 交易权限", 225);
            profileList.Columns.Add("服务器连接", 110);
            profileList.Columns.Add("自动连接", 80);
            profileList.SelectedIndexChanged += delegate { UpdateSelection(); };
            profileList.DoubleClick += delegate { EditSelected(); };
            ConfigureProfileMenu();
            ImageList rowSpacing = new ImageList { ImageSize = new Size(1, 36) };
            profileList.SmallImageList = rowSpacing;
            profileList.Disposed += delegate { rowSpacing.Dispose(); };
            Panel listSurface = new Panel { Dock = DockStyle.Fill, BackColor = Color.White, Padding = new Padding(10) };
            listSurface.Controls.Add(profileList);
            listSurface.Controls.Add(emptyState);
            profileList.Resize += delegate { ResizeProfileColumns(); };
            root.Controls.Add(listSurface, 0, 3);

            detail.AutoSize = true;
            detail.MaximumSize = new Size(930, 0);
            root.SizeChanged += delegate { detail.MaximumSize = new Size(Math.Max(200, root.ClientSize.Width - root.Padding.Horizontal - 12), 0); };
            detail.Margin = new Padding(0, 12, 0, 10);
            detail.ForeColor = Color.FromArgb(92, 102, 116);
            root.Controls.Add(detail, 0, 4);

            TableLayoutPanel footer = new TableLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, ColumnCount = 2, Margin = Padding.Empty };
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            footer.Controls.Add(diagnosticsText, 0, 0);
            copyDiagnostics.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            copyDiagnostics.Margin = Padding.Empty;
            copyDiagnostics.Click += delegate
            {
                try { Clipboard.SetText(DiagnosticsContent()); copyDiagnostics.Text = "已复制"; }
                catch (System.Runtime.InteropServices.ExternalException) { copyDiagnostics.Text = "请重试复制"; }
            };
            footer.Controls.Add(copyDiagnostics, 1, 0);
            footer.SizeChanged += delegate { diagnosticsText.MaximumSize = new Size(Math.Max(200, footer.ClientSize.Width - copyDiagnostics.Width - 24), 0); };
            root.Controls.Add(footer, 0, 5);

            addButton.Click += async delegate { await AddProfile(); };
            authorizeButton.Enabled = clientOptions != null && configurationAvailable;
            authorizeButton.Click += async delegate
            {
                if (clientOptions == null || accountRequest || accountDialogOpen || shutdownRequested) return;
                accountDialogOpen = true;
                try
                {
                    using (InstallationAuthorizationForm form = new InstallationAuthorizationForm(clientOptions, authorization, catalog.InstallationId))
                        form.ShowDialog(this);
                }
                finally { accountDialogOpen = false; }
                nextAccountRefresh = DateTime.MinValue;
                await RefreshAccount();
            };
            revokeButton.Click += async delegate { await RevokeAccount(); };
            editButton.Click += delegate { EditSelected(); };
            connectButton.Click += delegate { BridgeProfileSettings profile = SelectedProfile(); if (profile != null) StartProfile(profile); };
            disconnectButton.Click += delegate { BridgeProfileSettings profile = SelectedProfile(); if (profile != null) StopProfile(profile.ProfileId); };
            deleteButton.Click += delegate { DeleteSelected(); };

            Controls.Add(root);
            UpdateSelection();
        }

        private void ResizeProfileColumns()
        {
            if (profileList.Columns.Count != 7) return;
            int available = Math.Max(660, profileList.ClientSize.Width - 8);
            int[] fixedWidths = { 0, 58, 96, 0, 210, 104, 72 };
            int flexible = Math.Max(180, available - 540);
            for (int i = 0; i < fixedWidths.Length; i++)
                profileList.Columns[i].Width = i == 0 ? flexible * 45 / 100 : i == 3 ? flexible * 55 / 100 : fixedWidths[i];
        }

        private string DiagnosticsContent()
        {
            BridgeProfileSettings profile = SelectedProfile();
            string text = diagnosticsRuntime.Supported ? ".NET 4.8：可用" : ".NET 4.8：不可用";
            if (profile != null)
            {
                BridgeProfileConnectionSnapshot state = connections.Snapshot(profile);
                string error;
                lock (stateGate) operationErrors.TryGetValue(profile.ProfileId, out error);
                text += "    ·    终端实例：" + profile.TerminalInstanceId + "\r\n服务地址：" + profile.ServerUri
                    + "\r\n最近错误：" + (error ?? state.LastErrorCode ?? "无");
            }
            else text += "\r\n选择终端后显示实例、服务地址和最近错误。";
            return text;
        }

        private void RefreshDiagnostics()
        {
            string text = DiagnosticsContent();
            if (diagnosticsText.Text == text) return;
            diagnosticsText.Text = text;
            copyDiagnostics.Text = "复制信息";
        }

    }
}
