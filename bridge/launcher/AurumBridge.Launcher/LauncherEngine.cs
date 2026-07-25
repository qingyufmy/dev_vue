using System.Diagnostics;

namespace AurumBridge.Launcher;

public interface IBridgeProcessRunner
{
    Task<bool> RunHealthCheckAsync(string executablePath, CancellationToken cancellationToken = default);
    Task<bool> StartBridgeAndWaitReadyAsync(
        string executablePath,
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
    private readonly string _installRoot = Path.GetFullPath(installRoot);
    private readonly VersionPointerStore _pointerStore = pointerStore;
    private readonly IBridgeProcessRunner _processRunner = processRunner;
    private readonly Func<long> _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    public async Task<string> LaunchAsync(CancellationToken cancellationToken = default)
    {
        var pointer = await _pointerStore.LoadAsync(cancellationToken);
        var activeExecutable = ResolveExecutable(pointer.ActiveVersion);
        if (await _processRunner.RunHealthCheckAsync(activeExecutable, cancellationToken))
        {
            if (pointer.Status == "pending")
            {
                if (await _processRunner.StartBridgeAndWaitReadyAsync(
                    activeExecutable,
                    TimeSpan.FromSeconds(60),
                    cancellationToken))
                {
                    await _pointerStore.SaveAsync(pointer with
                    {
                        LastKnownGoodVersion = pointer.ActiveVersion,
                        Status = "healthy",
                        UpdatedAtUtcMsc = _clock(),
                    }, cancellationToken);
                    return pointer.ActiveVersion;
                }
                return await RollBackAsync(pointer, cancellationToken);
            }
            await _pointerStore.SaveAsync(pointer with
            {
                LastKnownGoodVersion = pointer.ActiveVersion,
                Status = "healthy",
                UpdatedAtUtcMsc = _clock(),
            }, cancellationToken);
            _processRunner.StartBridge(activeExecutable);
            return pointer.ActiveVersion;
        }
        return await RollBackAsync(pointer, cancellationToken);
    }

    private async Task<string> RollBackAsync(
        VersionPointer pointer,
        CancellationToken cancellationToken)
    {
        if (pointer.ActiveVersion == pointer.LastKnownGoodVersion)
        {
            throw new InvalidOperationException("launcher_health_check_failed");
        }

        var rollbackExecutable = ResolveExecutable(pointer.LastKnownGoodVersion);
        await _pointerStore.SaveAsync(pointer with
        {
            ActiveVersion = pointer.LastKnownGoodVersion,
            Status = "rolled_back",
            UpdatedAtUtcMsc = _clock(),
        }, cancellationToken);
        if (!await _processRunner.RunHealthCheckAsync(rollbackExecutable, cancellationToken))
        {
            throw new InvalidOperationException("launcher_rollback_health_check_failed");
        }
        _processRunner.StartBridge(rollbackExecutable);
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
        CancellationToken cancellationToken = default)
    {
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
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(60));
            try
            {
                await process.WaitForExitAsync(timeout.Token);
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
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        if (timeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(timeout));
        }
        Directory.CreateDirectory(_healthDirectory);
        var readyFile = Path.Combine(_healthDirectory, $"ready-{Guid.NewGuid():N}.json");
        using var process = Process.Start(new ProcessStartInfo
        {
            FileName = executablePath,
            UseShellExecute = false,
            ArgumentList = { "--ready-file", readyFile },
        }) ?? throw new InvalidOperationException("launcher_bridge_process_start_failed");
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
                if (File.Exists(readyFile) && new FileInfo(readyFile).Length > 0)
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
}
