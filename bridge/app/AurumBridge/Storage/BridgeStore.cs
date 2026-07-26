using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using AurumBridge.Protocol;
using Microsoft.Data.Sqlite;

namespace AurumBridge.Storage;

public enum PersistDeltaStatus
{
    Applied,
    Duplicate,
    Gap,
}

public sealed record PersistDeltaResult(PersistDeltaStatus Status, long CurrentRevision, long ExpectedRevision);

public sealed record HistoryCursor(
    [property: JsonPropertyName("time_msc")] long TimeMsc,
    [property: JsonPropertyName("ticket")] string Ticket)
{
    public static readonly HistoryCursor Empty = new(0, "0");
}

public sealed record OutboxMessage(
    long Id,
    string MessageId,
    string MessageType,
    string Priority,
    string PayloadJson,
    int AttemptCount,
    long CreatedAtUtcMsc);

public sealed record TerminalBinding(
    string TerminalInstanceId,
    string Platform,
    string TerminalPath,
    AccountRef AccountRef,
    long ConnectionEpoch,
    long UpdatedAtUtcMsc)
{
    public TerminalDescriptor ToDescriptor(string? workerVersion = null) => new()
    {
        TerminalInstanceId = TerminalInstanceId,
        Platform = Platform,
        AccountRef = AccountRef,
        ConnectionEpoch = ConnectionEpoch,
        WorkerVersion = workerVersion,
    };
}

public sealed class BridgeStore : IAsyncDisposable
{
    private const int DefaultReceiptLimit = 2_000;
    private const int DefaultDataOutboxLimitPerStream = 256;
    private static readonly HashSet<string> SupportedStreams = new(StringComparer.Ordinal)
    {
        "account",
        "positions",
        "orders",
        "deals",
    };

    private readonly string _connectionString;
    private readonly SemaphoreSlim _writer = new(1, 1);
    private bool _initialized;
    private sealed record LocalRevision(long Revision, string MessageId, string PayloadHash);

