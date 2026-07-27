using System.Collections.Concurrent;
using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Storage;
using AurumBridge.Workers;

namespace AurumBridge.Runtime;

public sealed class Mt4TerminalRuntime : IBridgeTerminalRuntime
{
    private const long InitialDealLookbackMsc = 7L * 24 * 60 * 60 * 1_000;
    private const long DealPollIntervalMsc = 5_000;
    private static readonly string[] SnapshotStreams = ["account", "positions", "orders"];
    private readonly TerminalDescriptor _terminal;
    private readonly IMt4EaConnection _connection;
    private readonly BridgeStore _store;
    private readonly Func<long> _clock;
    private readonly string _reconnectPipeName;
    private readonly Dictionary<string, long> _revisions = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _latest = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _fullSnapshots = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, long> _streamFreshness = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _collectionWake = new(0, 1);
    private HistoryCursor _dealCursor = HistoryCursor.Empty;
    private bool _dealBackfillPending;
    private bool _dealsEnabled;
    private bool _initialized;

    public Mt4TerminalRuntime(
        TerminalDescriptor terminal,
        IMt4EaConnection connection,
        BridgeStore store,
        string reconnectPipeName,
        Func<long>? clock = null)
    {
        _terminal = terminal ?? throw new ArgumentNullException(nameof(terminal));
        _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        _store = store ?? throw new ArgumentNullException(nameof(store));
        ArgumentException.ThrowIfNullOrWhiteSpace(reconnectPipeName);
        _reconnectPipeName = reconnectPipeName;
        _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public TerminalDescriptor Terminal => _terminal;

    public IReadOnlyDictionary<string, long> GetStreamFreshness() =>
        new Dictionary<string, long>(_streamFreshness, StringComparer.Ordinal);

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        await _connection.SendWelcomeAsync(
            new(_terminal.TerminalInstanceId, _terminal.ConnectionEpoch, _reconnectPipeName),
            cancellationToken);
        foreach (var stream in SnapshotStreams)
        {
            _revisions[stream] = await _store.GetStreamRevisionAsync(
                _terminal.TerminalInstanceId,
                _terminal.ConnectionEpoch,
                stream,
                cancellationToken);
            _fullSnapshots[stream] = 0;
        }
        _dealsEnabled = _connection.SupportsDeals;
        if (_dealsEnabled)
        {
            _revisions["deals"] = await _store.GetStreamRevisionAsync(
                _terminal.TerminalInstanceId, _terminal.ConnectionEpoch, "deals", cancellationToken);
            _dealCursor = await _store.GetHistoryCursorAsync(
                _terminal.TerminalInstanceId, _terminal.AccountRef, "deals", cancellationToken);
            if (_dealCursor == HistoryCursor.Empty)
            {
                _dealCursor = new(Math.Max(1, _clock() - InitialDealLookbackMsc), "0");
            }
            _fullSnapshots["deals"] = 0;
        }
        _initialized = true;
    }

    public async Task RunCollectionLoopAsync(CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        var lastAccountCollection = 0L;
        var lastDealCollection = 0L;
        while (!cancellationToken.IsCancellationRequested)
        {
            var now = _clock();
            var requestedStreams = Mt4CollectionStreams.Positions | Mt4CollectionStreams.Orders;
            if (_fullSnapshots.ContainsKey("account") || now - lastAccountCollection >= 1_000)
            {
                requestedStreams |= Mt4CollectionStreams.Account;
                lastAccountCollection = now;
            }
            var snapshot = await _connection.CollectAsync(requestedStreams, cancellationToken);
            await IngestSnapshotAsync(snapshot, requestedStreams, cancellationToken);
            if (_dealsEnabled
                && (_fullSnapshots.ContainsKey("deals")
                    || _dealBackfillPending
                    || now - lastDealCollection >= DealPollIntervalMsc))
            {
                await CollectDealsAsync(cancellationToken);
                lastDealCollection = now;
            }
            var hasTrades = snapshot.Positions.Count > 0 || snapshot.Orders.Count > 0;
            await _collectionWake.WaitAsync(CollectionDelay(hasTrades), cancellationToken);
        }
    }

