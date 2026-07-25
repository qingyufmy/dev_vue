using AurumBridge.Protocol;
using AurumBridge.Storage;

namespace AurumBridge.Runtime;

public sealed class BridgeHost : IAsyncDisposable
{
    private static readonly string[] SnapshotStreams = ["account", "positions", "orders"];
    private readonly IReadOnlyDictionary<string, TerminalRuntimeSupervisor> _terminals;

    public BridgeHost(BridgeStore store, IEnumerable<TerminalRuntimeSupervisor> terminals)
    {
        ArgumentNullException.ThrowIfNull(store);
        ArgumentNullException.ThrowIfNull(terminals);
        var terminalMap = new Dictionary<string, TerminalRuntimeSupervisor>(StringComparer.Ordinal);
        foreach (var terminal in terminals)
        {
            if (!terminalMap.TryAdd(terminal.Terminal.TerminalInstanceId, terminal))
            {
                throw new ArgumentException("Duplicate terminal instance id.", nameof(terminals));
            }
        }
        _terminals = terminalMap;
        CommandDispatcher = new BridgeCommandDispatcher(store, ResolveTerminal, ExecuteCommandAsync);
    }

    public BridgeCommandDispatcher CommandDispatcher { get; }
    public IReadOnlyList<TerminalDescriptor> Terminals => _terminals.Values.Select(value => value.Terminal).ToArray();

    public Task RunAsync(CancellationToken cancellationToken = default) =>
        Task.WhenAll(_terminals.Values.Select(terminal => terminal.RunAsync(cancellationToken)));

    public Task HandleFullSnapshotRequestAsync(FullSnapshotRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (_terminals.TryGetValue(request.TerminalInstanceId, out var terminal))
        {
            terminal.RequestFullSnapshot(request.Stream, request.ConnectionEpoch);
        }
        return Task.CompletedTask;
    }

    public Task RequestAllFullSnapshotsAsync()
    {
        foreach (var terminal in _terminals.Values)
        {
            foreach (var stream in SnapshotStreams)
            {
                terminal.RequestFullSnapshot(stream, terminal.Terminal.ConnectionEpoch);
            }
        }
        return Task.CompletedTask;
    }

    public Task<QuoteMessage> GetQuoteAsync(
        QuoteRequestMessage request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!_terminals.TryGetValue(request.TerminalInstanceId, out var terminal))
        {
            throw new InvalidOperationException("terminal_worker_unavailable");
        }
        return terminal.GetQuoteAsync(request, cancellationToken);
    }

    public Task<DataResponseMessage> GetDataAsync(
        DataRequestMessage request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!_terminals.TryGetValue(request.TerminalInstanceId, out var terminal))
        {
            throw new InvalidOperationException("terminal_worker_unavailable");
        }
        return terminal.GetDataAsync(request, cancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var terminal in _terminals.Values)
        {
            await terminal.DisposeAsync();
        }
    }

    private TerminalDescriptor? ResolveTerminal(string terminalInstanceId) =>
        _terminals.TryGetValue(terminalInstanceId, out var terminal) ? terminal.Terminal : null;

    private Task<CommandResultMessage> ExecuteCommandAsync(
        CommandMessage command,
        CancellationToken cancellationToken) =>
        _terminals[command.TerminalInstanceId].ExecuteCommandAsync(command, cancellationToken);
}
