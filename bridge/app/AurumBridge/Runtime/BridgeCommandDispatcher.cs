using System.Collections.Concurrent;
using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Storage;

namespace AurumBridge.Runtime;

public delegate Task<CommandResultMessage> TerminalCommandHandler(
    CommandMessage command,
    CancellationToken cancellationToken);

public sealed class BridgeCommandAdmissionPausedException()
    : InvalidOperationException("bridge_command_admission_paused");

public sealed class BridgeCommandDispatcher
{
    private static readonly HashSet<string> RequiredInitialStreams = new(StringComparer.Ordinal)
    {
        "account",
        "positions",
        "orders",
    };

    private static readonly HashSet<string> SupportedActions = new(StringComparer.Ordinal)
    {
        "place_order",
        "cancel_order",
        "modify_order",
        "modify_position",
        "close_position",
        "query_execution",
    };

    private readonly BridgeStore _store;
    private readonly Func<string, TerminalDescriptor?> _terminalResolver;
    private readonly TerminalCommandHandler _handler;
    private readonly Func<long> _clock;
    private readonly ConcurrentDictionary<string, Lazy<Task<CommandResultMessage>>> _inFlight = new(StringComparer.Ordinal);
    private readonly object _admissionLock = new();
    private readonly Dictionary<string, InitialSyncState> _initialSync = new(StringComparer.Ordinal);
    private bool _acceptingCommands = true;
    private string? _sessionId;

    private sealed record InitialSyncState(long ConnectionEpoch, HashSet<string> Streams);

    public BridgeCommandDispatcher(
        BridgeStore store,
        Func<string, TerminalDescriptor?> terminalResolver,
        TerminalCommandHandler handler,
        Func<long>? clock = null)
    {
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _terminalResolver = terminalResolver ?? throw new ArgumentNullException(nameof(terminalResolver));
        _handler = handler ?? throw new ArgumentNullException(nameof(handler));
        _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public async Task<CommandResultMessage> DispatchAsync(
        CommandMessage command,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        var existing = await _store.GetExecutionReceiptAsync(command.CommandId, cancellationToken);
        if (existing is not null)
        {
            return existing;
        }

        Lazy<Task<CommandResultMessage>> operation;
        lock (_admissionLock)
        {
            if (!_acceptingCommands)
            {
                throw new BridgeCommandAdmissionPausedException();
            }
            operation = _inFlight.GetOrAdd(command.CommandId, _ => new Lazy<Task<CommandResultMessage>>(
                () => DispatchOnceAsync(command, cancellationToken),
                LazyThreadSafetyMode.ExecutionAndPublication));
        }
        try
        {
            return await operation.Value;
        }
        finally
        {
            _inFlight.TryRemove(new KeyValuePair<string, Lazy<Task<CommandResultMessage>>>(command.CommandId, operation));
        }
    }

    public int InFlightCount => _inFlight.Count;

    public void BeginSession(string sessionId, IEnumerable<TerminalDescriptor> terminals)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        ArgumentNullException.ThrowIfNull(terminals);
        lock (_admissionLock)
        {
            _sessionId = sessionId;
            _initialSync.Clear();
            foreach (var terminal in terminals)
            {
                _initialSync[terminal.TerminalInstanceId] = new(
                    terminal.ConnectionEpoch,
                    new(StringComparer.Ordinal));
            }
        }
    }

    public void EndSession(string sessionId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        lock (_admissionLock)
        {
            if (!string.Equals(_sessionId, sessionId, StringComparison.Ordinal))
            {
                return;
            }
            _sessionId = null;
            _initialSync.Clear();
        }
    }

    public bool AcknowledgeInitialSnapshot(string terminalInstanceId, long connectionEpoch, string stream)
    {
        lock (_admissionLock)
        {
            if (_sessionId is null
                || !RequiredInitialStreams.Contains(stream)
                || !_initialSync.TryGetValue(terminalInstanceId, out var state)
                || state.ConnectionEpoch != connectionEpoch)
            {
                return false;
            }
            var wasReady = RequiredInitialStreams.IsSubsetOf(state.Streams);
            state.Streams.Add(stream);
            return !wasReady && RequiredInitialStreams.IsSubsetOf(state.Streams);
        }
    }