    public static TimeSpan CollectionDelay(bool hasActiveTrades) =>
        TimeSpan.FromMilliseconds(hasActiveTrades ? 250 : 1_000);

    public async Task<CommandResultMessage> ExecuteCommandAsync(
        CommandMessage command,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        Mt4TradeCommand localCommand;
        try
        {
            localCommand = Mt4PipeProtocol.CreateTradeCommand(command);
        }
        catch (InvalidDataException error)
        {
            return Rejected(command, error.Message);
        }
        Mt4TradeResult localResult;
        try
        {
            localResult = await _connection.ExecuteAsync(localCommand, cancellationToken);
        }
        finally
        {
            WakeCollection();
        }
        if (!string.Equals(localResult.CommandId, command.CommandId, StringComparison.Ordinal))
        {
            throw new InvalidDataException("mt4_command_result_id_mismatch");
        }
        if (command.Action == "query_execution" && localResult.RawResult is null)
        {
            return Rejected(command, "mt4_query_result_invalid");
        }
        var ticket = localResult.Ticket > 0 ? localResult.Ticket.ToString() : null;
        return new()
        {
            Type = "command_result",
            MessageId = $"result_{command.CommandId}_{localResult.ObservedAtUtcMsc}",
            SentAtUtcMsc = localResult.ObservedAtUtcMsc,
            CommandId = command.CommandId,
            TerminalInstanceId = _terminal.TerminalInstanceId,
            AccountRef = _terminal.AccountRef,
            ConnectionEpoch = _terminal.ConnectionEpoch,
            Status = localResult.Status,
            CompletedAtUtcMsc = localResult.ObservedAtUtcMsc,
            ErrorCode = localResult.ErrorCode,
            ErrorMessage = localResult.ErrorMessage,
            RawResult = localResult.RawResult
                ?? JsonSerializer.SerializeToElement(new { broker_retcode = localResult.BrokerRetcode }),
            Evidence = new()
            {
                ObservedAtUtcMsc = localResult.ObservedAtUtcMsc,
                BrokerRetcode = localResult.BrokerRetcode,
                OrderTickets = command.Action is "place_order" or "cancel_order" or "modify_order"
                    && ticket is not null ? [ticket] : [],
                PositionTickets = command.Action is "close_position" or "modify_position"
                    && ticket is not null ? [ticket] : [],
            },
        };
    }

    private void WakeCollection()
    {
        try
        {
            _collectionWake.Release();
        }
        catch (SemaphoreFullException)
        {
            // Multiple commands can share one immediate follow-up collection.
        }
    }

    public async Task<QuoteMessage> GetQuoteAsync(
        QuoteRequestMessage request,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        var localRequest = Mt4PipeProtocol.CreateQuoteRequest(request);
        var local = await _connection.GetQuoteAsync(localRequest, cancellationToken);
        if (local.RequestId != request.RequestId
            || !BridgeSymbolIdentity.Equivalent(request.Symbol, local.Symbol))
        {
            throw new InvalidDataException("mt4_quote_route_mismatch");
        }
        return new()
        {
            Type = "quote",
            MessageId = $"quote_{request.RequestId}_{Guid.NewGuid():N}",
            SentAtUtcMsc = _clock(),
            RequestId = request.RequestId,
            TerminalInstanceId = _terminal.TerminalInstanceId,
            AccountRef = _terminal.AccountRef,
            ConnectionEpoch = _terminal.ConnectionEpoch,
            Symbol = local.Symbol,
            ObservedAtUtcMsc = local.ObservedAtUtcMsc,
            Status = local.Status,
            Bid = local.Bid,
            Ask = local.Ask,
            TimezoneOffsetMinutes = local.TimezoneOffsetMinutes,
            ClockStatus = local.ClockStatus,
            ErrorCode = local.ErrorCode,
        };
    }

