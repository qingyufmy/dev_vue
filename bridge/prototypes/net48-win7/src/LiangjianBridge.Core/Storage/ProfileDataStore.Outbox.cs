using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SQLite;
using System.Globalization;
using System.IO;

namespace Liangjian.BridgeV4.Storage
{
    public sealed partial class ProfileDataStore
    {
        public bool EnqueueOutboxMessage(long expectedConnectionEpoch, OutboxMessageRecord message)
        {
            ValidateOutboxMessage(message, expectedConnectionEpoch);
            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "INSERT OR IGNORE INTO outbox_messages (profile_id, message_id, connection_epoch, message_kind, payload_json, priority, next_attempt_at_utc_msc, attempt, acked_at_utc_msc, created_at_utc_msc, last_error_code, last_error_detail) VALUES (@profile_id, @message_id, @epoch, @message_kind, @payload_json, @priority, @next_attempt, @attempt, @acked_at, @created_at, @error_code, @error_detail)";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@message_id", message.MessageId);
                    AddParameter(command, "@epoch", expectedConnectionEpoch);
                    AddParameter(command, "@message_kind", message.MessageKind);
                    AddParameter(command, "@payload_json", message.PayloadJson);
                    AddParameter(command, "@priority", message.Priority);
                    AddParameter(command, "@next_attempt", message.NextAttemptAtUtcMsc);
                    AddParameter(command, "@attempt", message.Attempt);
                    AddNullableParameter(command, "@acked_at", message.AckedAtUtcMsc);
                    AddParameter(command, "@created_at", message.CreatedAtUtcMsc);
                    AddNullableParameter(command, "@error_code", message.LastErrorCode);
                    AddNullableParameter(command, "@error_detail", message.LastErrorDetail);
                    int inserted = command.ExecuteNonQuery();
                    if (inserted == 0)
                    {
                        using (SQLiteCommand existing = connection.CreateCommand())
                        {
                            existing.Transaction = transaction;
                            existing.CommandText = "SELECT connection_epoch, message_kind, payload_json, priority, created_at_utc_msc FROM outbox_messages WHERE profile_id = @profile_id AND message_id = @message_id LIMIT 1";
                            AddParameter(existing, "@profile_id", profileId);
                            AddParameter(existing, "@message_id", message.MessageId);
                            using (SQLiteDataReader reader = existing.ExecuteReader(CommandBehavior.SingleRow))
                            {
                                if (!reader.Read() || !OutboxMessageMatches(reader, expectedConnectionEpoch, message))
                                {
                                    throw new InvalidDataException("bridge_cache_outbox_conflict");
                                }
                            }
                        }
                    }
                    transaction.Commit();
                    return inserted == 1;
                }
            }
        }

        public OutboxMessageRecord ReadOutboxMessage(string messageId)
        {
            RequireText(messageId, "bridge_cache_outbox_message_id_invalid", 191);
            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT message_id, connection_epoch, message_kind, payload_json, priority, next_attempt_at_utc_msc, attempt, acked_at_utc_msc, created_at_utc_msc, last_error_code, last_error_detail FROM outbox_messages WHERE profile_id = @profile_id AND message_id = @message_id LIMIT 1";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@message_id", messageId);
                    using (SQLiteDataReader reader = command.ExecuteReader(CommandBehavior.SingleRow))
                    {
                        return reader.Read() ? ReadOutboxMessage(reader) : null;
                    }
                }
            }
        }

        public OutboxPage ReadPendingOutbox(long nowUtcMsc, int limit, OutboxCursor cursor)
        {
            if (nowUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_time_invalid");
            }
            int pageSize = NormalizePageSize(limit);
            ValidateOutboxCursor(cursor);
            lock (writeGate)
            {
                EnsureNotDisposed();
                List<OutboxMessageRecord> rows = new List<OutboxMessageRecord>();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT message_id, connection_epoch, message_kind, payload_json, priority, next_attempt_at_utc_msc, attempt, acked_at_utc_msc, created_at_utc_msc, last_error_code, last_error_detail FROM outbox_messages WHERE profile_id = @profile_id AND connection_epoch = @epoch AND acked_at_utc_msc IS NULL AND next_attempt_at_utc_msc <= @now AND (@has_cursor = 0 OR priority < @cursor_priority OR (priority = @cursor_priority AND (next_attempt_at_utc_msc > @cursor_next_attempt OR (next_attempt_at_utc_msc = @cursor_next_attempt AND (created_at_utc_msc > @cursor_created OR (created_at_utc_msc = @cursor_created AND message_id > @cursor_id)))))) ORDER BY priority DESC, next_attempt_at_utc_msc ASC, created_at_utc_msc ASC, message_id ASC LIMIT @limit_value";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@epoch", connectionEpoch);
                    AddParameter(command, "@now", nowUtcMsc);
                    AddParameter(command, "@has_cursor", cursor == null ? 0 : 1);
                    AddParameter(command, "@cursor_priority", cursor == null ? 0 : cursor.Priority);
                    AddParameter(command, "@cursor_next_attempt", cursor == null ? 0 : cursor.NextAttemptAtUtcMsc);
                    AddParameter(command, "@cursor_created", cursor == null ? 0 : cursor.CreatedAtUtcMsc);
                    AddParameter(command, "@cursor_id", cursor == null ? string.Empty : cursor.MessageId);
                    AddParameter(command, "@limit_value", pageSize + 1);
                    using (SQLiteDataReader reader = command.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            rows.Add(ReadOutboxMessage(reader));
                        }
                    }
                }
                bool hasMore = rows.Count > pageSize;
                if (hasMore)
                {
                    rows.RemoveAt(rows.Count - 1);
                }
                return new OutboxPage
                {
                    Items = rows,
                    HasMore = hasMore,
                    NextCursor = rows.Count == 0 ? null : new OutboxCursor(rows[rows.Count - 1].Priority, rows[rows.Count - 1].NextAttemptAtUtcMsc, rows[rows.Count - 1].CreatedAtUtcMsc, rows[rows.Count - 1].MessageId)
                };
            }
        }

        public OutboxMessageRecord ReadNextUnacknowledgedOutbox(long nowUtcMsc)
        {
            if (nowUtcMsc < 1) throw new InvalidDataException("bridge_cache_time_invalid");
            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT message_id, connection_epoch, message_kind, payload_json, priority, next_attempt_at_utc_msc, attempt, acked_at_utc_msc, created_at_utc_msc, last_error_code, last_error_detail FROM outbox_messages WHERE profile_id = @profile_id AND acked_at_utc_msc IS NULL AND next_attempt_at_utc_msc <= @now ORDER BY priority DESC, next_attempt_at_utc_msc ASC, created_at_utc_msc ASC, message_id ASC LIMIT 1";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@now", nowUtcMsc);
                    using (SQLiteDataReader reader = command.ExecuteReader(CommandBehavior.SingleRow))
                        return reader.Read() ? ReadOutboxMessage(reader) : null;
                }
            }
        }

        public OutboxPage ReadOutbox(long nowUtcMsc, int limit, OutboxCursor cursor)
        {
            return ReadPendingOutbox(nowUtcMsc, limit, cursor);
        }

        public bool MarkOutboxAttempt(long expectedConnectionEpoch, string messageId, int expectedAttempt, long nowUtcMsc, long nextAttemptAtUtcMsc, string errorCode, string errorDetail)
        {
            RequireText(messageId, "bridge_cache_outbox_message_id_invalid", 191);
            RequireText(errorCode, "bridge_cache_outbox_error_invalid", 128);
            RequireOptionalText(errorDetail, "bridge_cache_outbox_error_detail_invalid", 4096);
            if (expectedAttempt < 0 || nowUtcMsc < 1 || nextAttemptAtUtcMsc < nowUtcMsc)
            {
                throw new InvalidDataException("bridge_cache_outbox_attempt_invalid");
            }
            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "UPDATE outbox_messages SET attempt = attempt + 1, next_attempt_at_utc_msc = @next_attempt, last_error_code = @error_code, last_error_detail = @error_detail WHERE profile_id = @profile_id AND message_id = @message_id AND connection_epoch = @epoch AND acked_at_utc_msc IS NULL AND attempt = @expected_attempt";
                    AddParameter(command, "@next_attempt", nextAttemptAtUtcMsc);
                    AddParameter(command, "@error_code", errorCode);
                    AddNullableParameter(command, "@error_detail", errorDetail);
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@message_id", messageId);
                    AddParameter(command, "@epoch", expectedConnectionEpoch);
                    AddParameter(command, "@expected_attempt", expectedAttempt);
                    int changed = command.ExecuteNonQuery();
                    transaction.Commit();
                    return changed == 1;
                }
            }
        }

        public bool MarkDurableOutboxAttempt(long storedConnectionEpoch, string messageId, int expectedAttempt,
            long nowUtcMsc, long nextAttemptAtUtcMsc, string errorCode, string errorDetail)
        {
            RequireText(messageId, "bridge_cache_outbox_message_id_invalid", 191);
            RequireText(errorCode, "bridge_cache_outbox_error_invalid", 128);
            RequireOptionalText(errorDetail, "bridge_cache_outbox_error_detail_invalid", 4096);
            RequireEpoch(storedConnectionEpoch, "bridge_cache_epoch_invalid");
            if (expectedAttempt < 0 || nowUtcMsc < 1 || nextAttemptAtUtcMsc < nowUtcMsc)
                throw new InvalidDataException("bridge_cache_outbox_attempt_invalid");
            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "UPDATE outbox_messages SET attempt = attempt + 1, next_attempt_at_utc_msc = @next_attempt, last_error_code = @error_code, last_error_detail = @error_detail WHERE profile_id = @profile_id AND message_id = @message_id AND connection_epoch = @stored_epoch AND acked_at_utc_msc IS NULL AND attempt = @expected_attempt";
                    AddParameter(command, "@next_attempt", nextAttemptAtUtcMsc);
                    AddParameter(command, "@error_code", errorCode);
                    AddNullableParameter(command, "@error_detail", errorDetail);
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@message_id", messageId);
                    AddParameter(command, "@stored_epoch", storedConnectionEpoch);
                    AddParameter(command, "@expected_attempt", expectedAttempt);
                    return command.ExecuteNonQuery() == 1;
                }
            }
        }

        public bool AckOutboxMessage(long expectedConnectionEpoch, string messageId, long ackedAtUtcMsc)
        {
            RequireText(messageId, "bridge_cache_outbox_message_id_invalid", 191);
            if (ackedAtUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_time_invalid");
            }
            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "UPDATE outbox_messages SET acked_at_utc_msc = @acked_at WHERE profile_id = @profile_id AND message_id = @message_id AND connection_epoch = @epoch AND acked_at_utc_msc IS NULL";
                    AddParameter(command, "@acked_at", ackedAtUtcMsc);
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@message_id", messageId);
                    AddParameter(command, "@epoch", expectedConnectionEpoch);
                    int changed = command.ExecuteNonQuery();
                    transaction.Commit();
                    return changed == 1;
                }
            }
        }

        public bool AckDurableOutboxMessage(string messageId, long ackedAtUtcMsc)
        {
            RequireText(messageId, "bridge_cache_outbox_message_id_invalid", 191);
            if (ackedAtUtcMsc < 1) throw new InvalidDataException("bridge_cache_time_invalid");
            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "UPDATE outbox_messages SET acked_at_utc_msc = @acked_at WHERE profile_id = @profile_id AND message_id = @message_id AND acked_at_utc_msc IS NULL";
                    AddParameter(command, "@acked_at", ackedAtUtcMsc);
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@message_id", messageId);
                    return command.ExecuteNonQuery() == 1;
                }
            }
        }

        public int AckDurableOutboxKind(string messageKind, long ackedAtUtcMsc)
        {
            RequireText(messageKind, "bridge_cache_outbox_kind_invalid", 64);
            if (ackedAtUtcMsc < 1) throw new InvalidDataException("bridge_cache_time_invalid");
            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "UPDATE outbox_messages SET acked_at_utc_msc = @acked_at WHERE profile_id = @profile_id AND message_kind = @message_kind AND acked_at_utc_msc IS NULL";
                    AddParameter(command, "@acked_at", ackedAtUtcMsc);
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@message_kind", messageKind);
                    return command.ExecuteNonQuery();
                }
            }
        }

        private static OutboxMessageRecord ReadOutboxMessage(SQLiteDataReader reader)
        {
            return new OutboxMessageRecord
            {
                MessageId = reader.GetString(0),
                ConnectionEpoch = Convert.ToInt64(reader.GetValue(1), CultureInfo.InvariantCulture),
                MessageKind = reader.GetString(2),
                PayloadJson = reader.GetString(3),
                Priority = Convert.ToInt32(reader.GetValue(4), CultureInfo.InvariantCulture),
                NextAttemptAtUtcMsc = Convert.ToInt64(reader.GetValue(5), CultureInfo.InvariantCulture),
                Attempt = Convert.ToInt32(reader.GetValue(6), CultureInfo.InvariantCulture),
                AckedAtUtcMsc = reader.IsDBNull(7) ? (long?)null : Convert.ToInt64(reader.GetValue(7), CultureInfo.InvariantCulture),
                CreatedAtUtcMsc = Convert.ToInt64(reader.GetValue(8), CultureInfo.InvariantCulture),
                LastErrorCode = ReadNullableString(reader, 9),
                LastErrorDetail = ReadNullableString(reader, 10)
            };
        }

        private static void ValidateOutboxMessage(OutboxMessageRecord message, long expectedConnectionEpoch)
        {
            if (message == null)
            {
                throw new InvalidDataException("bridge_cache_outbox_message_invalid");
            }
            RequireText(message.MessageId, "bridge_cache_outbox_message_id_invalid", 191);
            if (message.ConnectionEpoch != 0 && message.ConnectionEpoch != expectedConnectionEpoch)
            {
                throw new InvalidDataException("bridge_cache_profile_epoch_mismatch");
            }
            RequireText(message.MessageKind, "bridge_cache_outbox_kind_invalid", 64);
            ValidateFactJson(message.PayloadJson, "bridge_cache_outbox_payload_invalid");
            ValidatePriority(message.Priority, "bridge_cache_outbox_priority_invalid");
            if (message.NextAttemptAtUtcMsc < 1 || message.CreatedAtUtcMsc < 1 || message.Attempt < 0 || message.Attempt > 1000000)
            {
                throw new InvalidDataException("bridge_cache_outbox_message_invalid");
            }
            RequireOptionalTime(message.AckedAtUtcMsc, "bridge_cache_outbox_ack_time_invalid");
            RequireOptionalText(message.LastErrorCode, "bridge_cache_outbox_error_invalid", 128);
            RequireOptionalText(message.LastErrorDetail, "bridge_cache_outbox_error_detail_invalid", 4096);
        }

        private static void ValidateOutboxCursor(OutboxCursor cursor)
        {
            if (cursor == null)
            {
                return;
            }
            ValidatePriority(cursor.Priority, "bridge_cache_cursor_invalid");
            if (cursor.NextAttemptAtUtcMsc < 1 || cursor.CreatedAtUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_cursor_invalid");
            }
            RequireText(cursor.MessageId, "bridge_cache_cursor_invalid", 191);
        }

        private static bool OutboxMessageMatches(SQLiteDataReader reader, long expectedConnectionEpoch, OutboxMessageRecord message)
        {
            // Delivery state (attempt, next retry and acknowledgement) is mutable;
            // the message identity is the immutable payload envelope.
            return Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture) == expectedConnectionEpoch
                && string.Equals(reader.GetString(1), message.MessageKind, StringComparison.Ordinal)
                && string.Equals(reader.GetString(2), message.PayloadJson, StringComparison.Ordinal)
                && Convert.ToInt32(reader.GetValue(3), CultureInfo.InvariantCulture) == message.Priority
                && Convert.ToInt64(reader.GetValue(4), CultureInfo.InvariantCulture) == message.CreatedAtUtcMsc;
        }
    }
}
