using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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
        int dataOutboxLimitPerStream = DefaultDataOutboxLimitPerStream)
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
                if (!message.FullSnapshot)
                {
                    outboxMessage = message with
                    {
                        BaseRevision = 0,
                        FullSnapshot = true,
                        Upserts = await ReadLatestStreamAsync(
                            connection, transaction, message.TerminalInstanceId, message.Stream,
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
            await using var command = connection.CreateCommand();
            command.CommandText = """
                DELETE FROM outbox_messages
                WHERE message_id = $message_id AND acked_at_utc_msc IS NULL;
                """;
            command.Parameters.AddWithValue("$message_id", messageId);
            return await command.ExecuteNonQueryAsync(cancellationToken) == 1;
        }
        finally
        {
            _writer.Release();
        }
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
            await using (var trim = connection.CreateCommand())
            {
                trim.Transaction = (SqliteTransaction)transaction;
                trim.CommandText = """
                    DELETE FROM execution_receipts
                    WHERE command_id IN (
                      SELECT command_id FROM execution_receipts
                      ORDER BY completed_at_utc_msc DESC, command_id DESC
                      LIMIT -1 OFFSET $receipt_limit
                    );
                    """;
                trim.Parameters.AddWithValue("$receipt_limit", receiptLimit);
                await trim.ExecuteNonQueryAsync(cancellationToken);
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
        string stream,
        CancellationToken cancellationToken)
    {
        var table = stream switch
        {
            "account" => "account_latest",
            "positions" => "positions_latest",
            "orders" => "orders_latest",
            _ => throw new InvalidDataException("bridge_data_stream_invalid"),
        };
        await using var command = connection.CreateCommand();
        command.Transaction = (SqliteTransaction)transaction;
        command.CommandText = stream == "account"
            ? $"SELECT payload_json FROM {table} WHERE terminal_instance_id = $terminal_id;"
            : $"SELECT payload_json FROM {table} WHERE terminal_instance_id = $terminal_id ORDER BY ticket;";
        command.Parameters.AddWithValue("$terminal_id", terminalInstanceId);
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
        var fallback = stream == "positions" ? "position_id" : "order_id";
        if (item.TryGetProperty(fallback, out ticket))
        {
            return ReadScalarTicket(ticket, stream);
        }
        throw new InvalidDataException($"bridge_{stream}_ticket_invalid");
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
        CREATE TABLE IF NOT EXISTS history_cursors (
          terminal_instance_id TEXT NOT NULL,
          stream TEXT NOT NULL,
          cursor_value TEXT NOT NULL,
          updated_at_utc_msc INTEGER NOT NULL,
          PRIMARY KEY (terminal_instance_id, stream)
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