    public async Task<DataResponseMessage> GetDataAsync(
        DataRequestMessage request,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        if (request.Action is not ("rates" or "symbol_snapshot" or "risk_snapshot" or "performance_daily"
            or "symbols" or "history" or "chart_data" or "pending_order_state" or "diagnostics"))
        {
            return RejectedData(request, "terminal_data_action_unavailable");
        }
        if (request.Action is "symbols" or "history" or "chart_data" or "pending_order_state" or "diagnostics")
        {
            if (!_connection.SupportsExtendedData)
            {
                return RejectedData(request, "mt4_ea_update_required");
            }
            Mt4ExtendedDataRequest extendedRequest;
            try
            {
                extendedRequest = Mt4PipeProtocol.CreateExtendedDataRequest(request);
            }
            catch (InvalidDataException error)
            {
                return RejectedData(request, error.Message);
            }
            var extended = await _connection.GetExtendedDataAsync(extendedRequest, cancellationToken);
            if (extended.RequestId != request.RequestId)
            {
                throw new InvalidDataException("mt4_extended_data_route_mismatch");
            }
            return DataResponse(request, extended.ObservedAtUtcMsc, extended.Status,
                extended.Payload, extended.ErrorCode);
        }
        if (request.Action == "risk_snapshot")
        {
            Mt4RiskSnapshotRequest riskRequest;
            try
            {
                riskRequest = Mt4PipeProtocol.CreateRiskSnapshotRequest(request);
            }
            catch (InvalidDataException error)
            {
                return RejectedData(request, error.Message);
            }
            var risk = await _connection.GetRiskSnapshotAsync(riskRequest, cancellationToken);
            if (risk.RequestId != request.RequestId)
            {
                throw new InvalidDataException("mt4_risk_snapshot_route_mismatch");
            }
            return DataResponse(request, risk.ObservedAtUtcMsc, risk.Status, risk.Payload, risk.ErrorCode);
        }
        if (request.Action == "performance_daily")
        {
            Mt4PerformanceDailyRequest performanceRequest;
            try
            {
                performanceRequest = Mt4PipeProtocol.CreatePerformanceDailyRequest(request);
            }
            catch (InvalidDataException error)
            {
                return RejectedData(request, error.Message);
            }
            var performance = await _connection.GetPerformanceDailyAsync(performanceRequest, cancellationToken);
            if (performance.RequestId != request.RequestId)
            {
                throw new InvalidDataException("mt4_performance_route_mismatch");
            }
            return DataResponse(request, performance.ObservedAtUtcMsc, performance.Status,
                performance.Payload, performance.ErrorCode);
        }
        if (request.Action == "symbol_snapshot")
        {
            Mt4SymbolSnapshotRequest symbolRequest;
            try
            {
                symbolRequest = Mt4PipeProtocol.CreateSymbolSnapshotRequest(request);
            }
            catch (InvalidDataException error)
            {
                return RejectedData(request, error.Message);
            }
            var symbol = await _connection.GetSymbolSnapshotAsync(symbolRequest, cancellationToken);
            if (symbol.RequestId != request.RequestId)
            {
                throw new InvalidDataException("mt4_symbol_snapshot_route_mismatch");
            }
            return DataResponse(request, symbol.ObservedAtUtcMsc, symbol.Status, symbol.Payload, symbol.ErrorCode);
        }
        Mt4RatesRequest localRequest;
        try
        {
            localRequest = Mt4PipeProtocol.CreateRatesRequest(request);
        }
        catch (InvalidDataException error)
        {
            return RejectedData(request, error.Message);
        }
        var local = await _connection.GetRatesAsync(localRequest, cancellationToken);
        if (local.RequestId != request.RequestId)
        {
            throw new InvalidDataException("mt4_rates_route_mismatch");
        }
        return new()
        {
            Type = "data_response", MessageId = $"data_{request.RequestId}_{Guid.NewGuid():N}",
            SentAtUtcMsc = _clock(), RequestId = request.RequestId,
            TerminalInstanceId = _terminal.TerminalInstanceId, AccountRef = _terminal.AccountRef,
            ConnectionEpoch = _terminal.ConnectionEpoch, Action = request.Action, Params = request.Params,
            ObservedAtUtcMsc = local.ObservedAtUtcMsc, Status = local.Status,
            Payload = local.Payload, ErrorCode = local.ErrorCode,
        };
    }

