using System.Diagnostics;
using System.Text.Json;

namespace AurumBridge.Launcher;

public interface IBridgeProcessRunner
{
    Task<bool> RunHealthCheckAsync(
        string executablePath,
        TimeSpan timeout,
        CancellationToken cancellationToken = default);
    Task<bool> StartBridgeAndWaitReadyAsync(
        string executablePath,
        string expectedVersion,
        IReadOnlyList<string> expectedTerminalInstanceIds,
        TimeSpan timeout,
        CancellationToken cancellationToken = default);
    void StartBridge(string executablePath);
}

public sealed class LauncherEngine(
    string installRoot,
    VersionPointerStore pointerStore,
    IBridgeProcessRunner processRunner,
    Func<long>? clock = null)
{
    private static readonly TimeSpan HealthCheckTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan PendingStartupTimeout = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan RollbackStartupTimeout = TimeSpan.FromSeconds(25);
    private readonly string _installRoot = Path.GetFullPath(installRoot);
    private readonly VersionPointerStore _pointerStore = pointerStore;
    private readonly IBridgeProcessRunner _processRunner = processRunner;
    private readonly Func<long> _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    private readonly LauncherUpdateStateStore _updateStateStore = new(
        Path.Combine(Path.GetFullPath(installRoot), "update-state.json"),
        clock);

    public async Task<string> LaunchAsync(CancellationToken cancellationToken = default)
    {
        var pointer = await _pointerStore.LoadAsync(cancellationToken);
        var activeExecutable = ResolveExecutable(pointer.ActiveVersion);
        if (await _processRunner.RunHealthCheckAsync(
            activeExecutable,
            HealthCheckTimeout,
            cancellationToken))
        {
            if (pointer.Status == "pending")
            {
                await _updateStateStore.MarkAsync(
                    "verifying",
                    pointer.ActiveVersion,
                    cancellationToken:cancellationToken);
                if (await _processRunner.StartBridgeAndWaitReadyAsync(
                    activeExecutable,
                    pointer.ActiveVersion,
                    pointer.ExpectedTerminalInstanceIds,
                    PendingStartupTimeout,
                    cancellationToken))
                {
                    await _pointerStore.SaveAsync(pointer with
                    {
                        LastKnownGoodVersion = pointer.ActiveVersion,
                        Status = "healthy",
                        ExpectedTerminalInstanceIds = [],
                        UpdatedAtUtcMsc = _clock(),
                    }, cancellationToken);
                    await _updateStateStore.MarkAsync(
                        "healthy",
                        pointer.ActiveVersion,
                        clearMaintenanceLease:true,
                        cancellationToken:cancellationToken);
                    return pointer.ActiveVersion;
                }
                return await RollBackAsync(
                    pointer,
                    "launcher_startup_readiness_failed",
                    cancellationToken);
            }
            await _pointerStore.SaveAsync(pointer with
            {
                LastKnownGoodVersion = pointer.ActiveVersion,
                Status = "healthy",
                ExpectedTerminalInstanceIds = [],
                UpdatedAtUtcMsc = _clock(),
            }, cancellationToken);
            _processRunner.StartBridge(activeExecutable);
            return pointer.ActiveVersion;
        }
        return await RollBackAsync(
            pointer,
            "launcher_health_check_failed",
            cancellationToken);
    }

    private async Task<string> RollBackAsync(
        VersionPointer pointer,
        string failureCode,
        CancellationToken cancellationToken)
    {
        if (pointer.ActiveVersion == pointer.LastKnownGoodVersion)
        {
            throw new InvalidOperationException("launcher_health_check_failed");
        }

        var rollbackExecutable = ResolveExecutable(pointer.LastKnownGoodVersion);
        var rollbackPointer = pointer with
        {
            ActiveVersion = pointer.LastKnownGoodVersion,
            Status = "rolled_back",
            UpdatedAtUtcMsc = _clock(),
        };
        await _pointerStore.SaveAsync(rollbackPointer, cancellationToken);
        await _updateStateStore.MarkAsync(
            "rolled_back",
            pointer.ActiveVersion,
            failureCode,
            cancellationToken:cancellationToken);
        if (!await _processRunner.RunHealthCheckAsync(
            rollbackExecutable,
            HealthCheckTimeout,
            cancellationToken))
        {
            throw new InvalidOperationException("launcher_rollback_health_check_failed");
        }
        if (!await _processRunner.StartBridgeAndWaitReadyAsync(
            rollbackExecutable,
            pointer.LastKnownGoodVersion,
            pointer.ExpectedTerminalInstanceIds,
            RollbackStartupTimeout,
            cancellationToken))
        {
            throw new InvalidOperationException("launcher_rollback_startup_failed");
        }
        await _pointerStore.SaveAsync(rollbackPointer with
        {
            ExpectedTerminalInstanceIds = [],
            UpdatedAtUtcMsc = _clock(),
        }, cancellationToken);
        await _updateStateStore.MarkAsync(
            "rolled_back",
            pointer.ActiveVersion,
            failureCode,
            clearMaintenanceLease:true,
            cancellationToken:cancellationToken);
        return pointer.LastKnownGoodVersion;
    }

    private string ResolveExecutable(string version)
    {
        if (!Version.TryParse(version, out _))
        {
            throw new InvalidDataException("launcher_version_invalid");
        }
        var versionsRoot = Path.Combine(_installRoot, "versions");
        var executable = Path.GetFullPath(Path.Combine(versionsRoot, version, "AURUMBridge.exe"));
        var prefix = Path.GetFullPath(versionsRoot) + Path.DirectorySeparatorChar;
        if (!executable.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(executable))
        {
            throw new FileNotFoundException("launcher_bridge_executable_not_found", executable);
        }
        return executable;
    }
}

