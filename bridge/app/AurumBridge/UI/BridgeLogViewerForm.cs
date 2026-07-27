using AurumBridge.Runtime;

namespace AurumBridge.UI;

public sealed class BridgeLogViewerForm : Form
{
    private readonly BridgeLogReader _reader;
    private readonly RichTextBox _content = new();
    private readonly Button _refreshButton = new();
    private readonly Button _copyButton = new();
    private CancellationTokenSource? _refreshCancellation;
    private int _refreshVersion;
    private bool _closing;

    public BridgeLogViewerForm(string logDirectory)
    {
        _reader = new(logDirectory);
        Text = $"{BridgeBrand.ProductName}日志";
        Icon = BridgeBrandIcon.ApplicationIcon;
        AccessibleName = $"{BridgeBrand.ProductName}日志窗口";
        StartPosition = FormStartPosition.CenterParent;
        MinimumSize = new(640, 420);
        ClientSize = new(780, 520);
        BackColor = Color.FromArgb(248, 250, 252);
        Font = new("Microsoft YaHei UI", 9F);
        AutoScaleMode = AutoScaleMode.Dpi;
        BuildLayout();
        Shown += async (_, _) => await ReloadAsync();
    }

    public async Task ReloadAsync()
    {
        if (_closing || IsDisposed || Disposing)
        {
            return;
        }
        var version = Interlocked.Increment(ref _refreshVersion);
        var refreshCancellation = new CancellationTokenSource();
        var previous = Interlocked.Exchange(ref _refreshCancellation, refreshCancellation);
        previous?.Cancel();
        _refreshButton.Enabled = false;
        _refreshButton.Text = "正在刷新…";
        try
        {
            var text = await _reader.ReadRecentTextAsync(
                cancellationToken:refreshCancellation.Token);
            if (!CanApplyRefresh(version, refreshCancellation))
            {
                return;
            }
            _content.Text = text;
            _content.SelectionStart = _content.TextLength;
            _content.ScrollToCaret();
        }
        catch (OperationCanceledException) when (refreshCancellation.IsCancellationRequested)
        {
        }
        catch (Exception)
        {
            if (CanApplyRefresh(version, refreshCancellation))
            {
                _content.Text = "暂时无法读取日志，请稍后重试。";
            }
        }
        finally
        {
            if (CanApplyRefresh(version, refreshCancellation))
            {
                _refreshButton.Enabled = true;
                _refreshButton.Text = "刷新";
            }
            Interlocked.CompareExchange(
                ref _refreshCancellation,
                null,
                refreshCancellation);
            refreshCancellation.Dispose();
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !_closing)
        {
            _closing = true;
            Interlocked.Increment(ref _refreshVersion);
            Interlocked.Exchange(ref _refreshCancellation, null)?.Cancel();
        }
        base.Dispose(disposing);
    }

    private bool CanApplyRefresh(
        int version,
        CancellationTokenSource refreshCancellation) =>
        !_closing
        && !IsDisposed
        && !Disposing
        && version == Volatile.Read(ref _refreshVersion)
        && ReferenceEquals(
            Volatile.Read(ref _refreshCancellation),
            refreshCancellation);

    private void BuildLayout()
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new(20),
            ColumnCount = 1,
            RowCount = 3,
        };
        root.RowStyles.Add(new(SizeType.AutoSize));
        root.RowStyles.Add(new(SizeType.Percent, 100));
        root.RowStyles.Add(new(SizeType.AutoSize));
        root.Controls.Add(new Label
        {
            AutoSize = true,
            Font = new(Font.FontFamily, 12F, FontStyle.Bold),
            ForeColor = Color.FromArgb(15, 23, 42),
            Text = "运行日志",
            Margin = new Padding(0, 0, 0, 12),
        });
        _content.Dock = DockStyle.Fill;
        _content.ReadOnly = true;
        _content.WordWrap = false;
        _content.BackColor = Color.White;
        _content.ForeColor = Color.FromArgb(30, 41, 59);
        _content.BorderStyle = BorderStyle.FixedSingle;
        _content.Font = new("Consolas", 9F);
        _content.DetectUrls = false;
        root.Controls.Add(_content);

        var actions = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            Margin = new Padding(0, 12, 0, 0),
        };
        ConfigureButton(_refreshButton, "刷新");
        ConfigureButton(_copyButton, "复制全部");
        _refreshButton.Click += async (_, _) => await ReloadAsync();
        _copyButton.Click += (_, _) =>
        {
            if (!string.IsNullOrWhiteSpace(_content.Text))
            {
                Clipboard.SetText(_content.Text);
            }
        };
        actions.Controls.Add(_refreshButton);
        actions.Controls.Add(_copyButton);
        root.Controls.Add(actions);
        Controls.Add(root);
    }

    private static void ConfigureButton(Button button, string text)
    {
        button.AutoSize = true;
        button.MinimumSize = new(96, 36);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 1;
        button.FlatAppearance.BorderColor = Color.FromArgb(203, 213, 225);
        button.BackColor = Color.White;
        button.ForeColor = Color.FromArgb(30, 41, 59);
        button.Text = text;
        button.Margin = new Padding(8, 0, 0, 0);
        button.Cursor = Cursors.Hand;
    }
}
