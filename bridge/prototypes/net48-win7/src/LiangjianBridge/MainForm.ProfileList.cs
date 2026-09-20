using System;
using System.Drawing;
using System.Windows.Forms;
using Liangjian.BridgeV4.Runtime;

namespace Liangjian.BridgeV4.App
{
    internal sealed partial class MainForm
    {
        private sealed class BufferedProfileList : ListView
        {
            public BufferedProfileList() { DoubleBuffered = true; }
        }

        private static void SetProfileCell(ListViewItem item, int column, string text)
        {
            text = text ?? string.Empty;
            if (!string.Equals(item.SubItems[column].Text, text, StringComparison.Ordinal))
                item.SubItems[column].Text = text;
        }

        private readonly ToolStripMenuItem addButton = new ToolStripMenuItem("新增档案");
        private readonly ToolStripMenuItem editButton = new ToolStripMenuItem("编辑");
        private readonly ToolStripMenuItem connectButton = new ToolStripMenuItem("连接");
        private readonly ToolStripMenuItem disconnectButton = new ToolStripMenuItem("断开");
        private readonly ToolStripMenuItem deleteButton = new ToolStripMenuItem("删除");
        private readonly ContextMenuStrip profileMenu = new ContextMenuStrip();
        private readonly ToolStripSeparator connectionSeparator = new ToolStripSeparator();
        private readonly ToolStripSeparator removalSeparator = new ToolStripSeparator();
        private readonly ToolStripMenuItem permissionMenu = new ToolStripMenuItem("状态与权限详情");
        private readonly ToolTip permissionTip = new ToolTip { AutoPopDelay = 20000, InitialDelay = 500, ReshowDelay = 100 };
        private string hoveredPermission;
        private bool permissionTipDismissed;
        private Point lastPermissionPoint = new Point(-1, -1);

