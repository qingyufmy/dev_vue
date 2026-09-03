using System;
using System.Data;
using System.Data.SQLite;
using System.IO;
using System.Collections.Generic;

namespace Liangjian.BridgeV4.Storage
{
    public sealed class CommandAcceptance
    {
        public CommandAcceptance(bool duplicate, string state)
        {
            Duplicate = duplicate;
            State = state;
        }

        public bool Duplicate { get; private set; }
        public string State { get; private set; }
    }

    public sealed class CommandLedgerRecord
    {
        public string ProfileId { get; internal set; }
        public string CommandId { get; internal set; }
        public string IdempotencyKey { get; internal set; }
        public string Action { get; internal set; }
        public string RequestHash { get; internal set; }
        public string State { get; internal set; }
        public long AcceptedAtUtcMsc { get; internal set; }
        public long? CompletedAtUtcMsc { get; internal set; }
        public string ResultJson { get; internal set; }
    }

    public sealed class CommandLedgerActivity
    {
        public int ActiveCommands { get; internal set; }
        public int UncertainCommands { get; internal set; }
    }

    public sealed class CommandLedger : IDisposable
    {
        private readonly SQLiteConnection connection;
        private readonly object writeGate;

        public CommandLedger(string databasePath)
        {
            if (string.IsNullOrWhiteSpace(databasePath))
            {
                throw new ArgumentException("bridge_ledger_path_invalid", "databasePath");
            }
            string fullPath = Path.GetFullPath(databasePath);
            string directory = Path.GetDirectoryName(fullPath);
            if (string.IsNullOrEmpty(directory))
            {
                throw new ArgumentException("bridge_ledger_path_invalid", "databasePath");
            }
            Directory.CreateDirectory(directory);
            writeGate = SqliteDatabaseCoordinator.GetWriteGate(fullPath);
            connection = new SQLiteConnection("Data Source=" + fullPath + ";Version=3;Journal Mode=WAL;Synchronous=Full;Foreign Keys=True;BusyTimeout=5000;");
            connection.Open();
            lock (writeGate)
            {
                Initialize();
            }
        }

        public CommandAcceptance Accept(
            string profileId,
            string commandId,
            string idempotencyKey,
            string action,
            string requestHash,
            long acceptedAtUtcMsc)
        {
            lock (writeGate)
            {
                RequireText(profileId, "bridge_ledger_profile_invalid", 128);
                RequireText(commandId, "bridge_ledger_command_id_invalid", 191);
                RequireText(idempotencyKey, "bridge_ledger_idempotency_key_invalid", 191);
                RequireText(action, "bridge_ledger_action_invalid", 64);
                RequireText(requestHash, "bridge_ledger_request_hash_invalid", 128);
                if (!Protocol.ProtocolCatalog.IsCommandAction(action) || acceptedAtUtcMsc < 1)
                {
                    throw new InvalidDataException("bridge_ledger_command_invalid");
                }

                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                {
                    int inserted;
                    using (SQLiteCommand insert = connection.CreateCommand())
                    {
                        insert.Transaction = transaction;
                        insert.CommandText = "INSERT OR IGNORE INTO command_ledger (profile_id, command_id, idempotency_key, action, request_hash, state, accepted_at_utc_msc) VALUES (@profile_id, @command_id, @idempotency_key, @action, @request_hash, 'recorded', @accepted_at_utc_msc)";
                        AddParameter(insert, "@profile_id", profileId);
                        AddParameter(insert, "@command_id", commandId);
                        AddParameter(insert, "@idempotency_key", idempotencyKey);
                        AddParameter(insert, "@action", action);
                        AddParameter(insert, "@request_hash", requestHash);
                        AddParameter(insert, "@accepted_at_utc_msc", acceptedAtUtcMsc);
                        inserted = insert.ExecuteNonQuery();
                    }
                    if (inserted == 1)
                    {
                        transaction.Commit();
                        return new CommandAcceptance(false, "recorded");
                    }

                    using (SQLiteCommand select = connection.CreateCommand())
                    {
                        select.Transaction = transaction;
                        select.CommandText = "SELECT command_id, action, request_hash, state FROM command_ledger WHERE profile_id = @profile_id AND idempotency_key = @idempotency_key LIMIT 1";
                        AddParameter(select, "@profile_id", profileId);
                        AddParameter(select, "@idempotency_key", idempotencyKey);
                        using (SQLiteDataReader reader = select.ExecuteReader(CommandBehavior.SingleRow))
                        {
                            if (!reader.Read())
                            {
                                throw new InvalidDataException("bridge_ledger_command_id_conflict");
                            }
                            if (!string.Equals(reader.GetString(0), commandId, StringComparison.Ordinal)
                                || !string.Equals(reader.GetString(1), action, StringComparison.Ordinal)
                                || !string.Equals(reader.GetString(2), requestHash, StringComparison.Ordinal))
                            {
                                throw new InvalidDataException("bridge_ledger_idempotency_conflict");
                            }
                            string state = reader.GetString(3);
                            transaction.Commit();
                            return new CommandAcceptance(true, state);
                        }
                    }
                }
            }
        }