    public BridgeStore(string databasePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        var fullPath = Path.GetFullPath(databasePath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = fullPath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared,
            Pooling = true,
        }.ToString();
    }

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        await _writer.WaitAsync(cancellationToken);
        try
        {
            if (_initialized)
            {
                return;
            }

            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = SchemaSql;
            await command.ExecuteNonQueryAsync(cancellationToken);
            await MigrateAccountScopedHistoryAsync(connection, cancellationToken);
            _initialized = true;
        }
        finally
        {
            _writer.Release();
        }
    }

    public async Task<string> GetJournalModeAsync(CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA journal_mode;";
        return Convert.ToString(await command.ExecuteScalarAsync(cancellationToken)) ?? string.Empty;
    }

    public async Task<long> GetStreamRevisionAsync(
        string terminalInstanceId,
        long connectionEpoch,
        string stream,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT revision FROM stream_revisions
            WHERE terminal_instance_id = $terminal_id
              AND connection_epoch = $epoch
              AND stream = $stream;
            """;
        command.Parameters.AddWithValue("$terminal_id", terminalInstanceId);
        command.Parameters.AddWithValue("$epoch", connectionEpoch);
        command.Parameters.AddWithValue("$stream", stream);
        return Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken) ?? 0L);
    }

    public async Task<PersistDeltaResult> PersistDataDeltaAsync(
        DataDeltaMessage message,
        CancellationToken cancellationToken = default,
        int dataOutboxLimitPerStream = DefaultDataOutboxLimitPerStream,
        HistoryCursor? historyCursor = null)
    {
        ArgumentNullException.ThrowIfNull(message);
        ValidateDelta(message);
        EnsureInitialized();
        dataOutboxLimitPerStream = Math.Clamp(dataOutboxLimitPerStream, 2, 10_000);

        await _writer.WaitAsync(cancellationToken);
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
            var payloadJson = JsonSerializer.Serialize(message, BridgeJson.Options);
            var payloadHash = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(payloadJson))).ToLowerInvariant();
            var current = await GetCurrentRevisionAsync(connection, transaction, message, cancellationToken);
            var currentRevision = current?.Revision ?? 0;
            if (message.Revision == currentRevision)
            {
                if (current is null
                    || !string.Equals(current.MessageId, message.MessageId, StringComparison.Ordinal)
                    || !string.Equals(current.PayloadHash, payloadHash, StringComparison.Ordinal))
                {
                    throw new InvalidDataException("bridge_data_revision_conflict");
                }
                await transaction.RollbackAsync(cancellationToken);
                return new(PersistDeltaStatus.Duplicate, currentRevision, currentRevision + 1);
            }
            if (message.Revision < currentRevision
                || (!message.FullSnapshot && message.BaseRevision != currentRevision))
            {
                await transaction.RollbackAsync(cancellationToken);
                return new(PersistDeltaStatus.Gap, currentRevision, currentRevision + 1);
            }

            if (message.Stream == "account")
            {
                await PersistAccountAsync(connection, transaction, message, cancellationToken);
            }
            else if (message.Stream == "deals")
            {
                await PersistDealsAsync(
                    connection, transaction, message, historyCursor, cancellationToken);
            }
            else
            {
                await PersistCollectionAsync(connection, transaction, message, cancellationToken);
            }
            await SetCurrentRevisionAsync(connection, transaction, message, payloadHash, cancellationToken);
            var pendingForStream = await CountPendingDataForStreamAsync(
                connection, transaction, message, cancellationToken);
            var outboxMessage = message;
            if (message.FullSnapshot || pendingForStream >= dataOutboxLimitPerStream - 1)
            {
                if (!message.FullSnapshot || message.Stream == "deals")
                {
                    outboxMessage = message with
                    {
                        BaseRevision = 0,
                        FullSnapshot = true,
                        Upserts = await ReadLatestStreamAsync(
                            connection, transaction, message.TerminalInstanceId, message.AccountRef,
                            message.Stream,
                            cancellationToken),
                        Deletes = [],
                    };
                }
                await DeletePendingDataForStreamAsync(
                    connection, transaction, message, cancellationToken);
                payloadJson = JsonSerializer.Serialize(outboxMessage, BridgeJson.Options);
            }
            await EnqueueOutboxAsync(
                connection, transaction, outboxMessage, payloadJson, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(PersistDeltaStatus.Applied, message.Revision, message.Revision + 1);
        }
        finally
        {
            _writer.Release();
        }
    }

    public async Task<IReadOnlyList<OutboxMessage>> GetPendingOutboxAsync(
        int limit = 100,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        limit = Math.Clamp(limit, 1, 1_000);
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, message_id, message_type, priority, payload_json, attempt_count, created_at_utc_msc
            FROM outbox_messages
            WHERE acked_at_utc_msc IS NULL
            ORDER BY CASE priority WHEN 'trade' THEN 0 ELSE 1 END, id
            LIMIT $limit;
            """;
        command.Parameters.AddWithValue("$limit", limit);
        var result = new List<OutboxMessage>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            result.Add(new(
                reader.GetInt64(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetInt32(5),
                reader.GetInt64(6)));
        }
        return result;
    }

    public async Task<IReadOnlyList<OutboxMessage>> GetReadyOutboxAsync(
        long nowUtcMsc,
        int limit = 100,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        if (nowUtcMsc <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(nowUtcMsc));
        }
        limit = Math.Clamp(limit, 1, 1_000);
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, message_id, message_type, priority, payload_json, attempt_count, created_at_utc_msc
            FROM outbox_messages
            WHERE acked_at_utc_msc IS NULL
              AND (next_attempt_at_utc_msc IS NULL OR next_attempt_at_utc_msc <= $now)
            ORDER BY CASE priority WHEN 'trade' THEN 0 ELSE 1 END, id
            LIMIT $limit;
            """;
        command.Parameters.AddWithValue("$now", nowUtcMsc);
        command.Parameters.AddWithValue("$limit", limit);
        var result = new List<OutboxMessage>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            result.Add(new(
                reader.GetInt64(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetInt32(5),
                reader.GetInt64(6)));
        }
        return result;
    }

    public async Task<bool> RecordOutboxAttemptAsync(
        string messageId,
        int expectedAttemptCount,
        long nextAttemptAtUtcMsc,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        ArgumentException.ThrowIfNullOrWhiteSpace(messageId);
        if (expectedAttemptCount < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(expectedAttemptCount));
        }
        if (nextAttemptAtUtcMsc <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(nextAttemptAtUtcMsc));
        }

        await _writer.WaitAsync(cancellationToken);
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
                UPDATE outbox_messages
                SET attempt_count = attempt_count + 1,
                    next_attempt_at_utc_msc = $next_attempt
                WHERE message_id = $message_id
                  AND acked_at_utc_msc IS NULL
                  AND attempt_count = $expected_attempt_count;
                """;
            command.Parameters.AddWithValue("$message_id", messageId);
            command.Parameters.AddWithValue("$expected_attempt_count", expectedAttemptCount);
            command.Parameters.AddWithValue("$next_attempt", nextAttemptAtUtcMsc);
            return await command.ExecuteNonQueryAsync(cancellationToken) == 1;
        }
        finally
        {
            _writer.Release();
        }
    }

    public async Task<OutboxMessage?> GetPendingOutboxMessageAsync(
        string messageId,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        ArgumentException.ThrowIfNullOrWhiteSpace(messageId);
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, message_id, message_type, priority, payload_json, attempt_count, created_at_utc_msc
            FROM outbox_messages
            WHERE message_id = $message_id AND acked_at_utc_msc IS NULL
            LIMIT 1;
            """;
        command.Parameters.AddWithValue("$message_id", messageId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }
        return new(
            reader.GetInt64(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetInt32(5),
            reader.GetInt64(6));
    }

    public async Task<bool> AcknowledgeOutboxAsync(
        string messageId,
        string acknowledgementStatus,
        long acknowledgedAtUtcMsc,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        if (acknowledgementStatus is not ("applied" or "duplicate"))
        {
            return false;
        }

        await _writer.WaitAsync(cancellationToken);
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
            string? payloadJson;
            await using (var read = connection.CreateCommand())
            {
                read.Transaction = (SqliteTransaction)transaction;
                read.CommandText = """
                    SELECT payload_json FROM outbox_messages
                    WHERE message_id = $message_id AND acked_at_utc_msc IS NULL
                    LIMIT 1;
                    """;
                read.Parameters.AddWithValue("$message_id", messageId);
                payloadJson = Convert.ToString(await read.ExecuteScalarAsync(cancellationToken));
            }
            if (string.IsNullOrWhiteSpace(payloadJson))
            {
                await transaction.RollbackAsync(cancellationToken);
                return false;
            }
            await using (var delete = connection.CreateCommand())
            {
                delete.Transaction = (SqliteTransaction)transaction;
                delete.CommandText = """
                    DELETE FROM outbox_messages
                    WHERE message_id = $message_id AND acked_at_utc_msc IS NULL;
                    """;
                delete.Parameters.AddWithValue("$message_id", messageId);
                if (await delete.ExecuteNonQueryAsync(cancellationToken) != 1)
                {
                    await transaction.RollbackAsync(cancellationToken);
                    return false;
                }
            }
            DataDeltaMessage? acknowledgedDelta = null;
            using (var payload = JsonDocument.Parse(payloadJson))
            {
                if (payload.RootElement.TryGetProperty("type", out var type)
                    && type.GetString() == "data_delta")
                {
                    acknowledgedDelta = payload.RootElement.Deserialize<DataDeltaMessage>(BridgeJson.Options);
                }
            }
            if (acknowledgedDelta?.Stream == "deals")
            {
                foreach (var item in acknowledgedDelta.Upserts)
                {
                    await using var prune = connection.CreateCommand();
                    prune.Transaction = (SqliteTransaction)transaction;
                    prune.CommandText = """
                        DELETE FROM deals_pending
                        WHERE terminal_instance_id = $terminal_id
                          AND broker_server = $broker_server COLLATE NOCASE
                          AND login_account = $login
                          AND ticket = $ticket;
                        """;
                    prune.Parameters.AddWithValue("$terminal_id", acknowledgedDelta.TerminalInstanceId);
                    prune.Parameters.AddWithValue("$broker_server", acknowledgedDelta.AccountRef.BrokerServer);
                    prune.Parameters.AddWithValue("$login", acknowledgedDelta.AccountRef.Login);
                    prune.Parameters.AddWithValue("$ticket", ReadTicket(item, "deals"));
                    await prune.ExecuteNonQueryAsync(cancellationToken);
                }
            }
            await transaction.CommitAsync(cancellationToken);
            return true;
        }
        finally
        {
            _writer.Release();
        }
    }

    public async Task<HistoryCursor> GetHistoryCursorAsync(
        string terminalInstanceId,
        AccountRef accountRef,
        string stream,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        ArgumentException.ThrowIfNullOrWhiteSpace(terminalInstanceId);
        ArgumentNullException.ThrowIfNull(accountRef);
        ArgumentException.ThrowIfNullOrWhiteSpace(stream);
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT cursor_value FROM history_cursors
            WHERE terminal_instance_id = $terminal_id
              AND broker_server = $broker_server COLLATE NOCASE
              AND login_account = $login
              AND stream = $stream
            LIMIT 1;
            """;
        command.Parameters.AddWithValue("$terminal_id", terminalInstanceId);
        command.Parameters.AddWithValue("$broker_server", accountRef.BrokerServer);
        command.Parameters.AddWithValue("$login", accountRef.Login);
        command.Parameters.AddWithValue("$stream", stream);
        return ParseHistoryCursor(Convert.ToString(await command.ExecuteScalarAsync(cancellationToken)));
    }

    public async Task AdvanceHistoryCursorAsync(
        string terminalInstanceId,
        AccountRef accountRef,
        string stream,
        HistoryCursor cursor,
        long updatedAtUtcMsc,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        ArgumentException.ThrowIfNullOrWhiteSpace(terminalInstanceId);
        ArgumentNullException.ThrowIfNull(accountRef);
        ArgumentException.ThrowIfNullOrWhiteSpace(stream);
        ValidateHistoryCursor(cursor);
        await _writer.WaitAsync(cancellationToken);
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
            await SetHistoryCursorAsync(
                connection, transaction, terminalInstanceId, accountRef, stream, cursor, updatedAtUtcMsc,
                cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        finally
        {
            _writer.Release();
        }
    }

    public async Task<int> CountPendingDealsAsync(
        string terminalInstanceId,
        AccountRef accountRef,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        ArgumentException.ThrowIfNullOrWhiteSpace(terminalInstanceId);
        ArgumentNullException.ThrowIfNull(accountRef);
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT COUNT(*) FROM deals_pending
            WHERE terminal_instance_id = $terminal_id
              AND broker_server = $broker_server COLLATE NOCASE
              AND login_account = $login;
            """;
        command.Parameters.AddWithValue("$terminal_id", terminalInstanceId);
        command.Parameters.AddWithValue("$broker_server", accountRef.BrokerServer);
        command.Parameters.AddWithValue("$login", accountRef.Login);
        return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken) ?? 0);
    }

    public async Task SaveExecutionReceiptAsync(
        CommandResultMessage result,
        int receiptLimit = DefaultReceiptLimit,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(result);
        EnsureInitialized();
        receiptLimit = Math.Clamp(receiptLimit, 1, 100_000);
        var payload = JsonSerializer.Serialize(result, BridgeJson.Options);

        await _writer.WaitAsync(cancellationToken);
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
            await using (var command = connection.CreateCommand())
            {
                command.Transaction = (SqliteTransaction)transaction;
                command.CommandText = """
                    INSERT INTO execution_receipts
                      (command_id, terminal_instance_id, connection_epoch, status, result_json, completed_at_utc_msc)
                    VALUES ($command_id, $terminal_id, $epoch, $status, $result_json, $completed_at)
                    ON CONFLICT(command_id) DO UPDATE SET
                      terminal_instance_id = excluded.terminal_instance_id,
                      connection_epoch = excluded.connection_epoch,
                      status = excluded.status,
                      result_json = excluded.result_json,
                      completed_at_utc_msc = excluded.completed_at_utc_msc;
                    """;
                command.Parameters.AddWithValue("$command_id", result.CommandId);
                command.Parameters.AddWithValue("$terminal_id", result.TerminalInstanceId);
                command.Parameters.AddWithValue("$epoch", result.ConnectionEpoch);
                command.Parameters.AddWithValue("$status", result.Status);
                command.Parameters.AddWithValue("$result_json", payload);
                command.Parameters.AddWithValue("$completed_at", result.CompletedAtUtcMsc);
                await command.ExecuteNonQueryAsync(cancellationToken);
            }
            await using (var outbox = connection.CreateCommand())
            {
                outbox.Transaction = (SqliteTransaction)transaction;
                outbox.CommandText = """
                    INSERT INTO outbox_messages
                      (message_id, message_type, terminal_instance_id, connection_epoch, priority,
                       payload_json, created_at_utc_msc)
                    VALUES ($message_id, 'command_result', $terminal_id, $epoch, 'trade',
                            $payload, $created_at)
                    ON CONFLICT(message_id) DO NOTHING;
                    """;
                outbox.Parameters.AddWithValue("$message_id", result.MessageId);
                outbox.Parameters.AddWithValue("$terminal_id", result.TerminalInstanceId);
                outbox.Parameters.AddWithValue("$epoch", result.ConnectionEpoch);
                outbox.Parameters.AddWithValue("$payload", payload);
                outbox.Parameters.AddWithValue("$created_at", result.SentAtUtcMsc);
                await outbox.ExecuteNonQueryAsync(cancellationToken);
            }
            await using (var trim = connection.CreateCommand())
            {
                trim.Transaction = (SqliteTransaction)transaction;
                trim.CommandText = """
                    DELETE FROM execution_receipts
                    WHERE command_id IN (
                      SELECT command_id
                      FROM execution_receipts
                      ORDER BY completed_at_utc_msc DESC, command_id DESC
                      LIMIT -1 OFFSET $receipt_limit
                    )
                    AND NOT EXISTS (
                      SELECT 1
                      FROM outbox_messages pending
                      WHERE pending.acked_at_utc_msc IS NULL
                        AND pending.message_type = 'command_result'
                        AND json_valid(pending.payload_json) = 1
                        AND json_extract(pending.payload_json, '$.command_id') = execution_receipts.command_id
                    );
                    """;
                trim.Parameters.AddWithValue("$receipt_limit", receiptLimit);
                await trim.ExecuteNonQueryAsync(cancellationToken);
            }
            await transaction.CommitAsync(cancellationToken);
        }
        finally
        {
            _writer.Release();
        }
    }

    public async Task<CommandResultMessage?> GetExecutionReceiptAsync(
        string commandId,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        ArgumentException.ThrowIfNullOrWhiteSpace(commandId);
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT result_json FROM execution_receipts
            WHERE command_id = $command_id
            LIMIT 1;
            """;
        command.Parameters.AddWithValue("$command_id", commandId);
        var payload = Convert.ToString(await command.ExecuteScalarAsync(cancellationToken));
        return string.IsNullOrWhiteSpace(payload)
            ? null
            : JsonSerializer.Deserialize<CommandResultMessage>(payload, BridgeJson.Options);
    }

    public async Task<int> CountExecutionReceiptsAsync(CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM execution_receipts;";
        return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken));
    }

    public async Task<TerminalBinding> ActivateTerminalBindingAsync(
        string terminalInstanceId,
        string platform,
        string terminalPath,
        AccountRef accountRef,
        long updatedAtUtcMsc,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        var normalized = NormalizeTerminalBinding(
            terminalInstanceId,
            platform,
            terminalPath,
            accountRef,
            updatedAtUtcMsc);
        await _writer.WaitAsync(cancellationToken);
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
            long previousEpoch;
            await using (var current = connection.CreateCommand())
            {
                current.Transaction = (SqliteTransaction)transaction;
                current.CommandText = """
                    SELECT connection_epoch FROM terminal_bindings
                    WHERE terminal_instance_id = $terminal_id;
                    """;
                current.Parameters.AddWithValue("$terminal_id", normalized.TerminalInstanceId);
                previousEpoch = Convert.ToInt64(await current.ExecuteScalarAsync(cancellationToken) ?? 0L);
            }
            if (previousEpoch == long.MaxValue)
            {
                throw new InvalidOperationException("terminal_connection_epoch_exhausted");
            }
            var binding = normalized with { ConnectionEpoch = previousEpoch + 1 };
            await using (var upsert = connection.CreateCommand())
            {
                upsert.Transaction = (SqliteTransaction)transaction;
                upsert.CommandText = """
                    INSERT INTO terminal_bindings
                      (terminal_instance_id, platform, terminal_path, broker_server, login_account,
                       connection_epoch, updated_at_utc_msc)
                    VALUES ($terminal_id, $platform, $terminal_path, $broker_server, $login,
                            $epoch, $updated_at)
                    ON CONFLICT(terminal_instance_id) DO UPDATE SET
                      platform = excluded.platform,
                      terminal_path = excluded.terminal_path,
                      broker_server = excluded.broker_server,
                      login_account = excluded.login_account,
                      connection_epoch = excluded.connection_epoch,
                      updated_at_utc_msc = excluded.updated_at_utc_msc;
                    """;
                AddTerminalBindingParameters(upsert, binding);
                await upsert.ExecuteNonQueryAsync(cancellationToken);
            }
            await using (var pruneStaleEpochState = connection.CreateCommand())
            {
                pruneStaleEpochState.Transaction = (SqliteTransaction)transaction;
                pruneStaleEpochState.CommandText = """
                    DELETE FROM outbox_messages
                    WHERE terminal_instance_id = $terminal_id
                      AND message_type = 'data_delta'
                      AND connection_epoch < $epoch;
                    DELETE FROM stream_revisions
                    WHERE terminal_instance_id = $terminal_id
                      AND connection_epoch < $epoch;
                    """;
                pruneStaleEpochState.Parameters.AddWithValue("$terminal_id", binding.TerminalInstanceId);
                pruneStaleEpochState.Parameters.AddWithValue("$epoch", binding.ConnectionEpoch);
                await pruneStaleEpochState.ExecuteNonQueryAsync(cancellationToken);
            }
            await transaction.CommitAsync(cancellationToken);
            return binding;
        }
        finally
        {
            _writer.Release();
        }
    }

    public async Task<IReadOnlyList<TerminalBinding>> GetTerminalBindingsAsync(
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT terminal_instance_id, platform, terminal_path, broker_server, login_account,
                   connection_epoch, updated_at_utc_msc
            FROM terminal_bindings
            ORDER BY terminal_instance_id;
            """;
        var bindings = new List<TerminalBinding>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            bindings.Add(new(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                new(reader.GetString(3), reader.GetString(4)),
                reader.GetInt64(5),
                reader.GetInt64(6)));
        }
        return bindings;
    }

    private async Task<SqliteConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;";
        await command.ExecuteNonQueryAsync(cancellationToken);
        return connection;
    }

    private static TerminalBinding NormalizeTerminalBinding(
        string terminalInstanceId,
        string platform,
        string terminalPath,
        AccountRef accountRef,
        long updatedAtUtcMsc)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(terminalInstanceId);
        ArgumentException.ThrowIfNullOrWhiteSpace(platform);
        ArgumentException.ThrowIfNullOrWhiteSpace(terminalPath);
        ArgumentNullException.ThrowIfNull(accountRef);
        var normalizedPlatform = platform.Trim().ToLowerInvariant();
        if (normalizedPlatform is not ("mt4" or "mt5"))
        {
            throw new ArgumentOutOfRangeException(nameof(platform), platform, "Unsupported terminal platform.");
        }
        if (string.IsNullOrWhiteSpace(accountRef.BrokerServer)
            || string.IsNullOrWhiteSpace(accountRef.Login)
            || updatedAtUtcMsc <= 0)
        {
            throw new ArgumentException("Terminal binding identity is incomplete.");
        }
        return new(
            terminalInstanceId.Trim(),
            normalizedPlatform,
            Path.GetFullPath(terminalPath.Trim()),
            new(accountRef.BrokerServer.Trim(), accountRef.Login.Trim()),
            ConnectionEpoch: 0,
            updatedAtUtcMsc);
    }

    private static void AddTerminalBindingParameters(SqliteCommand command, TerminalBinding binding)
    {
        command.Parameters.AddWithValue("$terminal_id", binding.TerminalInstanceId);
        command.Parameters.AddWithValue("$platform", binding.Platform);
        command.Parameters.AddWithValue("$terminal_path", binding.TerminalPath);
        command.Parameters.AddWithValue("$broker_server", binding.AccountRef.BrokerServer);
        command.Parameters.AddWithValue("$login", binding.AccountRef.Login);
        command.Parameters.AddWithValue("$epoch", binding.ConnectionEpoch);
        command.Parameters.AddWithValue("$updated_at", binding.UpdatedAtUtcMsc);
    }

    private static async Task<LocalRevision?> GetCurrentRevisionAsync(
        SqliteConnection connection,
        System.Data.Common.DbTransaction transaction,
        DataDeltaMessage message,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = (SqliteTransaction)transaction;
        command.CommandText = """
            SELECT revision, message_id, payload_hash FROM stream_revisions
            WHERE terminal_instance_id = $terminal_id
              AND connection_epoch = $epoch
              AND stream = $stream;
            """;
        command.Parameters.AddWithValue("$terminal_id", message.TerminalInstanceId);
        command.Parameters.AddWithValue("$epoch", message.ConnectionEpoch);
        command.Parameters.AddWithValue("$stream", message.Stream);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }
        return new(reader.GetInt64(0), reader.GetString(1), reader.GetString(2));
    }

    private static async Task SetCurrentRevisionAsync(
        SqliteConnection connection,
        System.Data.Common.DbTransaction transaction,
        DataDeltaMessage message,
        string payloadHash,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = (SqliteTransaction)transaction;
        command.CommandText = """
            INSERT INTO stream_revisions
              (terminal_instance_id, connection_epoch, stream, revision, message_id, payload_hash,
               observed_at_utc_msc, source_time_msc)
            VALUES ($terminal_id, $epoch, $stream, $revision, $message_id, $payload_hash,
                    $observed_at, $source_time)
            ON CONFLICT(terminal_instance_id, connection_epoch, stream) DO UPDATE SET
              revision = excluded.revision,
              message_id = excluded.message_id,
              payload_hash = excluded.payload_hash,
              observed_at_utc_msc = excluded.observed_at_utc_msc,
              source_time_msc = excluded.source_time_msc;
            """;
        AddDeltaParameters(command, message);
        command.Parameters.AddWithValue("$message_id", message.MessageId);
        command.Parameters.AddWithValue("$payload_hash", payloadHash);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task PersistAccountAsync(
        SqliteConnection connection,
        System.Data.Common.DbTransaction transaction,
        DataDeltaMessage message,
        CancellationToken cancellationToken)
    {
        if (message.Upserts.Count != 1 || message.Deletes.Count != 0
            || message.Upserts[0].ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException("bridge_account_delta_invalid");
        }
        await using var command = connection.CreateCommand();
        command.Transaction = (SqliteTransaction)transaction;
        command.CommandText = """
            INSERT INTO account_latest
              (terminal_instance_id, connection_epoch, revision, observed_at_utc_msc, source_time_msc, payload_json)
            VALUES ($terminal_id, $epoch, $revision, $observed_at, $source_time, $payload)
            ON CONFLICT(terminal_instance_id) DO UPDATE SET
              connection_epoch = excluded.connection_epoch,
              revision = excluded.revision,
              observed_at_utc_msc = excluded.observed_at_utc_msc,
              source_time_msc = excluded.source_time_msc,
              payload_json = excluded.payload_json;
            """;
        AddDeltaParameters(command, message);
        command.Parameters.AddWithValue("$payload", message.Upserts[0].GetRawText());
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task PersistCollectionAsync(
        SqliteConnection connection,
        System.Data.Common.DbTransaction transaction,
        DataDeltaMessage message,
        CancellationToken cancellationToken)
    {
        var table = message.Stream == "positions" ? "positions_latest" : "orders_latest";
        if (message.FullSnapshot)
        {
            await using var clear = connection.CreateCommand();
            clear.Transaction = (SqliteTransaction)transaction;
            clear.CommandText = $"DELETE FROM {table} WHERE terminal_instance_id = $terminal_id;";
            clear.Parameters.AddWithValue("$terminal_id", message.TerminalInstanceId);
            await clear.ExecuteNonQueryAsync(cancellationToken);
        }

        foreach (var item in message.Upserts)
        {
            var ticket = ReadTicket(item, message.Stream);
            await using var upsert = connection.CreateCommand();
            upsert.Transaction = (SqliteTransaction)transaction;
            upsert.CommandText = $"""
                INSERT INTO {table}
                  (terminal_instance_id, ticket, connection_epoch, revision, observed_at_utc_msc, source_time_msc, payload_json)
                VALUES ($terminal_id, $ticket, $epoch, $revision, $observed_at, $source_time, $payload)
                ON CONFLICT(terminal_instance_id, ticket) DO UPDATE SET
                  connection_epoch = excluded.connection_epoch,
                  revision = excluded.revision,
                  observed_at_utc_msc = excluded.observed_at_utc_msc,
                  source_time_msc = excluded.source_time_msc,
                  payload_json = excluded.payload_json;
                """;
            AddDeltaParameters(upsert, message);
            upsert.Parameters.AddWithValue("$ticket", ticket);
            upsert.Parameters.AddWithValue("$payload", item.GetRawText());
            await upsert.ExecuteNonQueryAsync(cancellationToken);
        }
        foreach (var item in message.Deletes)
        {
            var ticket = ReadScalarTicket(item, message.Stream);
            await using var delete = connection.CreateCommand();
            delete.Transaction = (SqliteTransaction)transaction;
            delete.CommandText = $"""
                DELETE FROM {table}
                WHERE terminal_instance_id = $terminal_id AND ticket = $ticket;
                """;
            delete.Parameters.AddWithValue("$terminal_id", message.TerminalInstanceId);
            delete.Parameters.AddWithValue("$ticket", ticket);
            await delete.ExecuteNonQueryAsync(cancellationToken);
        }
    }

    private static async Task PersistDealsAsync(
        SqliteConnection connection,
        System.Data.Common.DbTransaction transaction,
        DataDeltaMessage message,
        HistoryCursor? historyCursor,
        CancellationToken cancellationToken)
    {
        if (message.Deletes.Count != 0)
        {
            throw new InvalidDataException("bridge_deals_delete_invalid");
        }
        var cursor = HistoryCursor.Empty;
        foreach (var item in message.Upserts)
        {
            var ticket = ReadTicket(item, "deals");
            var timeMsc = ReadDealTimeMsc(item);
            if (CompareCursor(timeMsc, ticket, cursor) > 0)
            {
                cursor = new(timeMsc, ticket);
            }
            await using var upsert = connection.CreateCommand();
            upsert.Transaction = (SqliteTransaction)transaction;
            upsert.CommandText = """
                INSERT INTO deals_pending
                  (terminal_instance_id, broker_server, login_account, ticket,
                   connection_epoch, revision, deal_time_msc,
                   observed_at_utc_msc, source_time_msc, payload_json)
                VALUES ($terminal_id, $broker_server, $login, $ticket,
                        $epoch, $revision, $deal_time,
                        $observed_at, $source_time, $payload)
                ON CONFLICT(terminal_instance_id, broker_server, login_account, ticket) DO UPDATE SET
                  connection_epoch = excluded.connection_epoch,
                  revision = excluded.revision,
                  deal_time_msc = excluded.deal_time_msc,
                  observed_at_utc_msc = excluded.observed_at_utc_msc,
                  source_time_msc = excluded.source_time_msc,
                  payload_json = excluded.payload_json;
                """;
            AddDeltaParameters(upsert, message);
            upsert.Parameters.AddWithValue("$broker_server", message.AccountRef.BrokerServer);
            upsert.Parameters.AddWithValue("$login", message.AccountRef.Login);
            upsert.Parameters.AddWithValue("$ticket", ticket);
            upsert.Parameters.AddWithValue("$deal_time", timeMsc);
            upsert.Parameters.AddWithValue("$payload", item.GetRawText());
            await upsert.ExecuteNonQueryAsync(cancellationToken);
        }
        var nextCursor = historyCursor ?? cursor;
        if (cursor.TimeMsc > 0 && CompareCursor(nextCursor.TimeMsc, nextCursor.Ticket, cursor) < 0)
        {
            throw new InvalidDataException("bridge_history_cursor_before_deals");
        }
        if (nextCursor.TimeMsc <= 0)
        {
            return;
        }
        await SetHistoryCursorAsync(
            connection, transaction, message.TerminalInstanceId, message.AccountRef, "deals", nextCursor,
            message.ObservedAtUtcMsc, cancellationToken);
    }

    private static async Task SetHistoryCursorAsync(
        SqliteConnection connection,
        System.Data.Common.DbTransaction transaction,
        string terminalInstanceId,
        AccountRef accountRef,
        string stream,
        HistoryCursor cursor,
        long updatedAtUtcMsc,
        CancellationToken cancellationToken)
    {
        ValidateHistoryCursor(cursor);
        await using (var read = connection.CreateCommand())
        {
            read.Transaction = (SqliteTransaction)transaction;
            read.CommandText = """
                SELECT cursor_value FROM history_cursors
                WHERE terminal_instance_id = $terminal_id
                  AND broker_server = $broker_server COLLATE NOCASE
                  AND login_account = $login
                  AND stream = $stream
                LIMIT 1;
                """;
            read.Parameters.AddWithValue("$terminal_id", terminalInstanceId);
            read.Parameters.AddWithValue("$broker_server", accountRef.BrokerServer);
            read.Parameters.AddWithValue("$login", accountRef.Login);
            read.Parameters.AddWithValue("$stream", stream);
            var current = ParseHistoryCursor(Convert.ToString(
                await read.ExecuteScalarAsync(cancellationToken)));
            if (CompareCursor(cursor.TimeMsc, cursor.Ticket, current) < 0)
            {
                throw new InvalidDataException("bridge_history_cursor_regression");
            }
        }
        await using var update = connection.CreateCommand();
        update.Transaction = (SqliteTransaction)transaction;
        update.CommandText = """
            INSERT INTO history_cursors
              (terminal_instance_id, broker_server, login_account, stream, cursor_value, updated_at_utc_msc)
            VALUES ($terminal_id, $broker_server, $login, $stream, $cursor, $updated_at)
            ON CONFLICT(terminal_instance_id, broker_server, login_account, stream) DO UPDATE SET
              cursor_value = excluded.cursor_value,
              updated_at_utc_msc = excluded.updated_at_utc_msc;
            """;
        update.Parameters.AddWithValue("$terminal_id", terminalInstanceId);
        update.Parameters.AddWithValue("$broker_server", accountRef.BrokerServer);
        update.Parameters.AddWithValue("$login", accountRef.Login);
        update.Parameters.AddWithValue("$stream", stream);
        update.Parameters.AddWithValue("$cursor", JsonSerializer.Serialize(cursor, BridgeJson.Options));
        update.Parameters.AddWithValue("$updated_at", updatedAtUtcMsc);
        await update.ExecuteNonQueryAsync(cancellationToken);
    }

    private static HistoryCursor ParseHistoryCursor(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return HistoryCursor.Empty;
        }
        try
        {
            var cursor = JsonSerializer.Deserialize<HistoryCursor>(value, BridgeJson.Options)
                ?? throw new InvalidDataException("bridge_history_cursor_invalid");
            ValidateHistoryCursor(cursor);
            return cursor;
        }
        catch (JsonException)
        {
            throw new InvalidDataException("bridge_history_cursor_invalid");
        }
    }

    private static void ValidateHistoryCursor(HistoryCursor cursor)
    {
        ArgumentNullException.ThrowIfNull(cursor);
        if (cursor.TimeMsc < 0 || string.IsNullOrWhiteSpace(cursor.Ticket) || cursor.Ticket.Length > 64
            || cursor.Ticket.Any(character => !char.IsAsciiDigit(character)))
        {
            throw new InvalidDataException("bridge_history_cursor_invalid");
        }
    }

    private static async Task MigrateAccountScopedHistoryAsync(
        SqliteConnection connection,
        CancellationToken cancellationToken)
    {
        var dealsAreScoped = await TableHasColumnAsync(
            connection, "deals_pending", "broker_server", cancellationToken);
        var cursorsAreScoped = await TableHasColumnAsync(
            connection, "history_cursors", "broker_server", cancellationToken);
        if (!dealsAreScoped || !cursorsAreScoped)
        {
            await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
            if (!dealsAreScoped)
            {
                await using var migrateDeals = connection.CreateCommand();
                migrateDeals.Transaction = (SqliteTransaction)transaction;
                migrateDeals.CommandText = """
                ALTER TABLE deals_pending RENAME TO deals_pending_legacy;
                CREATE TABLE deals_pending (
                  terminal_instance_id TEXT NOT NULL,
                  broker_server TEXT COLLATE NOCASE NOT NULL,
                  login_account TEXT NOT NULL,
                  ticket TEXT NOT NULL,
                  connection_epoch INTEGER NOT NULL,
                  revision INTEGER NOT NULL,
                  deal_time_msc INTEGER NOT NULL,
                  observed_at_utc_msc INTEGER NOT NULL,
                  source_time_msc INTEGER,
                  payload_json TEXT NOT NULL,
                  PRIMARY KEY (terminal_instance_id, broker_server, login_account, ticket)
                );
                INSERT INTO deals_pending
                  (terminal_instance_id, broker_server, login_account, ticket,
                   connection_epoch, revision, deal_time_msc, observed_at_utc_msc,
                   source_time_msc, payload_json)
                SELECT legacy.terminal_instance_id, binding.broker_server, binding.login_account,
                       legacy.ticket, legacy.connection_epoch, legacy.revision,
                       legacy.deal_time_msc, legacy.observed_at_utc_msc,
                       legacy.source_time_msc, legacy.payload_json
                FROM deals_pending_legacy AS legacy
                INNER JOIN terminal_bindings AS binding
                  ON binding.terminal_instance_id = legacy.terminal_instance_id;
                DROP TABLE deals_pending_legacy;
                """;
                await migrateDeals.ExecuteNonQueryAsync(cancellationToken);
            }
            if (!cursorsAreScoped)
            {
                await using var migrateCursors = connection.CreateCommand();
                migrateCursors.Transaction = (SqliteTransaction)transaction;
                migrateCursors.CommandText = """
                ALTER TABLE history_cursors RENAME TO history_cursors_legacy;
                CREATE TABLE history_cursors (
                  terminal_instance_id TEXT NOT NULL,
                  broker_server TEXT COLLATE NOCASE NOT NULL,
                  login_account TEXT NOT NULL,
                  stream TEXT NOT NULL,
                  cursor_value TEXT NOT NULL,
                  updated_at_utc_msc INTEGER NOT NULL,
                  PRIMARY KEY (terminal_instance_id, broker_server, login_account, stream)
                );
                INSERT INTO history_cursors
                  (terminal_instance_id, broker_server, login_account, stream,
                   cursor_value, updated_at_utc_msc)
                SELECT legacy.terminal_instance_id, binding.broker_server, binding.login_account,
                       legacy.stream, legacy.cursor_value, legacy.updated_at_utc_msc
                FROM history_cursors_legacy AS legacy
                INNER JOIN terminal_bindings AS binding
                  ON binding.terminal_instance_id = legacy.terminal_instance_id;
                DROP TABLE history_cursors_legacy;
                """;
                await migrateCursors.ExecuteNonQueryAsync(cancellationToken);
            }
            await transaction.CommitAsync(cancellationToken);
        }

        await using var ensureIndex = connection.CreateCommand();
        ensureIndex.CommandText = """
            CREATE INDEX IF NOT EXISTS idx_deals_pending_cursor
              ON deals_pending
                (terminal_instance_id, broker_server, login_account, deal_time_msc, ticket);
            """;
        await ensureIndex.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<bool> TableHasColumnAsync(
        SqliteConnection connection,
        string tableName,
        string columnName,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA table_info({tableName});";
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            if (string.Equals(reader.GetString(1), columnName, StringComparison.Ordinal))
            {
                return true;
            }
        }
        return false;
    }

    private static async Task EnqueueOutboxAsync(
        SqliteConnection connection,
        System.Data.Common.DbTransaction transaction,
        DataDeltaMessage message,
        string payloadJson,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = (SqliteTransaction)transaction;
        command.CommandText = """
            INSERT INTO outbox_messages
              (message_id, message_type, terminal_instance_id, connection_epoch, priority,
               payload_json, created_at_utc_msc)
            VALUES ($message_id, 'data_delta', $terminal_id, $epoch, 'data', $payload, $created_at);
            """;
        command.Parameters.AddWithValue("$message_id", message.MessageId);
        command.Parameters.AddWithValue("$terminal_id", message.TerminalInstanceId);
        command.Parameters.AddWithValue("$epoch", message.ConnectionEpoch);
        command.Parameters.AddWithValue("$payload", payloadJson);
        command.Parameters.AddWithValue("$created_at", message.SentAtUtcMsc);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<int> CountPendingDataForStreamAsync(
        SqliteConnection connection,
        System.Data.Common.DbTransaction transaction,
        DataDeltaMessage message,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = (SqliteTransaction)transaction;
        command.CommandText = """
            SELECT COUNT(*) FROM outbox_messages
            WHERE acked_at_utc_msc IS NULL
              AND message_type = 'data_delta'
              AND terminal_instance_id = $terminal_id
              AND connection_epoch = $epoch
              AND json_valid(payload_json) = 1
              AND json_extract(payload_json, '$.stream') = $stream;
            """;
        command.Parameters.AddWithValue("$terminal_id", message.TerminalInstanceId);
        command.Parameters.AddWithValue("$epoch", message.ConnectionEpoch);
        command.Parameters.AddWithValue("$stream", message.Stream);
        return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken) ?? 0);
    }

    private static async Task DeletePendingDataForStreamAsync(
        SqliteConnection connection,
        System.Data.Common.DbTransaction transaction,
        DataDeltaMessage message,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = (SqliteTransaction)transaction;
        command.CommandText = """
            DELETE FROM outbox_messages
            WHERE acked_at_utc_msc IS NULL
              AND message_type = 'data_delta'
              AND terminal_instance_id = $terminal_id
              AND connection_epoch = $epoch
              AND json_valid(payload_json) = 1
              AND json_extract(payload_json, '$.stream') = $stream;
            """;
        command.Parameters.AddWithValue("$terminal_id", message.TerminalInstanceId);
        command.Parameters.AddWithValue("$epoch", message.ConnectionEpoch);
        command.Parameters.AddWithValue("$stream", message.Stream);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<IReadOnlyList<JsonElement>> ReadLatestStreamAsync(
        SqliteConnection connection,
        System.Data.Common.DbTransaction transaction,
        string terminalInstanceId,
        AccountRef accountRef,
        string stream,
        CancellationToken cancellationToken)
    {
        var table = stream switch
        {
            "account" => "account_latest",
            "positions" => "positions_latest",
            "orders" => "orders_latest",
            "deals" => "deals_pending",
            _ => throw new InvalidDataException("bridge_data_stream_invalid"),
        };
        await using var command = connection.CreateCommand();
        command.Transaction = (SqliteTransaction)transaction;
        command.CommandText = stream == "account"
            ? $"SELECT payload_json FROM {table} WHERE terminal_instance_id = $terminal_id;"
            : stream == "deals"
                ? $"SELECT payload_json FROM {table} WHERE terminal_instance_id = $terminal_id AND broker_server = $broker_server COLLATE NOCASE AND login_account = $login ORDER BY deal_time_msc, ticket;"
                : $"SELECT payload_json FROM {table} WHERE terminal_instance_id = $terminal_id ORDER BY ticket;";
        command.Parameters.AddWithValue("$terminal_id", terminalInstanceId);
        if (stream == "deals")
        {
            command.Parameters.AddWithValue("$broker_server", accountRef.BrokerServer);
            command.Parameters.AddWithValue("$login", accountRef.Login);
        }
        var items = new List<JsonElement>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            using var document = JsonDocument.Parse(reader.GetString(0));
            items.Add(document.RootElement.Clone());
        }
        return items;
    }

    private static void AddDeltaParameters(SqliteCommand command, DataDeltaMessage message)
    {
        command.Parameters.AddWithValue("$terminal_id", message.TerminalInstanceId);
        command.Parameters.AddWithValue("$epoch", message.ConnectionEpoch);
        command.Parameters.AddWithValue("$stream", message.Stream);
        command.Parameters.AddWithValue("$revision", message.Revision);
        command.Parameters.AddWithValue("$observed_at", message.ObservedAtUtcMsc);
        command.Parameters.AddWithValue("$source_time", (object?)message.SourceTimeMsc ?? DBNull.Value);
    }

    private static string ReadTicket(JsonElement item, string stream)
    {
        if (item.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException($"bridge_{stream}_item_invalid");
        }
        if (item.TryGetProperty("ticket", out var ticket))
        {
            return ReadScalarTicket(ticket, stream);
        }
        var fallback = stream switch
        {
            "positions" => "position_id",
            "orders" => "order_id",
            "deals" => "deal_ticket",
            _ => string.Empty,
        };
        if (item.TryGetProperty(fallback, out ticket))
        {
            return ReadScalarTicket(ticket, stream);
        }
        if (stream == "deals" && item.TryGetProperty("deal", out ticket))
        {
            return ReadScalarTicket(ticket, stream);
        }
        throw new InvalidDataException($"bridge_{stream}_ticket_invalid");
    }

    private static long ReadDealTimeMsc(JsonElement item)
    {
        if (item.TryGetProperty("time_msc", out var timeMsc)
            && timeMsc.ValueKind == JsonValueKind.Number
            && timeMsc.TryGetInt64(out var value)
            && value > 0)
        {
            return value;
        }
        if (item.TryGetProperty("time", out var time)
            && time.ValueKind == JsonValueKind.Number
            && time.TryGetInt64(out value)
            && value > 0
            && value <= long.MaxValue / 1_000)
        {
            return value * 1_000;
        }
        throw new InvalidDataException("bridge_deals_time_invalid");
    }

    private static int CompareCursor(long timeMsc, string ticket, HistoryCursor cursor)
    {
        var timeComparison = timeMsc.CompareTo(cursor.TimeMsc);
        return timeComparison != 0
            ? timeComparison
            : string.CompareOrdinal(ticket.PadLeft(64, '0'), cursor.Ticket.PadLeft(64, '0'));
    }

    private static string ReadScalarTicket(JsonElement value, string stream)
    {
        var ticket = value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            _ => null,
        };
        if (string.IsNullOrWhiteSpace(ticket) || ticket.Length > 64)
        {
            throw new InvalidDataException($"bridge_{stream}_ticket_invalid");
        }
        return ticket;
    }

    private static void ValidateDelta(DataDeltaMessage message)
    {
        if (message.Version != 3 || message.Type != "data_delta")
        {
            throw new InvalidDataException("bridge_data_type_invalid");
        }
        if (!SupportedStreams.Contains(message.Stream))
        {
            throw new InvalidDataException("bridge_data_stream_not_implemented");
        }
        if (message.ConnectionEpoch <= 0 || message.Revision <= 0 || message.BaseRevision < 0)
        {
            throw new InvalidDataException("bridge_data_revision_invalid");
        }
        if (message.FullSnapshot && message.BaseRevision != 0)
        {
            throw new InvalidDataException("bridge_full_snapshot_base_invalid");
        }
        if (!message.FullSnapshot && message.Revision != message.BaseRevision + 1)
        {
            throw new InvalidDataException("bridge_data_revision_not_next");
        }
    }

    private void EnsureInitialized()
    {
        if (!_initialized)
        {
            throw new InvalidOperationException("BridgeStore.InitializeAsync must be called first.");
        }
    }

    public ValueTask DisposeAsync()
    {
        _writer.Dispose();
        SqliteConnection.ClearAllPools();
        return ValueTask.CompletedTask;
    }

    private const string SchemaSql = """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        PRAGMA foreign_keys=ON;
        PRAGMA busy_timeout=5000;

        CREATE TABLE IF NOT EXISTS terminal_bindings (
          terminal_instance_id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          terminal_path TEXT NOT NULL,
          broker_server TEXT NOT NULL,
          login_account TEXT NOT NULL,
          connection_epoch INTEGER NOT NULL,
          updated_at_utc_msc INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stream_revisions (
          terminal_instance_id TEXT NOT NULL,
          connection_epoch INTEGER NOT NULL,
          stream TEXT NOT NULL,
          revision INTEGER NOT NULL,
          message_id TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          observed_at_utc_msc INTEGER NOT NULL,
          source_time_msc INTEGER,
          PRIMARY KEY (terminal_instance_id, connection_epoch, stream)
        );
        CREATE TABLE IF NOT EXISTS account_latest (
          terminal_instance_id TEXT PRIMARY KEY,
          connection_epoch INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          observed_at_utc_msc INTEGER NOT NULL,
          source_time_msc INTEGER,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS positions_latest (
          terminal_instance_id TEXT NOT NULL,
          ticket TEXT NOT NULL,
          connection_epoch INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          observed_at_utc_msc INTEGER NOT NULL,
          source_time_msc INTEGER,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (terminal_instance_id, ticket)
        );
        CREATE TABLE IF NOT EXISTS orders_latest (
          terminal_instance_id TEXT NOT NULL,
          ticket TEXT NOT NULL,
          connection_epoch INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          observed_at_utc_msc INTEGER NOT NULL,
          source_time_msc INTEGER,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (terminal_instance_id, ticket)
        );
        CREATE TABLE IF NOT EXISTS deals_pending (
          terminal_instance_id TEXT NOT NULL,
          broker_server TEXT COLLATE NOCASE NOT NULL,
          login_account TEXT NOT NULL,
          ticket TEXT NOT NULL,
          connection_epoch INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          deal_time_msc INTEGER NOT NULL,
          observed_at_utc_msc INTEGER NOT NULL,
          source_time_msc INTEGER,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (terminal_instance_id, broker_server, login_account, ticket)
        );
        CREATE TABLE IF NOT EXISTS history_cursors (
          terminal_instance_id TEXT NOT NULL,
          broker_server TEXT COLLATE NOCASE NOT NULL,
          login_account TEXT NOT NULL,
          stream TEXT NOT NULL,
          cursor_value TEXT NOT NULL,
          updated_at_utc_msc INTEGER NOT NULL,
          PRIMARY KEY (terminal_instance_id, broker_server, login_account, stream)
        );
        CREATE TABLE IF NOT EXISTS outbox_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL UNIQUE,
          message_type TEXT NOT NULL,
          terminal_instance_id TEXT NOT NULL,
          connection_epoch INTEGER NOT NULL,
          priority TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at_utc_msc INTEGER,
          created_at_utc_msc INTEGER NOT NULL,
          acked_at_utc_msc INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_ready
          ON outbox_messages (acked_at_utc_msc, priority, id);
        CREATE INDEX IF NOT EXISTS idx_outbox_retry_ready
          ON outbox_messages
            (acked_at_utc_msc, next_attempt_at_utc_msc, priority, id);
        CREATE INDEX IF NOT EXISTS idx_outbox_stream_scope
          ON outbox_messages
            (terminal_instance_id, connection_epoch, message_type, acked_at_utc_msc);
        CREATE TABLE IF NOT EXISTS execution_receipts (
          command_id TEXT PRIMARY KEY,
          terminal_instance_id TEXT NOT NULL,
          connection_epoch INTEGER NOT NULL,
          status TEXT NOT NULL,
          result_json TEXT NOT NULL,
          completed_at_utc_msc INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_execution_receipts_completed
          ON execution_receipts (completed_at_utc_msc DESC);
        CREATE TABLE IF NOT EXISTS module_versions (
          module_id TEXT PRIMARY KEY,
          version TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          updated_at_utc_msc INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS update_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          active_version TEXT,
          staged_version TEXT,
          last_known_good_version TEXT,
          status TEXT NOT NULL,
          updated_at_utc_msc INTEGER NOT NULL
        );
        """;
}
