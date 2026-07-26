using AurumBridge.Protocol;
using AurumBridge.Storage;
using AurumBridge.Workers;

namespace AurumBridge.Runtime;

public sealed record Mt4ProvisionedTerminal(
    TerminalBinding Binding,
    TerminalRuntimeSupervisor Supervisor);

public sealed record Mt4ProvisioningFailure(
    string TerminalInstanceId,
    string ErrorCode);

public sealed record Mt4ProvisioningResult(
    IReadOnlyList<Mt4ProvisionedTerminal> Terminals,
    IReadOnlyList<Mt4ProvisioningFailure> Failures);

public sealed class Mt4RuntimeProvisioner
{
    private const string WorkerVersion = "mt4-ea-v3";
    private readonly BridgeStore _store;
    private readonly Func<long> _clock;

    public Mt4RuntimeProvisioner(BridgeStore store, Func<long>? clock = null)
    {
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public async Task<Mt4ProvisioningResult> ProvisionAsync(
        IEnumerable<Mt4EaConnection> registrations,
        string? selectedTerminalInstanceId = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(registrations);
        var provisioned = new List<Mt4ProvisionedTerminal>();
        var failures = new List<Mt4ProvisioningFailure>();
        var registeredIds = new HashSet<string>(StringComparer.Ordinal);
        var registeredPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var connection in registrations)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var terminalId = SafeTerminalId(connection.Hello.TerminalDataPath);
            if (selectedTerminalInstanceId is not null
                && terminalId != selectedTerminalInstanceId)
            {
                await connection.DisposeAsync();
                continue;
            }
            if (!registeredIds.Add(terminalId))
            {
                await connection.DisposeAsync();
                continue;
            }
            try
            {
                registeredPaths.Add(Path.GetFullPath(connection.Hello.TerminalDataPath));
            }
            catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException)
            {
            }
            try
            {
                ValidateRegistration(connection.Hello);
                var binding = await ActivateAsync(
                    terminalId,
                    connection.Hello.TerminalDataPath,
                    new(connection.Hello.BrokerServer, connection.Hello.Login),
                    cancellationToken);
                provisioned.Add(Create(binding, connection));
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                await connection.DisposeAsync();
                failures.Add(new(terminalId, NormalizeError(error)));
            }
        }

        var existing = await _store.GetTerminalBindingsAsync(cancellationToken);
        foreach (var binding in existing.Where(value => value.Platform == "mt4"))
        {
            if (selectedTerminalInstanceId is not null
                && binding.TerminalInstanceId != selectedTerminalInstanceId)
            {
                continue;
            }
            if (registeredIds.Contains(binding.TerminalInstanceId))
            {
                continue;
            }
            if (registeredPaths.Contains(Path.GetFullPath(binding.TerminalPath)))
            {
                // Version 3.2 adds a device namespace to MT4 terminal IDs. Keep
                // the previous binding for audit/history, but never launch a
                // second runtime for the same terminal data directory.
                continue;
            }
            try
            {
                if (!Directory.Exists(binding.TerminalPath))
                {
                    throw new DirectoryNotFoundException("mt4_terminal_data_path_not_found");
                }
                var activated = await ActivateAsync(
                    binding.TerminalInstanceId,
                    binding.TerminalPath,
                    binding.AccountRef,
                    cancellationToken);
                provisioned.Add(Create(activated, initialConnection: null));
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                failures.Add(new(binding.TerminalInstanceId, NormalizeError(error)));
            }
        }
        return new(provisioned, failures);
    }

    public static async Task<IReadOnlyList<Mt4EaConnection>> AcceptRegistrationsAsync(
        TimeSpan window,
        CancellationToken cancellationToken = default)
    {
        if (window <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(window));
        }
        var registrations = new List<Mt4EaConnection>();
        var deadline = DateTimeOffset.UtcNow + window;
        while (DateTimeOffset.UtcNow < deadline && registrations.Count < 32)
        {
            var remaining = deadline - DateTimeOffset.UtcNow;
            try
            {
                registrations.Add(await Mt4EaConnection.AcceptAsync(
                    Mt4TerminalIdentity.RegistrationPipeName,
                    remaining,
                    cancellationToken));
            }
            catch (TimeoutException)
            {
                break;
            }
        }
        return registrations;
    }

    private async Task<TerminalBinding> ActivateAsync(
        string terminalId,
        string terminalDataPath,
        AccountRef accountRef,
        CancellationToken cancellationToken) =>
        await _store.ActivateTerminalBindingAsync(
            terminalId,
            "mt4",
            terminalDataPath,
            accountRef,
            _clock(),
            cancellationToken);

    private Mt4ProvisionedTerminal Create(
        TerminalBinding binding,
        Mt4EaConnection? initialConnection)
    {
        var descriptor = binding.ToDescriptor(WorkerVersion);
        var reconnectPipe = Mt4TerminalIdentity.CreateReconnectPipeName(binding.TerminalInstanceId);
        var firstConnection = initialConnection;
        var supervisor = new TerminalRuntimeSupervisor(descriptor, () =>
        {
            var connection = new ReconnectableMt4EaConnection(
                reconnectPipe,
                binding.TerminalPath,
                binding.AccountRef.BrokerServer,
                binding.AccountRef.Login,
                Interlocked.Exchange(ref firstConnection, null));
            return new Mt4TerminalRuntime(descriptor, connection, _store, reconnectPipe);
        });
        return new(binding, supervisor);
    }

    private static void ValidateRegistration(Mt4Hello hello)
    {
        if (!hello.Connected
            || string.IsNullOrWhiteSpace(hello.BrokerServer)
            || string.IsNullOrWhiteSpace(hello.Login)
            || !Directory.Exists(hello.TerminalDataPath))
        {
            throw new InvalidDataException("mt4_registration_invalid");
        }
    }

    private static string SafeTerminalId(string terminalDataPath)
    {
        try
        {
            return Mt4TerminalIdentity.CreateTerminalInstanceId(terminalDataPath);
        }
        catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return "mt4_registration_invalid";
        }
    }

    private static string NormalizeError(Exception error) => error switch
    {
        DirectoryNotFoundException => "mt4_terminal_data_path_not_found",
        InvalidDataException => error.Message,
        IOException => "mt4_registration_io_error",
        _ => "mt4_registration_failed",
    };
}