        public void RecordResult(string profileId, string idempotencyKey, string state, long completedAtUtcMsc, string resultJson)
        {
            lock (writeGate)
            {
                RequireText(profileId, "bridge_ledger_profile_invalid", 128);
                RequireText(idempotencyKey, "bridge_ledger_idempotency_key_invalid", 191);
                if (!IsResultState(state) || completedAtUtcMsc < 1 || (resultJson != null && resultJson.Length > 256 * 1024))
                {
                    throw new InvalidDataException("bridge_ledger_result_invalid");
                }
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand update = connection.CreateCommand())
                {
                    update.Transaction = transaction;
                    update.CommandText = "UPDATE command_ledger SET state = @state, completed_at_utc_msc = @completed_at_utc_msc, result_json = @result_json WHERE profile_id = @profile_id AND idempotency_key = @idempotency_key AND state IN ('recorded', 'accepted', 'uncertain')";
                    AddParameter(update, "@state", state);
                    AddParameter(update, "@completed_at_utc_msc", completedAtUtcMsc);
                    AddParameter(update, "@result_json", (object)resultJson ?? DBNull.Value);
                    AddParameter(update, "@profile_id", profileId);
                    AddParameter(update, "@idempotency_key", idempotencyKey);
                    if (update.ExecuteNonQuery() == 1)
                    {
                        transaction.Commit();
                        return;
                    }
                    CommandLedgerRecord existing = ReadByIdempotencyKey(transaction, profileId, idempotencyKey);
                    if (existing == null || existing.State != state
                        || existing.CompletedAtUtcMsc != completedAtUtcMsc
                        || !string.Equals(existing.ResultJson, resultJson, StringComparison.Ordinal))
                        throw new InvalidDataException("bridge_ledger_transition_rejected");
                    transaction.Commit();
                }
            }
        }

