using AurumBridge.Storage;
using AurumBridge.Workers;

namespace AurumBridge.Runtime;

public sealed record Mt5ProvisionedTerminal(
    Mt5Installation Installation,
    TerminalBinding Binding,
    TerminalRuntimeSupervisor Supervisor);

public sealed record Mt5ProvisioningFailure(
    string TerminalInstanceId,
    string TerminalPath,
    string ErrorCode);

public sealed record Mt5ProvisioningResult(
    IReadOnlyList<Mt5ProvisionedTerminal> Terminals,
    IReadOnlyList<Mt5ProvisioningFailure> Failures);

public sealed class Mt5RuntimeProvisioner
{
    private const string WorkerVersion = "mt5-python-v3";
    private readonly BridgeStore _store;
    private readonly string _pythonExecutable;
    private readonly string _workerScript;
    private readonly Func<Mt5Installation, CancellationToken, Task<Mt5ProbeResult>> _probe;
    private readonly Func<long> _clock;

    public Mt5RuntimeProvisioner(
        BridgeStore store,
        string pythonExecutable,
        string workerScript,
        Func<Mt5Installation, CancellationToken, Task<Mt5ProbeResult>>? probe = null,
        Func<long>? clock = null)
    {
        _store = store ?? throw new ArgumentNullException(nameof(store));
        ArgumentException.ThrowIfNullOrWhiteSpace(pythonExecutable);
        ArgumentException.ThrowIfNullOrWhiteSpace(workerScript);
        _pythonExecutable = Path.GetFullPath(pythonExecutable);
        _workerScript = Path.GetFullPath(workerScript);
        if (probe is null)
        {
            var client = new Mt5ProbeClient();
            _probe = (installation, cancellationToken) => client.ProbeAsync(
                _pythonExecutable,
                _workerScript,
                installation.ExecutablePath,
                TimeSpan.FromSeconds(15),
                cancellationToken);
        }
        else
        {
            _probe = probe;
        }
        _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public async Task<Mt5ProvisioningResult> ProvisionAsync(
        IEnumerable<Mt5Installation> installations,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(installations);
        EnsureRuntimeFilesExist();
        var provisioned = new List<Mt5ProvisionedTerminal>();
        var failures = new List<Mt5ProvisioningFailure>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var installation in installations)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!seen.Add(installation.TerminalInstanceId))
            {
                continue;
            }
            try
            {
                var probe = await _probe(installation, cancellationToken);
                ValidateProbe(installation, probe);
                var binding = await _store.ActivateTerminalBindingAsync(
                    installation.TerminalInstanceId,
                    "mt5",
                    installation.ExecutablePath,
                    probe.AccountRef,
                    _clock(),
                    cancellationToken);
                var descriptor = binding.ToDescriptor(WorkerVersion);
                var supervisor = new TerminalRuntimeSupervisor(
                    descriptor,
                    () => CreateRuntime(installation.ExecutablePath, descriptor));
                provisioned.Add(new(installation, binding, supervisor));
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception error)
            {
                failures.Add(new(
                    installation.TerminalInstanceId,
                    installation.ExecutablePath,
                    NormalizeProbeError(error)));
            }
        }
        return new(provisioned, failures);
    }

    private IBridgeTerminalRuntime CreateRuntime(string terminalPath, Protocol.TerminalDescriptor descriptor)
    {
        var pipeName = $"aurum_mt5_{descriptor.TerminalInstanceId}_{Guid.NewGuid():N}";
        var startInfo = Mt5WorkerClient.BuildStartInfo(
            _pythonExecutable,
            _workerScript,
            pipeName,
            terminalPath,
            descriptor);
        return new Mt5TerminalRuntime(
            descriptor,
            new Mt5WorkerClient(pipeName, startInfo),
            _store);
    }

    private void EnsureRuntimeFilesExist()
    {
        if (!File.Exists(_pythonExecutable))
        {
            throw new FileNotFoundException("mt5_python_runtime_not_found", _pythonExecutable);
        }
        if (!File.Exists(_workerScript))
        {
            throw new FileNotFoundException("mt5_worker_script_not_found", _workerScript);
        }
    }

    private static void ValidateProbe(Mt5Installation installation, Mt5ProbeResult probe)
    {
        if (!string.Equals(
                Path.GetFullPath(installation.ExecutablePath),
                Path.GetFullPath(probe.TerminalPath),
                StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(probe.AccountRef.BrokerServer)
            || string.IsNullOrWhiteSpace(probe.AccountRef.Login))
        {
            throw new InvalidDataException("mt5_probe_identity_mismatch");
        }
    }

    private static string NormalizeProbeError(Exception error) => error switch
    {
        TimeoutException => "mt5_probe_timeout",
        InvalidDataException => "mt5_probe_response_invalid",
        FileNotFoundException => "mt5_runtime_file_not_found",
        InvalidOperationException when IsKnownCode(error.Message) => error.Message,
        _ => "mt5_probe_failed",
    };

    private static bool IsKnownCode(string code) => code is
        "mt5_probe_failed"
        or "mt5_probe_process_start_failed";
}