        private void ConfigureProfileMenu()
        {
            permissionTip.OwnerDraw = true;
            permissionTip.Popup += delegate(object sender, PopupEventArgs args)
            {
                string text = permissionTip.GetToolTip(profileList);
                // Show() provides the current text through DrawToolTipEventArgs; use the hovered row here.
                Point point = profileList.PointToClient(Cursor.Position);
                if (profileList.ClientRectangle.Contains(point))
                {
                    ListViewHitTestInfo hit = profileList.HitTest(point);
                    if (hit.Item != null) text = hit.Item.SubItems[4].Tag as string;
                }
                args.ToolTipSize = new Size(460, 48 + (text ?? string.Empty).Split('\n').Length * 25);
            };
            permissionTip.Draw += DrawPermissionDetails;
            profileList.AccessibleName = "终端档案，右键或按 Shift+F10 操作，状态列提供交易权限详情";
            profileMenu.ShowImageMargin = false;
            profileMenu.Font = profileList.Font;
            profileMenu.Renderer = new ProfileMenuRenderer();
            profileMenu.BackColor = Color.White;
            profileMenu.Padding = new Padding(5);
            profileMenu.Items.AddRange(new ToolStripItem[] { addButton, connectButton, disconnectButton,
                permissionMenu, connectionSeparator, editButton, removalSeparator, deleteButton });
            editButton.Text = "编辑档案…";
            addButton.Text = "新增终端档案…";
            foreach (ToolStripItem item in profileMenu.Items)
                if (item is ToolStripMenuItem)
                {
                    item.AutoSize = false;
                    item.Size = new Size(210, 36);
                    item.Padding = new Padding(14, 0, 14, 0);
                }
            permissionMenu.Click += delegate
            {
                if (SelectedProfile() != null) MessageBox.Show(this,
                    ProfilePermissionDetails(connections.Snapshot(SelectedProfile())),
                    "状态与权限详情", MessageBoxButtons.OK, MessageBoxIcon.Information);
            };
            profileList.ContextMenuStrip = profileMenu;
            profileList.MouseDown += delegate(object sender, MouseEventArgs args)
            {
                if (args.Button != MouseButtons.Right) return;
                ListViewItem target = profileList.GetItemAt(args.X, args.Y);
                foreach (ListViewItem item in profileList.Items) item.Selected = false;
                if (target != null) { target.Selected = true; target.Focused = true; }
                profileList.Focus();
            };
            profileMenu.Opening += delegate(object sender, System.ComponentModel.CancelEventArgs args)
            {
                if (shutdownRequested || IsDisposed) { args.Cancel = true; return; }
                bool selected = SelectedProfile() != null;
                addButton.Visible = !selected;
                editButton.Visible = connectButton.Visible = disconnectButton.Visible = deleteButton.Visible = selected;
                HidePermissionTip();
                UpdateSelection();
                connectionSeparator.Visible = removalSeparator.Visible = permissionMenu.Visible = selected;
                if (selected)
                {
                    BridgeProfileConnectionSnapshot state = connections.Snapshot(SelectedProfile());
                    bool running = state.State != "stopped" && state.State != "disconnected" && state.State != "failed";
                    connectButton.Visible = !running;
                    disconnectButton.Visible = running;
                    connectButton.Text = "连接服务器";
                    disconnectButton.Text = "断开服务器连接";
                }
            };
            profileList.MouseMove += delegate(object sender, MouseEventArgs args)
            {
                if (args.Location != lastPermissionPoint) permissionTipDismissed = false;
                lastPermissionPoint = args.Location;
                UpdatePermissionTip();
            };
            profileList.MouseLeave += delegate { HidePermissionTip(); };
            profileList.KeyDown += delegate(object sender, KeyEventArgs args)
            {
                if (args.KeyCode == Keys.Escape) { permissionTipDismissed = true; HidePermissionTip(); }
                if (args.KeyCode == Keys.F1 && SelectedProfile() != null)
                {
                    MessageBox.Show(this, ProfilePermissionDetails(connections.Snapshot(SelectedProfile())),
                        "交易权限详情", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    args.Handled = true;
                }
            };
        }

        private void HidePermissionTip()
        {
            permissionTip.Hide(profileList);
            hoveredPermission = null;
        }

        private void UpdatePermissionTip()
        {
            if (permissionTipDismissed || profileMenu.Visible || !profileList.IsHandleCreated || IsDisposed) return;
            Point point = profileList.PointToClient(Cursor.Position);
            if (!profileList.ClientRectangle.Contains(point)) { HidePermissionTip(); return; }
            ListViewHitTestInfo hit = profileList.HitTest(point);
            if (hit.Item == null || hit.SubItem != hit.Item.SubItems[4]) { HidePermissionTip(); return; }
            string text = hit.SubItem.Tag as string;
            string key = hit.Item.Tag + "\n" + text;
            if (key == hoveredPermission) return;
            permissionTip.Hide(profileList);
            hoveredPermission = key;
            permissionTip.Show(text, profileList, point.X + 12, point.Y + 22, 20000);
        }

        private static string ProfileStatusText(BridgeProfileConnectionSnapshot state)
        {
            string permission = state.TradePermission == "allowed" ? "终端允许交易"
                : state.TradePermission == "restricted" ? "交易受限" : "权限待确认";
            if (state.TradePermission == "restricted" && state.TradePermissionDetails != null)
            {
                int count = 0;
                foreach (string line in state.TradePermissionDetails.Split('\n'))
                    if (line.Trim().EndsWith("：未开启", StringComparison.Ordinal)) count++;
                if (count > 0) permission = count + " 项开关未开启";
            }
            return (state.TerminalState == "connected" ? "终端在线" : "终端离线") + " · " + permission;
        }

        private static string ProfilePermissionDetails(BridgeProfileConnectionSnapshot state)
        {
            return (state.TradePermissionDetails ?? "尚未读取交易权限。")
                + "\r\n服务器连接：" + ConnectionText(state.State);
        }

        private void DrawPermissionDetails(object sender, DrawToolTipEventArgs args)
        {
            args.Graphics.Clear(SystemInformation.HighContrast ? SystemColors.Info : Color.White);
            using (Pen border = new Pen(Color.FromArgb(209, 220, 232)))
                args.Graphics.DrawRectangle(border, 0, 0, args.Bounds.Width - 1, args.Bounds.Height - 1);
            TextRenderer.DrawText(args.Graphics, "交易权限详情", Font, new Point(14, 12), SystemColors.InfoText);
            int y = 40;
            foreach (string raw in args.ToolTipText.Split('\n'))
            {
                string line = raw.Trim();
                int separator = line.LastIndexOf('：');
                bool flag = line.EndsWith("已开启", StringComparison.Ordinal) || line.EndsWith("未开启", StringComparison.Ordinal)
                    || line.EndsWith("未能读取", StringComparison.Ordinal);
                if (separator > 0 && flag)
                {
                    string value = line.Substring(separator + 1);
                    Color color = SystemInformation.HighContrast ? SystemColors.InfoText : value == "已开启"
                        ? Color.FromArgb(0, 128, 98) : value == "未开启" ? Color.FromArgb(190, 55, 50) : Color.FromArgb(128, 113, 69);
                    TextRenderer.DrawText(args.Graphics, line.Substring(0, separator + 1), Font, new Point(14, y), SystemColors.InfoText);
                    TextRenderer.DrawText(args.Graphics, "● " + value, Font, new Point(330, y), color);
                }
                else TextRenderer.DrawText(args.Graphics, line, Font, new Point(14, y), SystemColors.InfoText);
                y += 25;
            }
        }
    }
}