        public bool TryMarkDispatched(string profileId, string idempotencyKey)
        {
            lock (writeGate)
            {
                RequireText(profileId, "bridge_ledger_profile_invalid", 128);
                RequireText(idempotencyKey, "bridge_ledger_idempotency_key_invalid", 191);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand update = connection.CreateCommand())
                {
                    update.Transaction = transaction;
                    update.CommandText = "UPDATE command_ledger SET state = 'accepted' WHERE profile_id = @profile_id AND idempotency_key = @idempotency_key AND state = 'recorded'";
                    AddParameter(update, "@profile_id", profileId);
                    AddParameter(update, "@idempotency_key", idempotencyKey);
                    int changed = update.ExecuteNonQuery();
                    if (changed == 0 && ReadByIdempotencyKey(transaction, profileId, idempotencyKey) == null)
                        throw new InvalidDataException("bridge_ledger_command_missing");
                    transaction.Commit();
                    return changed == 1;
                }
            }
        }

        public CommandLedgerRecord ReadByCommandId(string profileId, string commandId)
        {
            lock (writeGate)
            {
                RequireText(profileId, "bridge_ledger_profile_invalid", 128);
                RequireText(commandId, "bridge_ledger_command_id_invalid", 191);
                using (SQLiteCommand select = connection.CreateCommand())
                {
                    select.CommandText = "SELECT profile_id, command_id, idempotency_key, action, request_hash, state, accepted_at_utc_msc, completed_at_utc_msc, result_json FROM command_ledger WHERE profile_id = @profile_id AND command_id = @command_id LIMIT 1";
                    AddParameter(select, "@profile_id", profileId);
                    AddParameter(select, "@command_id", commandId);
                    using (SQLiteDataReader reader = select.ExecuteReader(CommandBehavior.SingleRow))
                        return reader.Read() ? ReadRecord(reader) : null;
                }
            }
        }

        public CommandLedgerRecord ReadByIdempotencyKey(string profileId, string idempotencyKey)
        {
            lock (writeGate)
            {
                RequireText(profileId, "bridge_ledger_profile_invalid", 128);
                RequireText(idempotencyKey, "bridge_ledger_idempotency_key_invalid", 191);
                return ReadByIdempotencyKey(null, profileId, idempotencyKey);
            }
        }

        public IList<CommandLedgerRecord> ReadRecoverable(string profileId, int limit)
        {
            lock (writeGate)
            {
                RequireText(profileId, "bridge_ledger_profile_invalid", 128);
                if (limit < 1 || limit > 500) throw new InvalidDataException("bridge_ledger_limit_invalid");
                List<CommandLedgerRecord> rows = new List<CommandLedgerRecord>();
                using (SQLiteCommand select = connection.CreateCommand())
                {
                    select.CommandText = "SELECT profile_id, command_id, idempotency_key, action, request_hash, state, accepted_at_utc_msc, completed_at_utc_msc, result_json FROM command_ledger WHERE profile_id = @profile_id AND state IN ('accepted', 'succeeded', 'rejected', 'failed', 'uncertain') ORDER BY accepted_at_utc_msc ASC, command_id ASC LIMIT @limit_value";
                    AddParameter(select, "@profile_id", profileId);
                    AddParameter(select, "@limit_value", limit);
                    using (SQLiteDataReader reader = select.ExecuteReader())
                        while (reader.Read()) rows.Add(ReadRecord(reader));
                }
                return rows;
            }
        }

        public string ReadState(string profileId, string idempotencyKey)
        {
            lock (writeGate)
            {
                using (SQLiteCommand select = connection.CreateCommand())
                {
                    select.CommandText = "SELECT state FROM command_ledger WHERE profile_id = @profile_id AND idempotency_key = @idempotency_key LIMIT 1";
                    AddParameter(select, "@profile_id", profileId);
                    AddParameter(select, "@idempotency_key", idempotencyKey);
                    object result = select.ExecuteScalar();
                    return result == null || result == DBNull.Value ? null : Convert.ToString(result);
                }
            }
        }

        public CommandLedgerActivity ReadUpdateActivity(string profileId)
        {
            lock (writeGate)
            {
                RequireText(profileId, "bridge_ledger_profile_invalid", 128);
                using (SQLiteCommand select = connection.CreateCommand())
                {
                    select.CommandText = "SELECT "
                        + "SUM(CASE WHEN state IN ('recorded', 'accepted') THEN 1 ELSE 0 END), "
                        + "SUM(CASE WHEN state = 'uncertain' THEN 1 ELSE 0 END) "
                        + "FROM command_ledger WHERE profile_id = @profile_id";
                    AddParameter(select, "@profile_id", profileId);
                    using (SQLiteDataReader reader = select.ExecuteReader(CommandBehavior.SingleRow))
                    {
                        if (!reader.Read()) return new CommandLedgerActivity();
                        return new CommandLedgerActivity
                        {
                            ActiveCommands = reader.IsDBNull(0) ? 0 : Convert.ToInt32(reader.GetValue(0)),
                            UncertainCommands = reader.IsDBNull(1) ? 0 : Convert.ToInt32(reader.GetValue(1))
                        };
                    }
                }
            }
        }

        public void Dispose()
        {
            lock (writeGate)
            {
                connection.Dispose();
            }
        }

        private void Initialize()
        {
            ProfileDataStoreSchema.Apply(connection);
        }

        private static bool IsResultState(string state)
        {
            return state == "succeeded" || state == "rejected" || state == "failed" || state == "uncertain";
        }

        private CommandLedgerRecord ReadByIdempotencyKey(SQLiteTransaction transaction,
            string profileId, string idempotencyKey)
        {
            using (SQLiteCommand select = connection.CreateCommand())
            {
                select.Transaction = transaction;
                select.CommandText = "SELECT profile_id, command_id, idempotency_key, action, request_hash, state, accepted_at_utc_msc, completed_at_utc_msc, result_json FROM command_ledger WHERE profile_id = @profile_id AND idempotency_key = @idempotency_key LIMIT 1";
                AddParameter(select, "@profile_id", profileId);
                AddParameter(select, "@idempotency_key", idempotencyKey);
                using (SQLiteDataReader reader = select.ExecuteReader(CommandBehavior.SingleRow))
                    return reader.Read() ? ReadRecord(reader) : null;
            }
        }

        private static CommandLedgerRecord ReadRecord(SQLiteDataReader reader)
        {
            return new CommandLedgerRecord
            {
                ProfileId = reader.GetString(0), CommandId = reader.GetString(1),
                IdempotencyKey = reader.GetString(2), Action = reader.GetString(3),
                RequestHash = reader.GetString(4), State = reader.GetString(5),
                AcceptedAtUtcMsc = Convert.ToInt64(reader.GetValue(6)),
                CompletedAtUtcMsc = reader.IsDBNull(7) ? (long?)null : Convert.ToInt64(reader.GetValue(7)),
                ResultJson = reader.IsDBNull(8) ? null : reader.GetString(8)
            };
        }

        private static void RequireText(string value, string code, int maxLength)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > maxLength)
            {
                throw new InvalidDataException(code);
            }
        }

        private static void AddParameter(SQLiteCommand command, string name, object value)
        {
            SQLiteParameter parameter = command.CreateParameter();
            parameter.ParameterName = name;
            parameter.Value = value;
            command.Parameters.Add(parameter);
        }
    }
}
