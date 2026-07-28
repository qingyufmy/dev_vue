using AurumBridge.Protocol;
using AurumBridge.Storage;
using AurumBridge.Workers;

namespace AurumBridge.Runtime;

public sealed record Mt4ProvisionedTerminal(
    TerminalBinding Binding,
    TerminalRuntimeSupervisor Supervisor,
    string? AdapterVersion);

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
        CancellationToken cancellationToken = default) =>
        await ProvisionManyAsync(
            registrations,
            selectedTerminalInstanceId is null
                ? null
                : new HashSet<string>(StringComparer.Ordinal)
                {
                    selectedTerminalInstanceId,
                },
            cancellationToken);

    public async Task<Mt4ProvisioningResult> ProvisionManyAsync(
        IEnumerable<Mt4EaConnection> registrations,
        IReadOnlySet<string>? allowedTerminalInstanceIds,
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
            var installationId = SafeTerminalId(connection.Hello.TerminalDataPath);
            if (allowedTerminalInstanceIds is not null
                && !allowedTerminalInstanceIds.Contains(installationId))
            {
                await connection.DisposeAsync();
                continue;
            }
            string terminalId;
            try
            {
                ValidateRegistration(connection.Hello);
                terminalId = Mt4TerminalIdentity.CreateAccountTerminalInstanceId(
                    connection.Hello.TerminalDataPath,
                    connection.Hello.BrokerServer,
                    connection.Hello.Login);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                await connection.DisposeAsync();
                failures.Add(new(installationId, NormalizeError(error)));
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
                var binding = await ActivateAsync(
                    terminalId,
                    connection.Hello.TerminalDataPath,
                    new(connection.Hello.BrokerServer, connection.Hello.Login),
                    cancellationToken);
                await _store.RemoveOtherTerminalBindingsForPathAsync(
                    "mt4",
                    binding.TerminalPath,
                    binding.TerminalInstanceId,
                    cancellationToken);
                provisioned.Add(Create(binding, connection));
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                await connection.DisposeAsync();
                failures.Add(new(installationId, NormalizeError(error)));
            }
        }

        var existing = await _store.GetTerminalBindingsAsync(cancellationToken);
        foreach (var binding in LatestBindingsByPath(existing.Where(value => value.Platform == "mt4")))
        {
            var installationId = SafeTerminalId(binding.TerminalPath);
            if (allowedTerminalInstanceIds is not null
                && !allowedTerminalInstanceIds.Contains(installationId))
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
                var accountTerminalId = Mt4TerminalIdentity.CreateAccountTerminalInstanceId(
                    binding.TerminalPath,
                    binding.AccountRef.BrokerServer,
                    binding.AccountRef.Login);
                var activated = await ActivateAsync(
                    accountTerminalId,
                    binding.TerminalPath,
                    binding.AccountRef,
                    cancellationToken);
                await _store.RemoveOtherTerminalBindingsForPathAsync(
                    "mt4",
                    activated.TerminalPath,
                    activated.TerminalInstanceId,
                    cancellationToken);
                provisioned.Add(Create(
                    activated,
                    initialConnection: null,
                    firstReconnectTerminalId: binding.TerminalInstanceId));
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                failures.Add(new(installationId, NormalizeError(error)));
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
        Mt4EaConnection? initialConnection,
        string? firstReconnectTerminalId = null)
    {
        var adapterVersion = initialConnection?.Hello.AdapterVersion;
        var descriptor = binding.ToDescriptor(adapterVersion is null
            ? WorkerVersion
            : $"mt4-ea-{adapterVersion}");
        var reconnectPipe = Mt4TerminalIdentity.CreateReconnectPipeName(binding.TerminalInstanceId);
        var firstConnection = initialConnection;
        var firstPipe = initialConnection is null
            && !string.IsNullOrWhiteSpace(firstReconnectTerminalId)
            && !string.Equals(firstReconnectTerminalId, binding.TerminalInstanceId, StringComparison.Ordinal)
                ? Mt4TerminalIdentity.CreateReconnectPipeName(firstReconnectTerminalId)
                : null;
        var supervisor = new TerminalRuntimeSupervisor(descriptor, () =>
        {
            var connection = new ReconnectableMt4EaConnection(
                Interlocked.Exchange(ref firstPipe, null) ?? reconnectPipe,
                binding.TerminalPath,
                binding.AccountRef.BrokerServer,
                binding.AccountRef.Login,
                Interlocked.Exchange(ref firstConnection, null));
            return new Mt4TerminalRuntime(descriptor, connection, _store, reconnectPipe);
        });
        return new(binding, supervisor, adapterVersion);
    }

    private static IReadOnlyList<TerminalBinding> LatestBindingsByPath(
        IEnumerable<TerminalBinding> bindings) => bindings
        .GroupBy(
            binding => Path.GetFullPath(binding.TerminalPath),
            StringComparer.OrdinalIgnoreCase)
        .Select(group => group
            .OrderByDescending(binding => binding.UpdatedAtUtcMsc)
            .First())
        .ToArray();

    private static void ValidateRegistration(Mt4Hello hello)
    {
        if (hello.ProtocolVersion != Mt4PipeProtocol.CurrentProtocolVersion)
        {
            throw new InvalidDataException("mt4_ea_protocol_incompatible");
        }
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
