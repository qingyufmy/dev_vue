using System.Drawing;
using System.Windows.Forms;

namespace Liangjian.BridgeV4.App
{
    internal sealed class BridgeCloseChoiceForm : Form
    {
        internal BridgeCloseChoiceForm(Icon icon)
        {
            Text = "关闭量见智桥";
            Icon = icon;
            Font = new Font("Microsoft YaHei UI", 9F);
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(460, 174);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = MinimizeBox = false;
            ShowInTaskbar = false;
            BackColor = SystemColors.Window;
            TableLayoutPanel layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(22), RowCount = 3, ColumnCount = 1 };
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.Controls.Add(new Label { Text = "是否继续在后台保持连接？", AutoSize = true,
                Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 0, 0, 10) });
            layout.Controls.Add(new Label { Text = "最小化到托盘：保持终端与服务器连接。\r\n退出软件：断开桥接连接，MT4 / MT5 继续运行。", AutoSize = true, Margin = Padding.Empty });
            FlowLayoutPanel actions = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, WrapContents = false };
            Button cancel = Choice("取消", DialogResult.Cancel, 70);
            Button exit = Choice("退出软件", DialogResult.No, 96);
            Button tray = Choice("最小化到托盘", DialogResult.Yes, 128);
            tray.TabIndex = 0; exit.TabIndex = 1; cancel.TabIndex = 2;
            actions.Controls.Add(cancel); actions.Controls.Add(exit); actions.Controls.Add(tray);
            layout.Controls.Add(actions);
            Controls.Add(layout);
            AcceptButton = tray;
            CancelButton = cancel;
            Shown += delegate { tray.Select(); };
        }

        private static Button Choice(string text, DialogResult result, int width)
        {
            return new Button { Text = text, DialogResult = result, Width = width, Height = 34, UseVisualStyleBackColor = true, Margin = new Padding(6, 10, 0, 0) };
        }
    }
}
