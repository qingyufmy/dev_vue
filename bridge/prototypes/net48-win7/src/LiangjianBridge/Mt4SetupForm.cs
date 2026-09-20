using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Liangjian.BridgeV4.Configuration;

namespace Liangjian.BridgeV4.App
{
    internal sealed class Mt4SetupForm : Form
    {
        private readonly string sourceEaPath;
        private readonly Label status = new Label { AutoSize = true, MaximumSize = new Size(570, 0) };

        public Mt4SetupForm(string sourcePath)
        {
            sourceEaPath = sourcePath;
            Text = "安装 MT4 适配器";
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(630, 320);
            MinimumSize = new Size(620, 340);
            Font = new Font("Microsoft YaHei UI", 9F);
            TableLayoutPanel layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 1, RowCount = 4 };
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(570, 0), Text =
                "先在要连接的 MT4 中点击“文件 → 打开数据文件夹”，再选择该目录。\r\n多个 MT4 请分别安装到对应数据目录。" });
            FlowLayoutPanel actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top, Margin = new Padding(0, 16, 0, 16) };
            Button install = new Button { Text = "选择数据目录并安装", AutoSize = true, MinimumSize = new Size(170, 40) };
            Button export = new Button { Text = "导出适配器文件", AutoSize = true, MinimumSize = new Size(150, 40) };
            install.Click += delegate { SelectAndCopy(false); };
            export.Click += delegate { SelectAndCopy(true); };
            actions.Controls.Add(install); actions.Controls.Add(export); layout.Controls.Add(actions);
            layout.Controls.Add(status);
            Button close = new Button { Text = "关闭", AutoSize = true, MinimumSize = new Size(90, 36), Anchor = AnchorStyles.Right, DialogResult = DialogResult.Cancel };
            layout.Controls.Add(close); CancelButton = close; Controls.Add(layout);
            status.Text = "安装后：回到 MT4 导航器刷新，将 BridgeV4MT4 拖到图表，勾选“允许 DLL 导入”，再回到量见智桥刷新识别。\r\n本操作仅复制适配器文件。";
        }

        private void SelectAndCopy(bool export)
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog { Description = export ? "选择导出目录" : "选择 MT4 的数据文件夹（包含 MQL4\\Experts）", ShowNewFolderButton = export })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                try
                {
                    bool overwrite = Mt4AdapterInstaller.NeedsOverwrite(sourceEaPath, dialog.SelectedPath, export);
                    if (overwrite && MessageBox.Show(this, "该目录已有不同内容的 BridgeV4MT4.ex4。替换前会保留备份，是否继续？",
                        "确认替换适配器", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
                    Mt4AdapterInstallResult result = export ? Mt4AdapterInstaller.Export(sourceEaPath, dialog.SelectedPath, overwrite)
                        : Mt4AdapterInstaller.Install(sourceEaPath, dialog.SelectedPath, overwrite);
                    status.Text = (result.Changed ? "已保存：" : "已是当前版本：") + result.Destination
                        + (result.Backup == null ? string.Empty : "\r\n原文件备份：" + result.Backup)
                        + (export ? "\r\n请复制此文件到目标 MT4 数据文件夹的 MQL4\\Experts。" : string.Empty)
                        + "\r\n回到 MT4 导航器刷新，将 BridgeV4MT4 拖到图表并允许 DLL 导入，再回量见智桥刷新识别。";
                }
                catch (Exception error)
                {
                    string message = error.Message == "bridge_mt4_v4_adapter_missing"
                        ? "当前安装包缺少新版 BridgeV4MT4.ex4，请先编译或安装包含 MT4 适配器的完整版本。"
                        : error.Message == "bridge_mt4_data_directory_invalid"
                            ? "请选择 MT4“文件 → 打开数据文件夹”显示的目录，其中应包含 MQL4\\Experts。"
                            : "未完成安装，请检查目录权限或文件占用。原文件会保留。";
                    MessageBox.Show(this, message, "安装未完成", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            }
        }
    }
}
