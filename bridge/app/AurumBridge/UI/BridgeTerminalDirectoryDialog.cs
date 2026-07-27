namespace AurumBridge.UI;

public sealed class BridgeTerminalDirectoryDialog : Form
{
    private const string LoadingNodeText = "正在读取…";
    private readonly TreeView _directories = new();
    private readonly TextBox _selectedPath = new();
    private readonly Button _confirm = new();

    public BridgeTerminalDirectoryDialog(
        string platform,
        string? currentPath,
        IReadOnlyList<string> suggestedDirectories)
    {
        ArgumentNullException.ThrowIfNull(suggestedDirectories);
        Text = $"选择 {Runtime.BridgePlatform.DisplayName(platform)} 目录";
        Icon = BridgeBrandIcon.ApplicationIcon;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new(620, 470);
        MinimumSize = new(560, 420);
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        Font = new("Microsoft YaHei UI", 9F);

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new(16),
            ColumnCount = 1,
            RowCount = 5,
        };
        layout.RowStyles.Add(new(SizeType.AutoSize));
        layout.RowStyles.Add(new(SizeType.Percent, 100));
        layout.RowStyles.Add(new(SizeType.AutoSize));
        layout.RowStyles.Add(new(SizeType.AutoSize));
        layout.RowStyles.Add(new(SizeType.AutoSize));

        layout.Controls.Add(new Label
        {
            AutoSize = true,
            Text = "选择自动检测到的终端，或展开本机磁盘查找目录。",
            ForeColor = Color.FromArgb(71, 85, 105),
            Margin = new Padding(0, 0, 0, 10),
        });

        _directories.Dock = DockStyle.Fill;
        _directories.HideSelection = false;
        _directories.ShowNodeToolTips = true;
        _directories.BeforeExpand += HandleBeforeExpand;
        _directories.AfterSelect += (_, eventArgs) =>
            SelectDirectory(eventArgs.Node?.Tag as string);
        PopulateRoots(suggestedDirectories);
        layout.Controls.Add(_directories);

        layout.Controls.Add(new Label
        {
            AutoSize = true,
            Text = "已选择目录",
            Font = new(Font.FontFamily, 9F, FontStyle.Bold),
            Margin = new Padding(0, 12, 0, 4),
        });
        _selectedPath.Dock = DockStyle.Top;
        _selectedPath.ReadOnly = true;
        layout.Controls.Add(_selectedPath);

        var actions = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            Margin = new Padding(0, 12, 0, 0),
        };
        _confirm.Text = "选择此目录";
        _confirm.AutoSize = true;
        _confirm.Enabled = false;
        _confirm.DialogResult = DialogResult.OK;
        var cancel = new Button
        {
            Text = "取消",
            AutoSize = true,
            DialogResult = DialogResult.Cancel,
        };
        actions.Controls.Add(_confirm);
        actions.Controls.Add(cancel);
        layout.Controls.Add(actions);
        Controls.Add(layout);
        AcceptButton = _confirm;
        CancelButton = cancel;

        if (!string.IsNullOrWhiteSpace(currentPath) && Directory.Exists(currentPath))
        {
            SelectDirectory(currentPath);
        }
    }

    public string SelectedPath => _selectedPath.Text;

    private void PopulateRoots(IReadOnlyList<string> suggestedDirectories)
    {
        var suggestions = suggestedDirectories
            .Where(path => !string.IsNullOrWhiteSpace(path) && Directory.Exists(path))
            .Select(Path.GetFullPath)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(path => path, StringComparer.CurrentCultureIgnoreCase)
            .ToArray();
        if (suggestions.Length > 0)
        {
            var detected = new TreeNode("自动检测到的终端");
            foreach (var path in suggestions)
            {
                detected.Nodes.Add(CreateDirectoryNode(path, showFullPath:true));
            }
            detected.Expand();
            _directories.Nodes.Add(detected);
        }

        var drives = new TreeNode("本机磁盘");
        foreach (var drive in GetLocalDrives())
        {
            drives.Nodes.Add(CreateDirectoryNode(drive, showFullPath:true));
        }
        drives.Expand();
        _directories.Nodes.Add(drives);
    }

    private async void HandleBeforeExpand(object? sender, TreeViewCancelEventArgs eventArgs)
    {
        var node = eventArgs.Node;
        if (node is null
            || node.Tag is not string path
            || node.Nodes.Count != 1
            || node.Nodes[0].Text != LoadingNodeText)
        {
            return;
        }
        node.Nodes[0].Text = "正在读取目录…";
        var children = await Task.Run(() => ReadChildDirectories(path));
        if (IsDisposed || node.TreeView is null)
        {
            return;
        }
        node.Nodes.Clear();
        foreach (var child in children)
        {
            node.Nodes.Add(CreateDirectoryNode(child));
        }
        if (children.Count == 0)
        {
            node.Nodes.Add(new TreeNode("没有可访问的子目录")
            {
                ForeColor = Color.FromArgb(100, 116, 139),
            });
        }
    }

    private void SelectDirectory(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path))
        {
            _selectedPath.Clear();
            _confirm.Enabled = false;
            return;
        }
        _selectedPath.Text = Path.GetFullPath(path);
        _selectedPath.SelectionStart = _selectedPath.TextLength;
        _confirm.Enabled = true;
    }

    private TreeNode CreateDirectoryNode(string path, bool showFullPath = false)
    {
        var fullPath = Path.GetFullPath(path);
        var label = showFullPath
            ? fullPath
            : Path.GetFileName(Path.TrimEndingDirectorySeparator(fullPath));
        var node = new TreeNode(string.IsNullOrWhiteSpace(label) ? fullPath : label)
        {
            Tag = fullPath,
            ToolTipText = fullPath,
        };
        node.Nodes.Add(LoadingNodeText);
        return node;
    }

    private static IReadOnlyList<string> GetLocalDrives()
    {
        try
        {
            return DriveInfo.GetDrives()
                .Where(drive => drive.DriveType == DriveType.Fixed && drive.IsReady)
                .Select(drive => drive.RootDirectory.FullName)
                .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
        catch (Exception error) when (error is IOException
            or UnauthorizedAccessException)
        {
            return [];
        }
    }

    private static IReadOnlyList<string> ReadChildDirectories(string path)
    {
        try
        {
            return Directory.EnumerateDirectories(path)
                .Where(directory => !IsReparsePoint(directory))
                .OrderBy(directory => directory, StringComparer.CurrentCultureIgnoreCase)
                .Take(500)
                .ToArray();
        }
        catch (Exception error) when (error is UnauthorizedAccessException
            or IOException
            or ArgumentException
            or NotSupportedException
            or PathTooLongException)
        {
            return [];
        }
    }

    private static bool IsReparsePoint(string path)
    {
        try
        {
            return File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint);
        }
        catch (Exception error) when (error is UnauthorizedAccessException
            or IOException
            or ArgumentException
            or NotSupportedException
            or PathTooLongException)
        {
            return true;
        }
    }
}
