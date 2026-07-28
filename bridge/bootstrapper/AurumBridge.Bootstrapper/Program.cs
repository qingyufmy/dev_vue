using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.Json;
using AurumBridge.Installation;
using AurumBridge.Update;
using AurumBridge.Runtime;

namespace AurumBridge.Bootstrapper;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (IsLauncherInvocation(args))
        {
            AurumBridge.Launcher.Program.Main(args).GetAwaiter().GetResult();
            return Environment.ExitCode;
        }
        if (args.Length > 0)
        {
            return RunRehearsalAsync(args).GetAwaiter().GetResult();
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new BootstrapperForm());
        return 0;
    }

    private static bool IsLauncherInvocation(IReadOnlyList<string> args)
    {
        var executableName = Path.GetFileName(Environment.ProcessPath);
        return string.Equals(
                executableName,
                BridgeInstallationRegistration.LauncherFileName,
                StringComparison.OrdinalIgnoreCase)
            || args.Count > 0
                && args[0] is "--autostart" or "--uninstall" or "--uninstall-worker";
    }

    private static async Task<int> RunRehearsalAsync(string[] args)
    {
        if (args.Length != 4 || args.Length % 2 != 0)
        {
            return 2;
        }
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var index = 0; index < args.Length; index += 2)
        {
            if (!args[index].StartsWith("--", StringComparison.Ordinal)
                || string.IsNullOrWhiteSpace(args[index + 1])
                || !values.TryAdd(args[index][2..], args[index + 1]))
            {
                return 2;
            }
        }
        if (values.Count != 2
            || !values.TryGetValue("rehearsal-install-root", out var installRoot)
            || !values.TryGetValue("rehearsal-result", out var resultPath))
        {
            return 2;
        }
        var fullResultPath = Path.GetFullPath(resultPath);
        try
        {
            var installer = new BootstrapInstaller(_ => { }, installRoot);
            var version = await installer.InstallAsync();
            await WriteRehearsalResultAsync(fullResultPath, new
            {
                ok = true,
                operation = "bootstrap-install-rehearsal",
                version,
                install_root = Path.GetFullPath(installRoot),
            });
            return 0;
        }
        catch (Exception error)
        {
            await WriteRehearsalResultAsync(fullResultPath, new
            {
                ok = false,
                error = BootstrapInstaller.SafeErrorCode(error),
                error_types = BootstrapInstaller.SafeErrorTypes(error),
            });
            return 1;
        }
    }

    private static async Task WriteRehearsalResultAsync(string path, object value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(
            path,
            JsonSerializer.Serialize(value),
            new UTF8Encoding(false));
    }
}

internal sealed class BootstrapperForm : Form
{
    private readonly Button _retry = new()
    {
        Left = 368,
        Top = 166,
        Width = 120,
        Height = 36,
        Text = "重试安装",
        Visible = false,
    };
    private readonly Label _status = new()
    {
        AutoSize = false,
        Left = 32,
        Top = 76,
        Width = 456,
        Height = 52,
        Text = "正在准备安装…",
    };
    private readonly ProgressBar _progress = new()
    {
        Left = 32,
        Top = 138,
        Width = 456,
        Height = 10,
        Style = ProgressBarStyle.Marquee,
        MarqueeAnimationSpeed = 24,
    };
    private int _started;

