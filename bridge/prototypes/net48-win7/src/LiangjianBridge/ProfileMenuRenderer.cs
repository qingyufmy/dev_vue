using System.Drawing;
using System.Windows.Forms;

namespace Liangjian.BridgeV4.App
{
    internal sealed class ProfileMenuRenderer : ToolStripProfessionalRenderer
    {
        public ProfileMenuRenderer() { RoundedEdges = false; }

        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            if (SystemInformation.HighContrast) { base.OnRenderMenuItemBackground(e); return; }
            Rectangle bounds = new Rectangle(2, 1, e.Item.Width - 4, e.Item.Height - 2);
            using (SolidBrush brush = new SolidBrush(e.Item.Selected && e.Item.Enabled
                ? Color.FromArgb(235, 241, 248) : Color.White)) e.Graphics.FillRectangle(brush, bounds);
        }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            Rectangle textBounds = e.TextRectangle;
            textBounds.Y = 0;
            textBounds.Height = e.Item.Height;
            e.TextRectangle = textBounds;
            e.TextFormat = (e.TextFormat & ~(TextFormatFlags.Bottom | TextFormatFlags.WordBreak))
                | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine;
            if (!SystemInformation.HighContrast)
                e.TextColor = !e.Item.Enabled ? Color.FromArgb(148, 155, 165)
                    : e.Item.Text == "删除" || e.Item.Text == "重试移除" ? Color.FromArgb(181, 51, 51)
                    : Color.FromArgb(35, 45, 60);
            base.OnRenderItemText(e);
        }

        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            if (SystemInformation.HighContrast) { base.OnRenderSeparator(e); return; }
            using (Pen pen = new Pen(Color.FromArgb(232, 235, 240)))
                e.Graphics.DrawLine(pen, 12, e.Item.Height / 2, e.Item.Width - 12, e.Item.Height / 2);
        }

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            if (SystemInformation.HighContrast) { base.OnRenderToolStripBorder(e); return; }
            using (Pen pen = new Pen(Color.FromArgb(216, 222, 230)))
                e.Graphics.DrawRectangle(pen, 0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
        }
    }
}