    private DataResponseMessage DataResponse(
        DataRequestMessage request, long observedAt, string status, JsonElement? payload, string? errorCode) => new()
    {
        Type = "data_response", MessageId = $"data_{request.RequestId}_{Guid.NewGuid():N}",
        SentAtUtcMsc = _clock(), RequestId = request.RequestId,
        TerminalInstanceId = _terminal.TerminalInstanceId, AccountRef = _terminal.AccountRef,
        ConnectionEpoch = _terminal.ConnectionEpoch, Action = request.Action, Params = request.Params,
        ObservedAtUtcMsc = observedAt, Status = status, Payload = payload, ErrorCode = errorCode,
    };

    public void RequestFullSnapshot(string stream)
    {
        if (!SnapshotStreams.Contains(stream, StringComparer.Ordinal)
            && !(stream == "deals" && _dealsEnabled))
        {
            throw new ArgumentOutOfRangeException(nameof(stream));
        }
        _fullSnapshots[stream] = 0;
    }

    public async Task<int> IngestDealsAsync(
        Mt4DealsBatch batch,
        bool fullSnapshot,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        if (!_dealsEnabled)
        {
            throw new InvalidOperationException("mt4_deals_adapter_unsupported");
        }
        var nextCursor = new HistoryCursor(
            batch.NextTimeMsc,
            batch.NextTicket.ToString(System.Globalization.CultureInfo.InvariantCulture));
        if (CompareCursor(nextCursor, _dealCursor) < 0)
        {
            throw new InvalidDataException("mt4_deals_cursor_regression");
        }
        var previous = _dealCursor;
        foreach (var item in batch.Items)
        {
            var itemCursor = ReadDealCursor(item);
            if (CompareCursor(itemCursor, previous) <= 0
                || CompareCursor(itemCursor, nextCursor) > 0)
            {
                throw new InvalidDataException("mt4_deals_order_invalid");
            }
            previous = itemCursor;
        }
        var observedAt = _clock();
        _streamFreshness["deals"] = observedAt;
        var persisted = 0;
        if (fullSnapshot || batch.Items.Count > 0)
        {
            var revision = _revisions["deals"] + 1;
            var message = new DataDeltaMessage
            {
                Type = "data_delta",
                MessageId = $"delta_{_terminal.TerminalInstanceId}_deals_{revision}_{Guid.NewGuid():N}",
                SentAtUtcMsc = _clock(),
                TerminalInstanceId = _terminal.TerminalInstanceId,
                AccountRef = _terminal.AccountRef,
                ConnectionEpoch = _terminal.ConnectionEpoch,
                Stream = "deals",
                Revision = revision,
                BaseRevision = fullSnapshot ? 0 : _revisions["deals"],
                ObservedAtUtcMsc = observedAt,
                SourceTimeMsc = batch.SourceTimeMsc,
                FullSnapshot = fullSnapshot,
                Upserts = batch.Items,
                Deletes = [],
            };
            var result = await _store.PersistDataDeltaAsync(
                message, cancellationToken, historyCursor: nextCursor);
            if (result.Status is not (PersistDeltaStatus.Applied or PersistDeltaStatus.Duplicate))
            {
                throw new InvalidDataException("mt4_deals_revision_gap");
            }
            _revisions["deals"] = revision;
            persisted = 1;
        }
        else if (batch.HasMore)
        {
            await _store.AdvanceHistoryCursorAsync(
                _terminal.TerminalInstanceId, _terminal.AccountRef, "deals", nextCursor,
                observedAt, cancellationToken);
        }
        _dealCursor = nextCursor;
        _dealBackfillPending = batch.HasMore;
        if (_dealBackfillPending)
        {
            WakeCollection();
        }
        return persisted;
    }

    public async Task<int> IngestSnapshotAsync(
        Mt4Snapshot snapshot,
        CancellationToken cancellationToken = default)
        => await IngestSnapshotAsync(snapshot, Mt4CollectionStreams.All, cancellationToken);

