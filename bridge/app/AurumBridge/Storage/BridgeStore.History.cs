using System.Globalization;
using System.Text.Json;
using AurumBridge.Protocol;
using Microsoft.Data.Sqlite;

namespace AurumBridge.Storage;

public sealed record HistoryArchiveBatch(
    IReadOnlyList<JsonElement> Deals,
    IReadOnlyList<JsonElement> HistoryOrders,
    IReadOnlyList<JsonElement> Trades,
    HistoryCursor NextCursor,
    bool HasMore,
    long ObservedAtUtcMsc);

public sealed record HistoryArchiveState(
    HistoryCursor Cursor,
    bool IsComplete,
    long UpdatedAtUtcMsc);

public sealed partial class BridgeStore
{
    private const int MaximumHistoryPageSize = 200;
    private const int MaximumHistoryEvidenceItems = 500;

    private static async Task InitializeHistoryArchiveAsync(
        SqliteConnection connection,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS history_archive_items (
              terminal_instance_id TEXT NOT NULL,
              broker_server TEXT COLLATE NOCASE NOT NULL,
              login_account TEXT NOT NULL,
              platform TEXT NOT NULL,
              item_kind TEXT NOT NULL,
              item_id TEXT NOT NULL,
              event_time_msc INTEGER NOT NULL,
              position_id TEXT,
              order_ticket TEXT,
              symbol TEXT,
              payload_json TEXT NOT NULL,
              updated_at_utc_msc INTEGER NOT NULL,
              PRIMARY KEY (
                terminal_instance_id, broker_server, login_account, item_kind, item_id
              )
            );
            CREATE INDEX IF NOT EXISTS idx_history_archive_page
              ON history_archive_items (
                terminal_instance_id, broker_server, login_account,
                item_kind, event_time_msc DESC, item_id DESC
              );
            CREATE INDEX IF NOT EXISTS idx_history_archive_position
              ON history_archive_items (
                terminal_instance_id, broker_server, login_account,
                item_kind, position_id, event_time_msc
              );
            CREATE TABLE IF NOT EXISTS history_archive_state (
              terminal_instance_id TEXT NOT NULL,
              broker_server TEXT COLLATE NOCASE NOT NULL,
              login_account TEXT NOT NULL,
              cursor_value TEXT NOT NULL,
              is_complete INTEGER NOT NULL DEFAULT 0,
              updated_at_utc_msc INTEGER NOT NULL,
              PRIMARY KEY (terminal_instance_id, broker_server, login_account)
            );
            """;
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<HistoryArchiveState> GetHistoryArchiveStateAsync(
        string terminalInstanceId,
        AccountRef accountRef,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        ValidateHistoryArchiveScope(terminalInstanceId, accountRef);
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT cursor_value, is_complete, updated_at_utc_msc
            FROM history_archive_state
            WHERE terminal_instance_id = $terminal_id
              AND broker_server = $broker_server COLLATE NOCASE
              AND login_account = $login
            LIMIT 1;
            """;
        AddHistoryScope(command, terminalInstanceId, accountRef);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return new(HistoryCursor.Empty, false, 0);
        }
        return new(ParseHistoryCursor(reader.GetString(0)), reader.GetInt64(1) != 0, reader.GetInt64(2));
    }

    public async Task PersistHistoryArchiveBatchAsync(
        TerminalDescriptor terminal,
        HistoryArchiveBatch batch,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        ArgumentNullException.ThrowIfNull(terminal);
        ArgumentNullException.ThrowIfNull(batch);
        ValidateHistoryArchiveScope(terminal.TerminalInstanceId, terminal.AccountRef);
        ValidateHistoryCursor(batch.NextCursor);
        if (batch.ObservedAtUtcMsc <= 0
            || batch.Deals.Count > 250
            || batch.HistoryOrders.Count > 250
            || batch.Trades.Count > 250)
        {
            throw new InvalidDataException("bridge_history_archive_batch_invalid");
        }

        await _writer.WaitAsync(cancellationToken);
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
            await UpsertHistoryItemsAsync(connection, transaction, terminal, "deal", batch.Deals,
                batch.ObservedAtUtcMsc, cancellationToken);
            await UpsertHistoryItemsAsync(connection, transaction, terminal, "history_order", batch.HistoryOrders,
                batch.ObservedAtUtcMsc, cancellationToken);
            await UpsertHistoryItemsAsync(connection, transaction, terminal, "trade", batch.Trades,
                batch.ObservedAtUtcMsc, cancellationToken);

            await using (var current = connection.CreateCommand())
            {
                current.Transaction = (SqliteTransaction)transaction;
                current.CommandText = """
                    SELECT cursor_value FROM history_archive_state
                    WHERE terminal_instance_id = $terminal_id
                      AND broker_server = $broker_server COLLATE NOCASE
                      AND login_account = $login
                    LIMIT 1;
                    """;
                AddHistoryScope(current, terminal.TerminalInstanceId, terminal.AccountRef);
                var currentCursor = ParseHistoryCursor(Convert.ToString(
                    await current.ExecuteScalarAsync(cancellationToken)));
                if (CompareCursor(batch.NextCursor.TimeMsc, batch.NextCursor.Ticket, currentCursor) < 0)
                {
                    throw new InvalidDataException("bridge_history_archive_cursor_regression");
                }
            }
            await using var state = connection.CreateCommand();
            state.Transaction = (SqliteTransaction)transaction;
            state.CommandText = """
                INSERT INTO history_archive_state
                  (terminal_instance_id, broker_server, login_account,
                   cursor_value, is_complete, updated_at_utc_msc)
                VALUES ($terminal_id, $broker_server, $login, $cursor, $complete, $updated_at)
                ON CONFLICT(terminal_instance_id, broker_server, login_account) DO UPDATE SET
                  cursor_value = excluded.cursor_value,
                  is_complete = excluded.is_complete,
                  updated_at_utc_msc = excluded.updated_at_utc_msc;
                """;
            AddHistoryScope(state, terminal.TerminalInstanceId, terminal.AccountRef);
            state.Parameters.AddWithValue("$cursor", JsonSerializer.Serialize(batch.NextCursor, BridgeJson.Options));
            state.Parameters.AddWithValue("$complete", batch.HasMore ? 0 : 1);
            state.Parameters.AddWithValue("$updated_at", batch.ObservedAtUtcMsc);
            await state.ExecuteNonQueryAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        finally
        {
            _writer.Release();
        }
    }

    public async Task<JsonElement> ReadHistoryArchivePageAsync(
        TerminalDescriptor terminal,
        JsonElement parameters,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        ArgumentNullException.ThrowIfNull(terminal);
        ValidateHistoryArchiveScope(terminal.TerminalInstanceId, terminal.AccountRef);
        if (parameters.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException("history_params_invalid");
        }
        var page = ReadInt(parameters, "page", 1, 1, 1_000_000);
        var pageSize = ReadInt(parameters, "page_size", 20, 1, MaximumHistoryPageSize);
        var includeDeals = parameters.TryGetProperty("include_deals", out var include)
            && include.ValueKind == JsonValueKind.True;

        await using var connection = await OpenConnectionAsync(cancellationToken);
        var filter = BuildTradeFilter(parameters);
        var total = await CountTradesAsync(connection, terminal, filter, cancellationToken);
        var trades = await ReadTradePageAsync(
            connection, terminal, filter, page, pageSize, cancellationToken);
        var evidence = includeDeals
            ? await ReadPageEvidenceAsync(connection, terminal, trades, cancellationToken)
            : (Deals: (IReadOnlyList<JsonElement>)[], Orders: (IReadOnlyList<JsonElement>)[], Truncated: false);
        var statistics = await ReadHistoryStatisticsAsync(
            connection, terminal, filter, BuildDateFilter(parameters), total, cancellationToken);
        var state = await GetHistoryArchiveStateAsync(
            terminal.TerminalInstanceId, terminal.AccountRef, cancellationToken);
        return JsonSerializer.SerializeToElement(new
        {
            orders = trades,
            deals = evidence.Deals,
            history_orders = evidence.Orders,
            statistics,
            pagination = new
            {
                current_page = page,
                page_size = pageSize,
                total_count = total,
                total_pages = Math.Max((int)Math.Ceiling(total / (double)pageSize), 1),
            },
            history_sync = new
            {
                complete = state.IsComplete,
                cursor_time_msc = state.Cursor.TimeMsc,
                updated_at_utc_msc = state.UpdatedAtUtcMsc,
                evidence_truncated = evidence.Truncated,
            },
            source = $"{terminal.Platform.ToLowerInvariant()}_sqlite",
        }, BridgeJson.Options);
    }

    private static async Task UpsertHistoryItemsAsync(
        SqliteConnection connection,
        System.Data.Common.DbTransaction transaction,
        TerminalDescriptor terminal,
        string kind,
        IReadOnlyList<JsonElement> items,
        long updatedAtUtcMsc,
        CancellationToken cancellationToken)
    {
        foreach (var item in items)
        {
            var identity = ReadHistoryIdentity(item, kind);
            await using var command = connection.CreateCommand();
            command.Transaction = (SqliteTransaction)transaction;
            command.CommandText = """
                INSERT INTO history_archive_items
                  (terminal_instance_id, broker_server, login_account, platform,
                   item_kind, item_id, event_time_msc, position_id, order_ticket,
                   symbol, payload_json, updated_at_utc_msc)
                VALUES ($terminal_id, $broker_server, $login, $platform,
                        $kind, $item_id, $event_time, $position_id, $order_ticket,
                        $symbol, $payload, $updated_at)
                ON CONFLICT(terminal_instance_id, broker_server, login_account, item_kind, item_id)
                DO UPDATE SET
                  platform = excluded.platform,
                  event_time_msc = excluded.event_time_msc,
                  position_id = excluded.position_id,
                  order_ticket = excluded.order_ticket,
                  symbol = excluded.symbol,
                  payload_json = excluded.payload_json,
                  updated_at_utc_msc = excluded.updated_at_utc_msc;
                """;
            AddHistoryScope(command, terminal.TerminalInstanceId, terminal.AccountRef);
            command.Parameters.AddWithValue("$platform", terminal.Platform.ToLowerInvariant());
            command.Parameters.AddWithValue("$kind", kind);
            command.Parameters.AddWithValue("$item_id", identity.ItemId);
            command.Parameters.AddWithValue("$event_time", identity.EventTimeMsc);
            command.Parameters.AddWithValue("$position_id", (object?)identity.PositionId ?? DBNull.Value);
            command.Parameters.AddWithValue("$order_ticket", (object?)identity.OrderTicket ?? DBNull.Value);
            command.Parameters.AddWithValue("$symbol", (object?)identity.Symbol ?? DBNull.Value);
            command.Parameters.AddWithValue("$payload", item.GetRawText());
            command.Parameters.AddWithValue("$updated_at", updatedAtUtcMsc);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
    }

    private sealed record HistoryIdentity(
        string ItemId, long EventTimeMsc, string? PositionId, string? OrderTicket, string? Symbol);

    private static HistoryIdentity ReadHistoryIdentity(JsonElement item, string kind)
    {
        if (item.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException("bridge_history_archive_item_invalid");
        }
        var itemId = ReadOptionalScalar(item, kind switch
        {
            "deal" => ["deal_ticket", "ticket"],
            "history_order" => ["ticket", "order"],
            "trade" => ["deal_ticket", "ticket", "order"],
            _ => [],
        });
        var eventTime = ReadEventTimeMsc(item, kind);
        if (string.IsNullOrWhiteSpace(itemId) || itemId.Length > 64 || eventTime <= 0)
        {
            throw new InvalidDataException("bridge_history_archive_item_invalid");
        }
        return new(
            itemId,
            eventTime,
            ReadOptionalScalar(item, ["position_id"]),
            ReadOptionalScalar(item, ["order", "order_ticket", "ticket"]),
            ReadOptionalScalar(item, ["symbol"]));
    }

    private static async Task<int> CountTradesAsync(
        SqliteConnection connection,
        TerminalDescriptor terminal,
        HistorySqlFilter filter,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"SELECT COUNT(*) FROM history_archive_items WHERE {HistoryScopeSql} AND item_kind = 'trade'{filter.Sql};";
        AddHistoryScope(command, terminal.TerminalInstanceId, terminal.AccountRef);
        filter.AddParameters(command);
        return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken) ?? 0);
    }

    private static async Task<IReadOnlyList<JsonElement>> ReadTradePageAsync(
        SqliteConnection connection,
        TerminalDescriptor terminal,
        HistorySqlFilter filter,
        int page,
        int pageSize,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
            SELECT payload_json FROM history_archive_items
            WHERE {HistoryScopeSql} AND item_kind = 'trade'{filter.Sql}
            ORDER BY event_time_msc DESC, item_id DESC
            LIMIT $limit OFFSET $offset;
            """;
        AddHistoryScope(command, terminal.TerminalInstanceId, terminal.AccountRef);
        filter.AddParameters(command);
        command.Parameters.AddWithValue("$limit", pageSize);
        command.Parameters.AddWithValue("$offset", (page - 1) * pageSize);
        return await ReadPayloadsAsync(command, cancellationToken);
    }

    private static async Task<(IReadOnlyList<JsonElement> Deals, IReadOnlyList<JsonElement> Orders, bool Truncated)>
        ReadPageEvidenceAsync(
            SqliteConnection connection,
            TerminalDescriptor terminal,
            IReadOnlyList<JsonElement> trades,
            CancellationToken cancellationToken)
    {
        var positions = trades.Select(item => ReadOptionalScalar(item, ["position_id"]))
            .Where(value => !string.IsNullOrWhiteSpace(value)).Cast<string>().Distinct(StringComparer.Ordinal).ToArray();
        var orders = trades.Select(item => ReadOptionalScalar(item, ["order", "ticket"]))
            .Where(value => !string.IsNullOrWhiteSpace(value)).Cast<string>().Distinct(StringComparer.Ordinal).ToArray();
        if (positions.Length == 0 && orders.Length == 0)
        {
            return ([], [], false);
        }
        var deals = await ReadEvidenceKindAsync(
            connection, terminal, "deal", positions, orders, cancellationToken);
        var historyOrders = await ReadEvidenceKindAsync(
            connection, terminal, "history_order", positions, orders, cancellationToken);
        var truncated = deals.Count > MaximumHistoryEvidenceItems || historyOrders.Count > MaximumHistoryEvidenceItems;
        return (
            deals.Take(MaximumHistoryEvidenceItems).ToArray(),
            historyOrders.Take(MaximumHistoryEvidenceItems).ToArray(),
            truncated);
    }

    private static async Task<IReadOnlyList<JsonElement>> ReadEvidenceKindAsync(
        SqliteConnection connection,
        TerminalDescriptor terminal,
        string kind,
        IReadOnlyList<string> positions,
        IReadOnlyList<string> orders,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        var predicates = new List<string>();
        if (positions.Count > 0)
        {
            var names = positions.Select((_, index) => $"$position_{index}").ToArray();
            predicates.Add($"position_id IN ({string.Join(",", names)})");
            for (var index = 0; index < positions.Count; index++)
            {
                command.Parameters.AddWithValue(names[index], positions[index]);
            }
        }
        if (orders.Count > 0)
        {
            var names = orders.Select((_, index) => $"$order_{index}").ToArray();
            predicates.Add($"order_ticket IN ({string.Join(",", names)})");
            for (var index = 0; index < orders.Count; index++)
            {
                command.Parameters.AddWithValue(names[index], orders[index]);
            }
        }
        command.CommandText = $"""
            SELECT payload_json FROM history_archive_items
            WHERE {HistoryScopeSql} AND item_kind = $kind
              AND ({string.Join(" OR ", predicates)})
            ORDER BY event_time_msc, item_id
            LIMIT $evidence_limit;
            """;
        AddHistoryScope(command, terminal.TerminalInstanceId, terminal.AccountRef);
        command.Parameters.AddWithValue("$kind", kind);
        command.Parameters.AddWithValue("$evidence_limit", MaximumHistoryEvidenceItems + 1);
        return await ReadPayloadsAsync(command, cancellationToken);
    }

    private static async Task<object> ReadHistoryStatisticsAsync(
        SqliteConnection connection,
        TerminalDescriptor terminal,
        HistorySqlFilter filter,
        HistorySqlFilter dateFilter,
        int total,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
            SELECT
              COALESCE(SUM(CAST(COALESCE(json_extract(payload_json, '$.net_profit'),
                json_extract(payload_json, '$.profit'), 0) AS REAL)), 0),
              COALESCE(SUM(CAST(COALESCE(json_extract(payload_json, '$.volume'), 0) AS REAL)), 0)
            FROM history_archive_items
            WHERE {HistoryScopeSql} AND item_kind = 'trade'{filter.Sql};
            """;
        AddHistoryScope(command, terminal.TerminalInstanceId, terminal.AccountRef);
        filter.AddParameters(command);
        double totalProfit;
        double totalVolume;
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            await reader.ReadAsync(cancellationToken);
            totalProfit = reader.GetDouble(0);
            totalVolume = reader.GetDouble(1);
        }
        await using var capitalCommand = connection.CreateCommand();
        capitalCommand.CommandText = $"""
            SELECT
              COALESCE(SUM(CASE
                WHEN (platform = 'mt5' AND CAST(COALESCE(json_extract(payload_json, '$.type'), -1) AS INTEGER) = 2
                      OR LOWER(COALESCE(json_extract(payload_json, '$.category'), '')) = 'balance')
                     AND CAST(COALESCE(json_extract(payload_json, '$.profit'), 0) AS REAL) >= 0
                THEN CAST(COALESCE(json_extract(payload_json, '$.profit'), 0) AS REAL) ELSE 0 END), 0),
              COALESCE(SUM(CASE
                WHEN (platform = 'mt5' AND CAST(COALESCE(json_extract(payload_json, '$.type'), -1) AS INTEGER) = 2
                      OR LOWER(COALESCE(json_extract(payload_json, '$.category'), '')) = 'balance')
                     AND CAST(COALESCE(json_extract(payload_json, '$.profit'), 0) AS REAL) < 0
                THEN -CAST(COALESCE(json_extract(payload_json, '$.profit'), 0) AS REAL) ELSE 0 END), 0),
              COALESCE(SUM(CASE
                WHEN platform = 'mt5' AND CAST(COALESCE(json_extract(payload_json, '$.type'), -1) AS INTEGER) = 3
                  OR LOWER(COALESCE(json_extract(payload_json, '$.category'), '')) = 'credit'
                THEN CAST(COALESCE(json_extract(payload_json, '$.profit'), 0) AS REAL) ELSE 0 END), 0)
            FROM history_archive_items
            WHERE {HistoryScopeSql} AND item_kind = 'deal'{dateFilter.Sql};
            """;
        AddHistoryScope(capitalCommand, terminal.TerminalInstanceId, terminal.AccountRef);
        dateFilter.AddParameters(capitalCommand);
        double deposit;
        double withdrawal;
        double credit;
        await using (var reader = await capitalCommand.ExecuteReaderAsync(cancellationToken))
        {
            await reader.ReadAsync(cancellationToken);
            deposit = reader.GetDouble(0);
            withdrawal = reader.GetDouble(1);
            credit = reader.GetDouble(2);
        }
        var balance = await ReadAccountBalanceAsync(connection, terminal, cancellationToken);
        var netResult = totalProfit + credit + deposit - withdrawal;
        return new
        {
            account_principal = Math.Round(balance - netResult, 2),
            account_balance = Math.Round(balance, 2),
            total_profit = Math.Round(totalProfit, 2),
            credit = Math.Round(credit, 2),
            deposit = Math.Round(deposit, 2),
            withdrawal = Math.Round(withdrawal, 2),
            net_result = Math.Round(netResult, 2),
            trade_count = total,
            total_volume = Math.Round(totalVolume, 2),
        };
    }

    private static async Task<double> ReadAccountBalanceAsync(
        SqliteConnection connection,
        TerminalDescriptor terminal,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT CAST(COALESCE(json_extract(payload_json, '$.balance'), 0) AS REAL)
            FROM account_latest WHERE terminal_instance_id = $terminal_id LIMIT 1;
            """;
        command.Parameters.AddWithValue("$terminal_id", terminal.TerminalInstanceId);
        return Convert.ToDouble(await command.ExecuteScalarAsync(cancellationToken) ?? 0.0, CultureInfo.InvariantCulture);
    }

    private sealed record HistorySqlFilter(string Sql, Action<SqliteCommand> AddParameters);

    private static HistorySqlFilter BuildTradeFilter(JsonElement parameters)
    {
        var clauses = new List<string>();
        var values = new Dictionary<string, object>();
        var direction = ReadOptionalText(parameters, "direction").ToUpperInvariant();
        if (direction is "BUY" or "SELL")
        {
            clauses.Add(" AND UPPER(COALESCE(json_extract(payload_json, '$.type'), json_extract(payload_json, '$.side'), '')) = $direction");
            values["$direction"] = direction;
        }
        var profitFilter = ReadOptionalText(parameters, "profit_filter").ToLowerInvariant();
        if (profitFilter == "profit")
        {
            clauses.Add(" AND CAST(COALESCE(json_extract(payload_json, '$.net_profit'), json_extract(payload_json, '$.profit'), 0) AS REAL) > 0");
        }
        else if (profitFilter == "loss")
        {
            clauses.Add(" AND CAST(COALESCE(json_extract(payload_json, '$.net_profit'), json_extract(payload_json, '$.profit'), 0) AS REAL) < 0");
        }
        AddDateBoundary(parameters, "date_from", "$date_from", ">=", clauses, values, endOfDay:false);
        AddDateBoundary(parameters, "entry_from", "$entry_from", ">=", clauses, values, endOfDay:false);
        AddDateBoundary(parameters, "date_to", "$date_to", "<=", clauses, values, endOfDay:true);
        AddDateBoundary(parameters, "entry_to", "$entry_to", "<=", clauses, values, endOfDay:true);
        return new(string.Concat(clauses), command =>
        {
            foreach (var pair in values)
            {
                command.Parameters.AddWithValue(pair.Key, pair.Value);
            }
        });
    }

    private static HistorySqlFilter BuildDateFilter(JsonElement parameters)
    {
        var clauses = new List<string>();
        var values = new Dictionary<string, object>();
        AddDateBoundary(parameters, "date_from", "$capital_date_from", ">=", clauses, values, endOfDay:false);
        AddDateBoundary(parameters, "date_to", "$capital_date_to", "<=", clauses, values, endOfDay:true);
        return new(string.Concat(clauses), command =>
        {
            foreach (var pair in values)
            {
                command.Parameters.AddWithValue(pair.Key, pair.Value);
            }
        });
    }

    private static void AddDateBoundary(
        JsonElement parameters,
        string property,
        string parameter,
        string comparison,
        List<string> clauses,
        Dictionary<string, object> values,
        bool endOfDay)
    {
        var text = ReadOptionalText(parameters, property);
        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }
        if (!DateTimeOffset.TryParseExact(text[..Math.Min(10, text.Length)], "yyyy-MM-dd",
                CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date))
        {
            throw new InvalidDataException("history_date_range_invalid");
        }
        var timestamp = (endOfDay ? date.AddDays(1).AddMilliseconds(-1) : date).ToUnixTimeMilliseconds();
        clauses.Add($" AND event_time_msc {comparison} {parameter}");
        values[parameter] = timestamp;
    }

    private static async Task<IReadOnlyList<JsonElement>> ReadPayloadsAsync(
        SqliteCommand command,
        CancellationToken cancellationToken)
    {
        var result = new List<JsonElement>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            using var document = JsonDocument.Parse(reader.GetString(0));
            result.Add(document.RootElement.Clone());
        }
        return result;
    }

    private static int ReadInt(JsonElement parameters, string property, int fallback, int minimum, int maximum)
    {
        if (!parameters.TryGetProperty(property, out var value))
        {
            return fallback;
        }
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var result)
            || result < minimum || result > maximum)
        {
            throw new InvalidDataException("history_pagination_invalid");
        }
        return result;
    }

    private static string ReadOptionalText(JsonElement item, string property) =>
        item.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()?.Trim() ?? string.Empty
            : string.Empty;

    private static string? ReadOptionalScalar(JsonElement item, IReadOnlyList<string> properties)
    {
        foreach (var property in properties)
        {
            if (!item.TryGetProperty(property, out var value))
            {
                continue;
            }
            var result = value.ValueKind switch
            {
                JsonValueKind.String => value.GetString(),
                JsonValueKind.Number => value.GetRawText(),
                _ => null,
            };
            if (!string.IsNullOrWhiteSpace(result))
            {
                return result;
            }
        }
        return null;
    }

    private static long ReadEventTimeMsc(JsonElement item, string kind)
    {
        foreach (var property in new[] { "time_msc", "close_time_msc", "event_time_msc" })
        {
            if (item.TryGetProperty(property, out var value)
                && value.ValueKind == JsonValueKind.Number
                && value.TryGetInt64(out var timestamp)
                && timestamp > 0)
            {
                return timestamp;
            }
        }
        foreach (var property in kind == "history_order"
                     ? new[] { "time_done", "time_setup", "time" }
                     : new[] { "close_time", "time", "entry_time" })
        {
            var value = ReadOptionalText(item, property);
            if (DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var timestamp))
            {
                return timestamp.ToUnixTimeMilliseconds();
            }
        }
        return 0;
    }

    private static void ValidateHistoryArchiveScope(string terminalInstanceId, AccountRef accountRef)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(terminalInstanceId);
        ArgumentNullException.ThrowIfNull(accountRef);
        if (string.IsNullOrWhiteSpace(accountRef.BrokerServer) || string.IsNullOrWhiteSpace(accountRef.Login))
        {
            throw new InvalidDataException("bridge_history_archive_scope_invalid");
        }
    }

    private const string HistoryScopeSql = """
        terminal_instance_id = $terminal_id
        AND broker_server = $broker_server COLLATE NOCASE
        AND login_account = $login
        """;

    private static void AddHistoryScope(SqliteCommand command, string terminalInstanceId, AccountRef accountRef)
    {
        command.Parameters.AddWithValue("$terminal_id", terminalInstanceId);
        command.Parameters.AddWithValue("$broker_server", accountRef.BrokerServer);
        command.Parameters.AddWithValue("$login", accountRef.Login);
    }
}