    public bool IsInitialSyncReady(string terminalInstanceId, long connectionEpoch)
    {
        lock (_admissionLock)
        {
            return _sessionId is not null
                && _initialSync.TryGetValue(terminalInstanceId, out var state)
                && state.ConnectionEpoch == connectionEpoch
                && RequiredInitialStreams.IsSubsetOf(state.Streams);
        }
    }

    public async Task PauseAndDrainAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        if (timeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(timeout));
        }
        lock (_admissionLock)
        {
            _acceptingCommands = false;
        }
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (!_inFlight.IsEmpty)
        {
            if (DateTimeOffset.UtcNow >= deadline)
            {
                throw new TimeoutException("bridge_command_drain_timeout");
            }
            await Task.Delay(TimeSpan.FromMilliseconds(25), cancellationToken);
        }
    }

    public void Resume()
    {
        lock (_admissionLock)
        {
            _acceptingCommands = true;
        }
    }

    private async Task<CommandResultMessage> DispatchOnceAsync(
        CommandMessage command,
        CancellationToken cancellationToken)
    {
        var existing = await _store.GetExecutionReceiptAsync(command.CommandId, cancellationToken);
        if (existing is not null)
        {
            return existing;
        }

        var validationError = Validate(command);
        CommandResultMessage result;
        if (validationError is not null)
        {
            result = BuildResult(command, "rejected", validationError);
        }
        else
        {
            try
            {
                result = await _handler(command, cancellationToken);
                if (!ResultMatchesCommand(command, result))
                {
                    result = BuildResult(command, "uncertain", "worker_result_route_mismatch");
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                result = BuildResult(command, "uncertain", "worker_execution_cancelled");
            }
            catch
            {
                result = BuildResult(command, "uncertain", "worker_execution_exception");
            }
        }
        await _store.SaveExecutionReceiptAsync(result, cancellationToken: CancellationToken.None);
        return result;
    }

    private string? Validate(CommandMessage command)
    {
        if (command.Version != 3 || command.Type != "command")
        {
            return "command_protocol_invalid";
        }
        if (string.IsNullOrWhiteSpace(command.CommandId))
        {
            return "command_id_invalid";
        }
        if (command.DeadlineUtcMsc <= _clock())
        {
            return "command_expired";
        }
        if (!SupportedActions.Contains(command.Action))
        {
            return "command_action_unsupported";
        }
        var terminal = _terminalResolver(command.TerminalInstanceId);
        if (terminal is null)
        {
            return "terminal_not_found";
        }
        if (terminal.ConnectionEpoch != command.ConnectionEpoch
            || !string.Equals(terminal.AccountRef.Login, command.AccountRef.Login, StringComparison.Ordinal)
            || !string.Equals(terminal.AccountRef.BrokerServer, command.AccountRef.BrokerServer, StringComparison.OrdinalIgnoreCase))
        {
            return "command_route_mismatch";
        }
        if (command.Action != "query_execution"
            && !IsInitialSyncReady(command.TerminalInstanceId, command.ConnectionEpoch))
        {
            return "terminal_initial_sync_pending";
        }
        return null;
    }

    private bool ResultMatchesCommand(CommandMessage command, CommandResultMessage result) =>
        result.Version == 3
        && result.Type == "command_result"
        && string.Equals(result.CommandId, command.CommandId, StringComparison.Ordinal)
        && string.Equals(result.TerminalInstanceId, command.TerminalInstanceId, StringComparison.Ordinal)
        && result.ConnectionEpoch == command.ConnectionEpoch
        && string.Equals(result.AccountRef.Login, command.AccountRef.Login, StringComparison.Ordinal)
        && string.Equals(result.AccountRef.BrokerServer, command.AccountRef.BrokerServer, StringComparison.OrdinalIgnoreCase)
        && result.Status is "succeeded" or "rejected" or "failed" or "uncertain";

    private CommandResultMessage BuildResult(CommandMessage command, string status, string errorCode)
    {
        var now = _clock();
        return new()
        {
            Type = "command_result",
            MessageId = $"result_{Guid.NewGuid():N}",
            SentAtUtcMsc = now,
            CommandId = command.CommandId,
            TerminalInstanceId = command.TerminalInstanceId,
            AccountRef = command.AccountRef,
            ConnectionEpoch = command.ConnectionEpoch,
            Status = status,
            CompletedAtUtcMsc = now,
            ErrorCode = errorCode,
            Evidence = new() { ObservedAtUtcMsc = now },
            RawResult = JsonSerializer.SerializeToElement(new { }),
        };
    }
}
