using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace Liangjian.BridgeV4.App
{
    internal sealed partial class MainForm
    {
        private NotifyIcon trayIcon;
        private ContextMenuStrip trayMenu;
        private bool explicitExit;
        private bool closeChoiceOpen;

        private void InitializeTray()
        {
            using (Stream source = typeof(MainForm).Assembly.GetManifestResourceStream("LiangjianBridge.ico"))
            {
                if (source != null) Icon = new Icon(source);
                else Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("打开量见智桥", null, delegate { RestoreWindow(); });
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add("退出软件", null, delegate
            {
                explicitExit = true;
                RestoreWindow();
                Close();
                if (!shutdownRequested) explicitExit = false;
            });
            trayIcon = new NotifyIcon { Icon = Icon, Text = "量见智桥 · 终端连接管理", ContextMenuStrip = trayMenu, Visible = true };
            trayIcon.DoubleClick += delegate { RestoreWindow(); };
        }

        internal void RestoreWindow()
        {
            if (IsDisposed) return;
            ShowInTaskbar = true;
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            BringToFront();
            Activate();
        }

        private bool KeepRunningOnClose(CloseReason reason)
        {
            if (reason != CloseReason.UserClosing || explicitExit || shutdownRequested || updateActivationStarted) return false;
            if (closeChoiceOpen) return true;
            closeChoiceOpen = true;
            try
            {
                using (BridgeCloseChoiceForm choice = new BridgeCloseChoiceForm(Icon))
                {
                    DialogResult result = choice.ShowDialog(this);
                    if (result == DialogResult.No) { explicitExit = true; return false; }
                    if (result == DialogResult.Yes)
                    {
                        ShowInTaskbar = false;
                        Hide();
                        trayIcon.ShowBalloonTip(3000, "量见智桥仍在运行", "终端连接继续保持。双击托盘图标可打开窗口。", ToolTipIcon.Info);
                    }
                    return true;
                }
            }
            finally { closeChoiceOpen = false; }
        }

        private void DisposeTray()
        {
            if (trayIcon != null) { trayIcon.Visible = false; trayIcon.Dispose(); trayIcon = null; }
            if (trayMenu != null) { trayMenu.Dispose(); trayMenu = null; }
        }
    }
}