    public BootstrapperForm()
    {
        Text = "量见智桥安装程序";
        Width = 536;
        Height = 252;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 10F);
        Controls.Add(new Label
        {
            AutoSize = true,
            Left = 32,
            Top = 24,
            Font = new Font(Font.FontFamily, 17F, FontStyle.Bold),
            Text = "量见智桥",
        });
        Controls.Add(_status);
        Controls.Add(_progress);
        Controls.Add(_retry);
        _retry.Click += async (_, _) => await InstallAsync();
        Shown += async (_, _) => await InstallAsync();
        FormClosing += (_, eventArgs) =>
        {
            if (Volatile.Read(ref _started) == 1) eventArgs.Cancel = true;
        };
    }

    private async Task InstallAsync()
    {
        if (Interlocked.Exchange(ref _started, 1) != 0) return;
        _retry.Visible = false;
        _progress.Style = ProgressBarStyle.Marquee;
        _progress.MarqueeAnimationSpeed = 24;
        try
        {
            var installer = new BootstrapInstaller(UpdateStatus);
            var version = await installer.InstallAsync();
            _progress.Style = ProgressBarStyle.Blocks;
            _progress.Value = 100;
            _status.Text = $"安装完成，正在启动量见智桥 {version}…";
            installer.StartLauncher();
            await Task.Delay(800);
            Interlocked.Exchange(ref _started, 0);
            Close();
        }
        catch (Exception error)
        {
            _progress.Style = ProgressBarStyle.Blocks;
            _progress.MarqueeAnimationSpeed = 0;
            _progress.Value = 0;
            _status.Text = BootstrapInstaller.DescribeError(error);
            BootstrapInstaller.WriteFailureLog(error);
            Interlocked.Exchange(ref _started, 0);
            _retry.Visible = true;
            MessageBox.Show(this, _status.Text, "量见智桥安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void UpdateStatus(string value) => _status.Text = value;
}

internal sealed class BootstrapInstaller
{
    private const string PublicKeyResource = "AurumBridge.Bootstrapper.release-public-key.pem";
    private static readonly string[] RequiredCoreFiles =
    [
        "AURUMBridge.exe",
        "AURUMBridge.dll",
        "AURUMBridge.runtimeconfig.json",
        "hostfxr.dll",
        "coreclr.dll",
        "e_sqlite3.dll",
        "Microsoft.Data.Sqlite.dll",
        "server-endpoints.json",
        "runtime/python/python.exe",
        "modules/adapter.mt5.python/worker.py",
        "modules/adapter.mt4/AURUMBridgeEA.ex4",
    ];
    private readonly Assembly _assembly;
    private readonly Action<string> _status;
    private readonly string _installRoot;
    private readonly bool _rehearsal;

    public BootstrapInstaller(Action<string> status, string? rehearsalInstallRoot = null)
    {
        _assembly = typeof(BootstrapInstaller).Assembly;
        _status = status ?? throw new ArgumentNullException(nameof(status));
        var defaultInstallRoot = BridgeInstallationRegistration.DefaultInstallRoot;
        if (rehearsalInstallRoot is null)
        {
            _installRoot = defaultInstallRoot;
            return;
        }
        var overrideRoot = Path.GetFullPath(rehearsalInstallRoot);
        if (Metadata("AurumTargetEnvironment") != "test"
            || string.Equals(overrideRoot, defaultInstallRoot, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("bootstrap_rehearsal_not_allowed");
        }
        _installRoot = overrideRoot;
        _rehearsal = true;
    }

    public async Task<string> InstallAsync(CancellationToken cancellationToken = default)
    {
        var serverUrl = Metadata("AurumServerUrl");
        var launcherVersion = Version.Parse(Metadata("AurumLauncherVersion"));
        var targetEnvironment = Metadata("AurumTargetEnvironment");
        var servers = BuildServerCandidates(
            ParseServerUri(serverUrl, targetEnvironment),
            targetEnvironment,
            MetadataOrNull("AurumLoopbackServerUrl"));

        Directory.CreateDirectory(_installRoot);
        using var installationLock = new Semaphore(
            1,
            1,
            _rehearsal
                ? "Local\\AURUM-LiangjianBridge-Installer-Rehearsal"
                : "Local\\AURUM-LiangjianBridge-Installer");
        var ownsInstallationLock = false;
        ownsInstallationLock = installationLock.WaitOne(TimeSpan.Zero);
        if (!ownsInstallationLock)
        {
            throw new InvalidOperationException("bootstrap_installation_in_progress");
        }
        var operationRoot = Path.Combine(
            Path.GetTempPath(),
            $"aurum-bootstrap-{Guid.NewGuid():N}");
        try
        {
            if (!_rehearsal) EnsureBridgeIsStopped();
            Directory.CreateDirectory(operationRoot);
            _status("正在验证发布信息…");
            var publicKey = ReadTextResource(PublicKeyResource);
            var identityStore = new BridgeInstallationIdentityStore(Path.Combine(_installRoot, "installation-id"));
            var installationId = await identityStore.LoadOrCreateAsync(cancellationToken);
            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
            using var verifier = new ReleaseManifestVerifier(publicKey);
            var manifest = await FetchBootstrapManifestAsync(
                servers,
                http,
                verifier,
                launcherVersion,
                installationId,
                cancellationToken);
            ValidateManifestPackageSet(manifest);

            _status($"正在下载量见智桥 {manifest.ReleaseVersion}…");
            var downloads = Path.Combine(operationRoot, "downloads");
            var versionDirectory = Path.Combine(operationRoot, "version");
            var stager = new ReleaseStager(http);
            foreach (var package in manifest.Packages.OrderBy(value => value.ModuleId, StringComparer.Ordinal))
            {
                var archive = await stager.DownloadPackageAsync(package, downloads, cancellationToken);
                var destination = package.ModuleId == "core"
                    ? versionDirectory
                    : Path.Combine(versionDirectory, "modules", package.ModuleId);
                ReleaseStager.ExtractPackage(archive, destination);
            }
            ValidateVersionDirectory(versionDirectory);
            await File.WriteAllTextAsync(
                Path.Combine(versionDirectory, ".aurum-release.json"),
                JsonSerializer.Serialize(manifest),
                new UTF8Encoding(false),
                cancellationToken);

            _status("正在安装稳定启动组件…");
            var launcherExecutable = ResolveCurrentExecutable();

            if (!_rehearsal) EnsureBridgeIsStopped();
            InstallVersion(versionDirectory, manifest.ReleaseVersion);
            CopyFileAtomically(
                launcherExecutable,
                Path.Combine(_installRoot, BridgeInstallationRegistration.LauncherFileName));
            await WriteAtomicAsync(Path.Combine(_installRoot, "release-public-key.pem"), publicKey, cancellationToken);
            await WriteAtomicAsync(Path.Combine(_installRoot, "rollout-channel"), "stable", cancellationToken);
            await WriteAtomicAsync(
                Path.Combine(_installRoot, "current.json"),
                JsonSerializer.Serialize(new
                {
                    active_version = manifest.ReleaseVersion,
                    last_known_good_version = manifest.ReleaseVersion,
                    status = "healthy",
                    expected_terminal_instance_ids = Array.Empty<string>(),
                    updated_at_utc_msc = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                }),
                cancellationToken);
            if (!_rehearsal)
            {
                CreateShortcuts();
                BridgeInstallationRegistration.Register(
                    _installRoot,
                    manifest.ReleaseVersion,
                    DirectorySize(_installRoot));
            }
            return manifest.ReleaseVersion;
        }
        finally
        {
            if (ownsInstallationLock) installationLock.Release();
            try { Directory.Delete(operationRoot, recursive:true); } catch { }
        }
    }

    public void StartLauncher()
    {
        var launcher = Path.Combine(_installRoot, "AURUMBridge.Launcher.exe");
        Process.Start(new ProcessStartInfo { FileName = launcher, UseShellExecute = true });
    }

    public static string DescribeError(Exception error) => error.Message switch
    {
        "bootstrap_running_process_detected" => "请先退出正在运行的量见智桥，再重新安装。",
        "bootstrap_installation_in_progress" => "另一个安装程序正在运行，请稍后重试。",
        "bootstrap_release_unavailable" => "当前没有可用于首次安装的稳定版本，请稍后重试。",
        "update_manifest_signature_invalid" or "update_package_signature_invalid"
            => "安装包安全校验失败，已停止安装。",
        "update_package_integrity_failed" or "update_package_size_mismatch"
            => "安装包下载不完整，请检查网络后重试。",
        _ => "安装未完成，请检查网络后重试；如仍失败，请联系管理员。",
    };

    public static void WriteFailureLog(Exception error)
    {
        try
        {
            var root = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "AURUM",
                "LiangjianBridge",
                "logs");
            Directory.CreateDirectory(root);
            File.WriteAllText(
                Path.Combine(root, "installer-last-error.log"),
                $"{DateTimeOffset.UtcNow:O}{Environment.NewLine}{error}",
                new UTF8Encoding(false));
        }
        catch
        {
            // Logging must never hide the installation error shown to the user.
        }
    }

    public static string SafeErrorCode(Exception error)
    {
        for (Exception? current = error; current is not null; current = current.InnerException)
        {
            var value = current.Message;
            if (value is { Length: >= 1 and <= 96 }
                && value.All(character => char.IsAsciiLetterOrDigit(character) || character == '_'))
            {
                return value;
            }
            var mapped = current switch
            {
                UnauthorizedAccessException => "bootstrap_access_denied",
                HttpRequestException => "bootstrap_network_request_failed",
                IOException => "bootstrap_io_failed",
                JsonException => "bootstrap_json_invalid",
                _ => null,
            };
            if (mapped is not null)
            {
                return mapped;
            }
        }
        return "bootstrap_rehearsal_failed";
    }

    public static IReadOnlyList<string> SafeErrorTypes(Exception error)
    {
        var types = new List<string>();
        for (Exception? current = error; current is not null && types.Count < 8; current = current.InnerException)
        {
            types.Add(current.GetType().Name);
        }
        return types;
    }

    private string Metadata(string key) => _assembly
        .GetCustomAttributes<AssemblyMetadataAttribute>()
        .SingleOrDefault(value => value.Key == key)?.Value
        ?? throw new InvalidDataException("bootstrap_metadata_missing");

    private string? MetadataOrNull(string key)
    {
        var value = _assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .SingleOrDefault(attribute => attribute.Key == key)?.Value;
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    private static IReadOnlyList<Uri> BuildServerCandidates(
        Uri primaryServer,
        string targetEnvironment,
        string? loopbackServerUrl)
    {
        var servers = new List<Uri>();
        if (targetEnvironment == "test" && !string.IsNullOrWhiteSpace(loopbackServerUrl))
        {
            var loopback = ParseServerUri(loopbackServerUrl, targetEnvironment);
            if (loopback.Scheme != Uri.UriSchemeHttp || !loopback.IsLoopback)
            {
                throw new InvalidDataException("bootstrap_loopback_server_url_invalid");
            }
            servers.Add(loopback);
        }
        if (!servers.Any(value => value == primaryServer))
        {
            servers.Add(primaryServer);
        }
        return servers;
    }

    private async Task<ReleaseManifest> FetchBootstrapManifestAsync(
        IReadOnlyList<Uri> servers,
        HttpClient http,
        ReleaseManifestVerifier verifier,
        Version launcherVersion,
        string installationId,
        CancellationToken cancellationToken)
    {
        var failures = new List<Exception>();
        for (var index = 0; index < servers.Count; index++)
        {
            var server = servers[index];
            _status(index == 0 && server.IsLoopback
                ? "正在检查本地安装服务…"
                : "正在连接备用安装服务器…");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(server.IsLoopback ? TimeSpan.FromSeconds(2) : TimeSpan.FromSeconds(15));
            try
            {
                var client = new ReleaseManifestClient(
                    server,
                    http,
                    "/api/bridge/v3/releases/bootstrap");
                var manifest = await client.FetchVerifiedAsync(
                    verifier,
                    launcherVersion,
                    installationId,
                    "stable",
                    deadline.Token);
                if (manifest is not null)
                {
                    return manifest;
                }
                failures.Add(new InvalidDataException("bootstrap_release_unavailable"));
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception error) when (error is HttpRequestException
                or InvalidDataException
                or TaskCanceledException)
            {
                failures.Add(error);
            }
        }
        throw new InvalidOperationException(
            "bootstrap_release_unavailable",
            new AggregateException(failures));
    }

    private static Uri ParseServerUri(string value, string targetEnvironment)
    {
        try
        {
            var server = BridgeServerEndpointConfiguration.ParseServerUri(value);
            if (targetEnvironment is not ("test" or "production")
                || targetEnvironment == "production" && server.Scheme != Uri.UriSchemeHttps)
            {
                throw new InvalidDataException("bootstrap_server_url_invalid");
            }
            return server;
        }
        catch (InvalidDataException error) when (error.Message != "bootstrap_server_url_invalid")
        {
            throw new InvalidDataException("bootstrap_server_url_invalid", error);
        }
    }

    private string ReadTextResource(string name)
    {
        using var stream = _assembly.GetManifestResourceStream(name)
            ?? throw new InvalidDataException("bootstrap_resource_missing");
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks:true);
        return reader.ReadToEnd();
    }

    private static string ResolveCurrentExecutable()
    {
        var executable = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(executable)
            || !string.Equals(Path.GetExtension(executable), ".exe", StringComparison.OrdinalIgnoreCase)
            || !File.Exists(executable))
        {
            throw new InvalidDataException("bootstrap_launcher_source_invalid");
        }
        return Path.GetFullPath(executable);
    }

    private static void ValidateManifestPackageSet(ReleaseManifest manifest)
    {
        var modules = manifest.Packages.Select(value => value.ModuleId).ToHashSet(StringComparer.Ordinal);
        if (manifest.SchemaVersion != 2 || manifest.RolloutPercentage != 100
            || manifest.RolloutChannel != "stable"
            || !modules.SetEquals(["core", "adapter.mt5.python", "adapter.mt4"]))
        {
            throw new InvalidDataException("bootstrap_manifest_package_set_invalid");
        }
    }

    private static void ValidateVersionDirectory(string directory)
    {
        if (RequiredCoreFiles.Any(relative => !File.Exists(Path.Combine(directory, relative))))
        {
            throw new InvalidDataException("bootstrap_version_layout_invalid");
        }
        _ = BridgeServerEndpointConfiguration.ReadPackaged(directory, required:true);
    }

    private void InstallVersion(string source, string version)
    {
        if (!Version.TryParse(version, out _)) throw new InvalidDataException("bootstrap_version_invalid");
        var versions = Path.Combine(_installRoot, "versions");
        Directory.CreateDirectory(versions);
        var destination = Path.GetFullPath(Path.Combine(versions, version));
        var prefix = Path.GetFullPath(versions) + Path.DirectorySeparatorChar;
        if (!destination.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("bootstrap_version_path_invalid");
        }
        if (Directory.Exists(destination))
        {
            var backup = Path.Combine(
                versions,
                $".repair-backup-{version}-{DateTimeOffset.UtcNow:yyyyMMddHHmmss}-{Guid.NewGuid():N}");
            Directory.Move(destination, backup);
            try
            {
                MoveDirectoryIntoPlace(source, destination);
                ValidateVersionDirectory(destination);
                return;
            }
            catch
            {
                if (Directory.Exists(destination))
                {
                    Directory.Delete(destination, recursive:true);
                }
                if (Directory.Exists(backup))
                {
                    Directory.Move(backup, destination);
                }
                throw;
            }
        }
        MoveDirectoryIntoPlace(source, destination);
        ValidateVersionDirectory(destination);
    }

    private static void MoveDirectoryIntoPlace(string source, string destination)
    {
        if (string.Equals(
            Path.GetPathRoot(source),
            Path.GetPathRoot(destination),
            StringComparison.OrdinalIgnoreCase))
        {
            Directory.Move(source, destination);
            return;
        }

        var staging = Path.Combine(
            Path.GetDirectoryName(destination)!,
            $".installing-{Path.GetFileName(destination)}-{Guid.NewGuid():N}");
        try
        {
            Directory.CreateDirectory(staging);
            CopyDirectoryFilesAtomically(source, staging);
            Directory.Move(staging, destination);
            Directory.Delete(source, recursive:true);
        }
        finally
        {
            if (Directory.Exists(staging)) Directory.Delete(staging, recursive:true);
        }
    }

    private static void CopyDirectoryFilesAtomically(string source, string destination)
    {
        foreach (var directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(destination, Path.GetRelativePath(source, directory)));
        }
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(destination, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            var temporary = Path.Combine(
                Path.GetDirectoryName(target)!,
                $".{Path.GetFileName(target)}.{Guid.NewGuid():N}.tmp");
            try
            {
                File.Copy(file, temporary, overwrite:false);
                File.Move(temporary, target, overwrite:true);
            }
            finally
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }
    }

    private static void CopyFileAtomically(string source, string destination)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        var temporary = Path.Combine(
            Path.GetDirectoryName(destination)!,
            $".{Path.GetFileName(destination)}.{Guid.NewGuid():N}.tmp");
        try
        {
            File.Copy(source, temporary, overwrite:false);
            File.Move(temporary, destination, overwrite:true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static async Task WriteAtomicAsync(
        string path,
        string value,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = Path.Combine(
            Path.GetDirectoryName(path)!,
            $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            await File.WriteAllTextAsync(temporary, value, new UTF8Encoding(false), cancellationToken);
            File.Move(temporary, path, overwrite:true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private void CreateShortcuts()
    {
        try
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType is null) return;
            dynamic shell = Activator.CreateInstance(shellType)!;
            foreach (var shortcutPath in new[]
            {
                BridgeInstallationRegistration.DesktopShortcutPath,
                BridgeInstallationRegistration.StartMenuShortcutPath,
            })
            {
                Directory.CreateDirectory(Path.GetDirectoryName(shortcutPath)!);
                dynamic shortcut = shell.CreateShortcut(shortcutPath);
                shortcut.TargetPath = Path.Combine(_installRoot, BridgeInstallationRegistration.LauncherFileName);
                shortcut.WorkingDirectory = _installRoot;
                shortcut.IconLocation = Path.Combine(_installRoot, BridgeInstallationRegistration.LauncherFileName);
                shortcut.Description = "量见智桥 - 连接交易终端与量见 AI交易实验室";
                shortcut.Save();
            }
        }
        catch
        {
            // A shortcut is optional; the launcher also registers user startup.
        }
    }

    private static long DirectorySize(string directory) =>
        Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories)
            .Sum(file => new FileInfo(file).Length);

    private static void EnsureBridgeIsStopped()
    {
        if (Process.GetProcessesByName("AURUMBridge").Any()
            || Process.GetProcessesByName("AURUMBridge.Launcher").Any())
        {
            throw new InvalidOperationException("bootstrap_running_process_detected");
        }
    }
}
