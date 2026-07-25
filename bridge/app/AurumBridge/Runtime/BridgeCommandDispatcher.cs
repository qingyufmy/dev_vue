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
    private static readonly HashSet<string> SupportedActions = new(StringComparer.Ordinal)
    {
        "place_order",
        "cancel_order",
        "modify_order",
        "close_position",
        "query_execution",
    };

    private readonly BridgeStore _store;
    private readonly Func<string, TerminalDescriptor?> _terminalResolver;
    private readonly TerminalCommandHandler _handler;
    private readonly Func<long> _clock;
    private readonly ConcurrentDictionary<string, Lazy<Task<CommandResultMessage>>> _inFlight = new(StringComparer.Ordinal);
    private readonly object _admissionLock = new();
    private bool _acceptingCommands = true;

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
