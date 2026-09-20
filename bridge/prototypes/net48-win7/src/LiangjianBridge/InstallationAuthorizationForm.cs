using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Runtime;

namespace Liangjian.BridgeV4.App
{
    internal sealed class InstallationAuthorizationForm : Form
    {
        private readonly BridgeClientOptions options;
        private readonly InstallationAuthorizationStore store;
        private readonly string installationId;
        private readonly TextBox deviceName = new TextBox { Dock = DockStyle.Fill, MaxLength = 128 };
        private readonly Label status = new Label { AutoSize = true, Dock = DockStyle.Fill };
        private readonly Button connect = new Button { Text = "连接账号", Width = 160, Height = 44 };
        private readonly System.Windows.Forms.Timer pollTimer = new System.Windows.Forms.Timer { Interval = 5000 };
        private InstallationAuthorizationView current;
        private bool busy;
        private bool closing;

        public InstallationAuthorizationForm(BridgeClientOptions clientOptions, InstallationAuthorizationStore authorizationStore,
            string installation)
        {
            if (clientOptions == null || authorizationStore == null || string.IsNullOrWhiteSpace(installation))
                throw new ArgumentNullException("authorizationFormDependency");
            options = clientOptions; store = authorizationStore; installationId = installation;
            Text = "连接网站账号"; StartPosition = FormStartPosition.CenterParent;
            Font = new Font("Microsoft YaHei UI", 9F); MinimumSize = new Size(560, 380); Size = new Size(640, 400);
            deviceName.Text = Environment.MachineName; deviceName.AccessibleName = "本机名称";
            TableLayoutPanel layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 1, RowCount = 7 };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.Controls.Add(new Label { Text = "在浏览器中确认，将这台电脑连接到你的网站账号。", AutoSize = true, Margin = new Padding(0, 0, 0, 16) });
            layout.Controls.Add(new Label { Text = "网站：" + options.WebBase, AutoSize = true, Margin = new Padding(0, 0, 0, 12) });
            layout.Controls.Add(new Label { Text = "本机名称", AutoSize = true, Margin = new Padding(0, 0, 0, 6) });
            layout.Controls.Add(deviceName);
            status.Text = "连接后可添加终端档案，无需逐个填写网页配对码。";
            status.Margin = new Padding(0, 18, 0, 12); status.AccessibleName = "账号连接状态";
            layout.Controls.Add(status);
            layout.Controls.Add(new Label { Text = "关闭此窗口不会撤销授权，下次打开可继续。", AutoSize = true, ForeColor = Color.DimGray, Margin = new Padding(0, 8, 0, 8) });
            FlowLayoutPanel actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft };
            Button close = new Button { Text = "稍后继续", Width = 110, Height = 44, DialogResult = DialogResult.Cancel };
            actions.Controls.Add(close); actions.Controls.Add(connect); layout.Controls.Add(actions); Controls.Add(layout);
            AcceptButton = connect; CancelButton = close;
            connect.Click += async delegate { await StartOrContinue(); };
            pollTimer.Tick += async delegate { await Poll(); };
            Shown += async delegate { await Restore(); };
            FormClosing += delegate { closing = true; pollTimer.Stop(); };
            FormClosed += delegate { pollTimer.Dispose(); };
        }

        public InstallationAuthorizationView Authorization { get; private set; }

        private async Task Restore()
        {
            if (busy || closing) return;
            SetBusy(true);
            try
            {
                InstallationAuthorizationView value = await Task.Run(delegate { return store.ReadView(); });
                if (closing) return;
                if (value != null) Apply(value);
                if (value != null && value.Status == "approved") await VerifyApproved();
            }
            catch (Exception) { if (!closing) status.Text = "暂时无法读取或验证授权，请重试。"; }
            finally { if (!closing) SetBusy(false); }
        }

        private async Task StartOrContinue()
        {
            if (busy || closing) return;
            SetBusy(true); pollTimer.Stop();
            string name = deviceName.Text.Trim();
            try
            {
                if (name.Length == 0) { status.Text = "请填写本机名称。"; return; }
                InstallationAuthorizationView value = await Task.Run(delegate { return store.Start(options.ApiBase, installationId, name); });
                if (closing) return;
                Apply(value);
                if (value.Status == "approved") { await VerifyApproved(); return; }
                Process.Start(new ProcessStartInfo { FileName = options.ConfirmationUri(value.ConfirmationPath).AbsoluteUri, UseShellExecute = true });
                status.Text = "请在浏览器中确认连接，此窗口会自动更新。";
            }
            catch (InvalidDataException error)
            {
                if (!closing) status.Text = error.Message == "bridge_installation_profile_pending"
                    ? "上次添加档案的结果尚未保存。请先在主窗口退出账号，清理待完成的档案后重新连接。"
                    : "暂时无法连接，请重试；已发起的请求会继续保留。";
            }
            catch (Exception) { if (!closing) status.Text = "暂时无法连接或打开浏览器，请重试；已发起的请求会继续保留。"; }
            finally { if (!closing) { SetBusy(false); ResumePolling(); } }
        }

        private async Task Poll()
        {
            if (busy || closing || current == null || current.Status != "pending") return;
            SetBusy(true);
            try
            {
                InstallationAuthorizationView value = await Task.Run(delegate { return store.Poll(); });
                if (closing) return;
                Apply(value);
                if (value.Status == "approved") Succeed(value);
            }
            catch (Exception) { if (!closing) status.Text = "暂时无法获取确认结果，稍后自动重试。"; }
            finally { if (!closing) SetBusy(false); }
        }

        private async Task VerifyApproved()
        {
            InstallationStatus verified = await Task.Run(delegate { return store.Status(); });
            if (closing) return;
            if (verified.Authorized) Succeed(current);
            else Apply(store.ReadView());
        }
        private void Succeed(InstallationAuthorizationView value)
        { Authorization = value; pollTimer.Stop(); DialogResult = DialogResult.OK; Close(); }
        private void Apply(InstallationAuthorizationView value)
        {
            current = value;
            if (value.Status == "pending")
            { status.Text = value.AuthorizationId == null ? "上次请求尚未完成，点击继续连接。" : "等待浏览器确认，可重新打开确认页面。"; connect.Text = "继续连接"; }
            else if (value.Status == "approved") { status.Text = "已连接：" + value.DisplayName; connect.Text = "验证连接"; }
            else { status.Text = value.Status == "expired" ? "确认请求已过期，请重新连接。" : value.Status == "denied" ? "此请求未获授权，可以重新发起。" : "授权已撤销，请重新连接。"; connect.Text = "重新连接"; }
            ResumePolling();
        }
        private void ResumePolling()
        {
            if (!closing && current != null && current.Status == "pending" && current.AuthorizationId != null)
            { pollTimer.Interval = Math.Max(5000, current.PollIntervalSeconds * 1000); pollTimer.Start(); }
            else pollTimer.Stop();
        }
        private void SetBusy(bool value)
        { busy = value; connect.Enabled = !value; deviceName.Enabled = !value && (current == null || current.AuthorizationId == null || current.Status != "pending"); }
    }
}