    private async Task<int> IngestSnapshotAsync(
        Mt4Snapshot snapshot,
        Mt4CollectionStreams streams,
        CancellationToken cancellationToken)
    {
        EnsureInitialized();
        var observedAt = _clock();
        var persisted = 0;
        if (streams.HasFlag(Mt4CollectionStreams.Account))
        {
            persisted += await PersistIfChangedAsync(
                "account", [snapshot.Account], observedAt, snapshot.SourceTimeMsc, cancellationToken);
            _streamFreshness["account"] = observedAt;
        }
        if (streams.HasFlag(Mt4CollectionStreams.Positions))
        {
            persisted += await PersistIfChangedAsync(
                "positions", snapshot.Positions, observedAt, snapshot.SourceTimeMsc, cancellationToken);
            _streamFreshness["positions"] = observedAt;
        }
        if (streams.HasFlag(Mt4CollectionStreams.Orders))
        {
            persisted += await PersistIfChangedAsync(
                "orders", snapshot.Orders, observedAt, snapshot.SourceTimeMsc, cancellationToken);
            _streamFreshness["orders"] = observedAt;
        }
        return persisted;
    }

    public ValueTask DisposeAsync() => _connection.DisposeAsync();

    private async Task<int> PersistIfChangedAsync(
        string stream,
        IReadOnlyList<JsonElement> values,
        long observedAt,
        long sourceTimeMsc,
        CancellationToken cancellationToken)
    {
        var fullSnapshot = _fullSnapshots.TryRemove(stream, out _);
        var current = values.ToDictionary(value => ReadKey(value, stream), value => value, StringComparer.Ordinal);
        var currentRaw = current.ToDictionary(pair => pair.Key, pair => pair.Value.GetRawText(), StringComparer.Ordinal);
        var previous = _latest.Where(pair => pair.Key.StartsWith(stream + ":", StringComparison.Ordinal))
            .ToDictionary(pair => pair.Key[(stream.Length + 1)..], pair => pair.Value, StringComparer.Ordinal);
        var upserts = fullSnapshot
            ? current.Values.ToArray()
            : current.Where(pair => !previous.TryGetValue(pair.Key, out var old) || old != pair.Value.GetRawText())
                .Select(pair => pair.Value).ToArray();
        var deletes = fullSnapshot || stream == "account"
            ? []
            : previous.Keys.Where(key => !current.ContainsKey(key))
                .Select(key => JsonSerializer.SerializeToElement(key)).ToArray();
        if (!fullSnapshot && upserts.Length == 0 && deletes.Length == 0)
        {
            return 0;
        }
        var revision = _revisions[stream] + 1;
        var message = new DataDeltaMessage
        {
            Type = "data_delta",
            MessageId = $"delta_{_terminal.TerminalInstanceId}_{stream}_{revision}_{Guid.NewGuid():N}",
            SentAtUtcMsc = _clock(),
            TerminalInstanceId = _terminal.TerminalInstanceId,
            AccountRef = _terminal.AccountRef,
            ConnectionEpoch = _terminal.ConnectionEpoch,
            Stream = stream,
            Revision = revision,
            BaseRevision = fullSnapshot ? 0 : _revisions[stream],
            ObservedAtUtcMsc = observedAt,
            SourceTimeMsc = sourceTimeMsc,
            FullSnapshot = fullSnapshot,
            Upserts = upserts,
            Deletes = deletes,
        };
        var result = await _store.PersistDataDeltaAsync(message, cancellationToken);
        if (result.Status is not (PersistDeltaStatus.Applied or PersistDeltaStatus.Duplicate))
        {
            throw new InvalidDataException("mt4_snapshot_revision_gap");
        }
        foreach (var key in previous.Keys)
        {
            _latest.Remove($"{stream}:{key}");
        }
        foreach (var pair in currentRaw)
        {
            _latest[$"{stream}:{pair.Key}"] = pair.Value;
        }
        _revisions[stream] = revision;
        return 1;
    }

