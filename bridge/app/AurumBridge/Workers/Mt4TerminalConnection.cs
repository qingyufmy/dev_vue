using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace AurumBridge.Workers;

public static class Mt4TerminalIdentity
{
    public const string RegistrationPipeName = "AURUMBridgeV3";

    public static string CreateTerminalInstanceId(string terminalDataPath, string? deviceNamespace = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(terminalDataPath);
        var normalized = Path.GetFullPath(terminalDataPath).ToUpperInvariant();
        return HashIdentity($"{ResolveDevice(deviceNamespace)}\n{normalized}");
    }

    public static string CreateAccountTerminalInstanceId(
        string terminalDataPath,
        string brokerServer,
        string login,
        string? deviceNamespace = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(terminalDataPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(brokerServer);
        ArgumentException.ThrowIfNullOrWhiteSpace(login);
        var normalizedPath = Path.GetFullPath(terminalDataPath).ToUpperInvariant();
        var normalizedServer = brokerServer.Trim().ToUpperInvariant();
        var normalizedLogin = login.Trim();
        return HashIdentity(
            $"{ResolveDevice(deviceNamespace)}\n{normalizedPath}\n{normalizedServer}\n{normalizedLogin}");
    }

    private static string ResolveDevice(string? deviceNamespace) =>
        string.IsNullOrWhiteSpace(deviceNamespace)
            ? ResolveDeviceNamespace()
            : deviceNamespace.Trim();

    private static string HashIdentity(string identity)
    {
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)))
            .ToLowerInvariant();
        return $"mt4_{hash[..24]}";
    }

    private static string ResolveDeviceNamespace()
    {
        if (OperatingSystem.IsWindows())
        {
            try
            {
                using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography", false);
                if (key?.GetValue("MachineGuid") is string value && !string.IsNullOrWhiteSpace(value))
                {
                    return value.Trim();
                }
            }
            catch (Exception error) when (error is UnauthorizedAccessException or IOException
                or System.Security.SecurityException)
            {
            }
        }
        else
        {
            try
            {
                const string machineIdPath = "/etc/machine-id";
                if (File.Exists(machineIdPath))
                {
                    var value = File.ReadAllText(machineIdPath).Trim();
                    if (!string.IsNullOrWhiteSpace(value)) return value;
                }
            }
            catch (Exception error) when (error is UnauthorizedAccessException or IOException)
            {
            }
        }
        return $"{Environment.MachineName}\n{Environment.UserName}";
    }

    public static string CreateReconnectPipeName(string terminalInstanceId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(terminalInstanceId);
        if (!terminalInstanceId.StartsWith("mt4_", StringComparison.Ordinal)
            || terminalInstanceId.Length > 64
            || terminalInstanceId.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '_'))
        {
            throw new ArgumentException("MT4 terminal instance id is invalid.", nameof(terminalInstanceId));
        }
        return $"aurum_{terminalInstanceId}";
    }
}

public sealed class ReconnectableMt4EaConnection : IMt4EaConnection
{
    private readonly string _pipeName;
    private readonly string _expectedDataPath;
    private readonly string _expectedBrokerServer;
    private readonly string _expectedLogin;
    private Mt4EaConnection? _connection;
    private bool _disposed;

    public ReconnectableMt4EaConnection(
        string pipeName,
        string expectedDataPath,
        string expectedBrokerServer,
        string expectedLogin,
        Mt4EaConnection? initialConnection = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pipeName);
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedDataPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedBrokerServer);
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedLogin);
        _pipeName = pipeName;
        _expectedDataPath = Path.GetFullPath(expectedDataPath);
        _expectedBrokerServer = expectedBrokerServer.Trim();
        _expectedLogin = expectedLogin.Trim();
        _connection = initialConnection;
    }

    public bool SupportsDeals => _connection?.SupportsDeals ?? false;
    public bool SupportsExtendedData => _connection?.SupportsExtendedData ?? false;

    public async Task SendWelcomeAsync(
        Mt4Welcome welcome,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        _connection ??= await Mt4EaConnection.AcceptAsync(
            _pipeName,
            TimeSpan.FromSeconds(20),
            cancellationToken);
        ValidateHello(_connection.Hello);
        await _connection.SendWelcomeAsync(welcome, cancellationToken);
    }

    public Task<Mt4Snapshot> CollectAsync(
        Mt4CollectionStreams streams,
        CancellationToken cancellationToken = default) =>
        ReadyConnection().CollectAsync(streams, cancellationToken);

    public Task<Mt4TradeResult> ExecuteAsync(
        Mt4TradeCommand command,
        CancellationToken cancellationToken = default) =>
        ReadyConnection().ExecuteAsync(command, cancellationToken);

    public Task<Mt4Quote> GetQuoteAsync(
        Mt4QuoteRequest request,
        CancellationToken cancellationToken = default) =>
        ReadyConnection().GetQuoteAsync(request, cancellationToken);

    public Task<Mt4Rates> GetRatesAsync(
        Mt4RatesRequest request,
        CancellationToken cancellationToken = default) =>
        ReadyConnection().GetRatesAsync(request, cancellationToken);

    public Task<Mt4SymbolSnapshot> GetSymbolSnapshotAsync(
        Mt4SymbolSnapshotRequest request,
        CancellationToken cancellationToken = default) =>
        ReadyConnection().GetSymbolSnapshotAsync(request, cancellationToken);

    public Task<Mt4RiskSnapshot> GetRiskSnapshotAsync(
        Mt4RiskSnapshotRequest request,
        CancellationToken cancellationToken = default) =>
        ReadyConnection().GetRiskSnapshotAsync(request, cancellationToken);

    public Task<Mt4PerformanceDaily> GetPerformanceDailyAsync(
        Mt4PerformanceDailyRequest request,
        CancellationToken cancellationToken = default) =>
        ReadyConnection().GetPerformanceDailyAsync(request, cancellationToken);

    public Task<Mt4ExtendedData> GetExtendedDataAsync(
        Mt4ExtendedDataRequest request,
        CancellationToken cancellationToken = default) =>
        ReadyConnection().GetExtendedDataAsync(request, cancellationToken);

    public Task<Mt4DealsBatch> CollectDealsAsync(
        Mt4DealsRequest request,
        CancellationToken cancellationToken = default) =>
        ReadyConnection().CollectDealsAsync(request, cancellationToken);

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        if (_connection is not null)
        {
            await _connection.DisposeAsync();
            _connection = null;
        }
    }

    private Mt4EaConnection ReadyConnection() => _connection
        ?? throw new InvalidOperationException("mt4_ea_not_ready");

    private void ValidateHello(Mt4Hello hello)
    {
        if (hello.ProtocolVersion != Mt4PipeProtocol.CurrentProtocolVersion)
        {
            throw new InvalidDataException("mt4_ea_protocol_incompatible");
        }
        if (!hello.Connected
            || !string.Equals(
                Path.GetFullPath(hello.TerminalDataPath),
                _expectedDataPath,
                StringComparison.OrdinalIgnoreCase)
            || !string.Equals(hello.BrokerServer, _expectedBrokerServer, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(hello.Login, _expectedLogin, StringComparison.Ordinal))
        {
            throw new InvalidDataException("mt4_ea_identity_mismatch");
        }
    }
}