public sealed class BridgeProcessRunner(string installRoot) : IBridgeProcessRunner
{
    private readonly string _healthDirectory = Path.Combine(Path.GetFullPath(installRoot), "health");

    public async Task<bool> RunHealthCheckAsync(
        string executablePath,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        if (timeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(timeout));
        }
        Directory.CreateDirectory(_healthDirectory);
        var healthFile = Path.Combine(_healthDirectory, $"health-{Guid.NewGuid():N}.json");
        try
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = executablePath,
                UseShellExecute = false,
                CreateNoWindow = true,
                ArgumentList = { "--health-check", "--health-file", healthFile },
            }) ?? throw new InvalidOperationException("launcher_health_process_start_failed");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(timeout);
            try
            {
                await process.WaitForExitAsync(deadline.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                    await process.WaitForExitAsync(CancellationToken.None);
                }
                return false;
            }
            return process.ExitCode == 0 && File.Exists(healthFile);
        }
        finally
        {
            if (File.Exists(healthFile))
            {
                File.Delete(healthFile);
            }
        }
    }

    public void StartBridge(string executablePath) => Process.Start(new ProcessStartInfo
    {
        FileName = executablePath,
        UseShellExecute = false,
    });

    public async Task<bool> StartBridgeAndWaitReadyAsync(
        string executablePath,
        string expectedVersion,
        IReadOnlyList<string> expectedTerminalInstanceIds,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        if (timeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(timeout));
        }
        Directory.CreateDirectory(_healthDirectory);
        var readyFile = Path.Combine(_healthDirectory, $"ready-{Guid.NewGuid():N}.json");
        var startInfo = new ProcessStartInfo
        {
            FileName = executablePath,
            UseShellExecute = false,
            ArgumentList = { "--ready-file", readyFile },
        };
        foreach (var terminalInstanceId in expectedTerminalInstanceIds)
        {
            startInfo.ArgumentList.Add("--expected-terminal");
            startInfo.ArgumentList.Add(terminalInstanceId);
        }
        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("launcher_bridge_process_start_failed");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        var ready = false;
        try
        {
            while (!deadline.IsCancellationRequested)
            {
                if (process.HasExited)
                {
                    return false;
                }
                if (File.Exists(readyFile)
                    && await IsExpectedReadySignalAsync(
                        readyFile,
                        expectedVersion,
                        expectedTerminalInstanceIds,
                        deadline.Token))
                {
                    await Task.Delay(TimeSpan.FromSeconds(2), deadline.Token);
                    ready = !process.HasExited;
                    return ready;
                }
                await Task.Delay(TimeSpan.FromMilliseconds(100), deadline.Token);
            }
            return false;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
        finally
        {
            if (!ready && !process.HasExited)
            {
                process.Kill(entireProcessTree:true);
                await process.WaitForExitAsync(CancellationToken.None);
            }
            if (File.Exists(readyFile))
            {
                File.Delete(readyFile);
            }
        }
    }

    public static async Task<bool> IsExpectedReadySignalAsync(
        string readyFile,
        string expectedVersion,
        IReadOnlyList<string> expectedTerminalInstanceIds,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await using var stream = new FileStream(
                readyFile,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                4096,
                FileOptions.Asynchronous);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            var root = document.RootElement;
            if (!root.TryGetProperty("ready", out var ready)
                || ready.ValueKind is not JsonValueKind.True
                || !root.TryGetProperty("version", out var version)
                || version.GetString() != expectedVersion
                || !root.TryGetProperty("server_connected", out var connected)
                || connected.ValueKind is not JsonValueKind.True
                || !root.TryGetProperty("running_terminal_instance_ids", out var terminals)
                || terminals.ValueKind is not JsonValueKind.Array)
            {
                return false;
            }
            var running = terminals.EnumerateArray()
                .Where(value => value.ValueKind == JsonValueKind.String)
                .Select(value => value.GetString()!)
                .ToHashSet(StringComparer.Ordinal);
            return expectedTerminalInstanceIds.All(running.Contains);
        }
        catch (IOException)
        {
            return false;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