    private async Task CollectDealsAsync(CancellationToken cancellationToken)
    {
        var cursorTicket = ParseCursorTicket(_dealCursor.Ticket);
        var batch = await _connection.CollectDealsAsync(new(
            _terminal.TerminalInstanceId,
            _terminal.AccountRef.BrokerServer,
            _terminal.AccountRef.Login,
            _terminal.ConnectionEpoch,
            _dealCursor.TimeMsc,
            cursorTicket,
            250), cancellationToken);
        var fullSnapshot = _fullSnapshots.TryRemove("deals", out _);
        await IngestDealsAsync(batch, fullSnapshot, cancellationToken);
    }

    private static HistoryCursor ReadDealCursor(JsonElement item)
    {
        if (!item.TryGetProperty("time_msc", out var time)
            || time.ValueKind != JsonValueKind.Number
            || !time.TryGetInt64(out var timeMsc)
            || timeMsc <= 0
            || !item.TryGetProperty("ticket", out var ticket))
        {
            throw new InvalidDataException("mt4_deals_item_invalid");
        }
        var ticketValue = ticket.ValueKind switch
        {
            JsonValueKind.String => ticket.GetString(),
            JsonValueKind.Number => ticket.GetRawText(),
            _ => null,
        };
        if (string.IsNullOrWhiteSpace(ticketValue))
        {
            throw new InvalidDataException("mt4_deals_item_invalid");
        }
        try
        {
            _ = ParseCursorTicket(ticketValue);
        }
        catch (InvalidDataException error)
        {
            throw new InvalidDataException("mt4_deals_item_invalid", error);
        }
        return new(timeMsc, ticketValue);
    }

    private static int CompareCursor(HistoryCursor left, HistoryCursor right)
    {
        var timeComparison = left.TimeMsc.CompareTo(right.TimeMsc);
        if (timeComparison != 0)
        {
            return timeComparison;
        }
        return ParseCursorTicket(left.Ticket).CompareTo(ParseCursorTicket(right.Ticket));
    }

    private static long ParseCursorTicket(string ticket)
    {
        if (!long.TryParse(
                ticket,
                System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture,
                out var value)
            || value < 0)
        {
            throw new InvalidDataException("mt4_deals_cursor_invalid");
        }
        return value;
    }

    private static string ReadKey(JsonElement value, string stream)
    {
        if (stream == "account")
        {
            return "account";
        }
        if (!value.TryGetProperty("ticket", out var ticket))
        {
            throw new InvalidDataException($"mt4_{stream}_ticket_missing");
        }
        return ticket.ValueKind switch
        {
            JsonValueKind.String => ticket.GetString()!,
            JsonValueKind.Number => ticket.GetRawText(),
            _ => throw new InvalidDataException($"mt4_{stream}_ticket_invalid"),
        };
    }

    private CommandResultMessage Rejected(CommandMessage command, string errorCode)
    {
        var now = _clock();
        return new()
        {
            Type = "command_result",
            MessageId = $"result_{command.CommandId}_{now}",
            SentAtUtcMsc = now,
            CommandId = command.CommandId,
            TerminalInstanceId = _terminal.TerminalInstanceId,
            AccountRef = _terminal.AccountRef,
            ConnectionEpoch = _terminal.ConnectionEpoch,
            Status = "rejected",
            CompletedAtUtcMsc = now,
            ErrorCode = errorCode,
            Evidence = new() { ObservedAtUtcMsc = now },
        };
    }

    private DataResponseMessage RejectedData(DataRequestMessage request, string errorCode)
    {
        var now = _clock();
        return new()
        {
            Type = "data_response", MessageId = $"data_{request.RequestId}_{Guid.NewGuid():N}",
            SentAtUtcMsc = now, RequestId = request.RequestId,
            TerminalInstanceId = _terminal.TerminalInstanceId, AccountRef = _terminal.AccountRef,
            ConnectionEpoch = _terminal.ConnectionEpoch, Action = request.Action, Params = request.Params,
            ObservedAtUtcMsc = now, Status = "rejected", ErrorCode = errorCode,
        };
    }

    private void EnsureInitialized()
    {
        if (!_initialized)
        {
            throw new InvalidOperationException("MT4 terminal runtime is not initialized.");
        }
    }
}
