using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SQLite;
using System.Globalization;
using System.IO;
using Liangjian.BridgeV4.Protocol;

namespace Liangjian.BridgeV4.Storage
{
    public sealed partial class ProfileDataStore
    {
        public void UpsertStreamState(long expectedConnectionEpoch, StreamStateRecord state)
        {
            ValidateStreamState(state, expectedConnectionEpoch);
            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "INSERT OR IGNORE INTO stream_state (profile_id, resource, connection_epoch, revision, payload_hash, source_time_utc_msc, observed_at_utc_msc, status) VALUES (@profile_id, @resource, @epoch, @revision, @payload_hash, @source_time, @observed_at, @status); UPDATE stream_state SET connection_epoch = @epoch, revision = @revision, payload_hash = @payload_hash, source_time_utc_msc = @source_time, observed_at_utc_msc = @observed_at, status = @status WHERE profile_id = @profile_id AND resource = @resource AND (connection_epoch <> @epoch OR observed_at_utc_msc < @observed_at OR (observed_at_utc_msc = @observed_at AND COALESCE(revision, '') = COALESCE(@revision, '')))";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@resource", state.Resource);
                    AddParameter(command, "@epoch", expectedConnectionEpoch);
                    AddNullableParameter(command, "@revision", state.Revision);
                    AddNullableParameter(command, "@payload_hash", state.PayloadHash);
                    AddNullableParameter(command, "@source_time", state.SourceTimeUtcMsc);
                    AddParameter(command, "@observed_at", state.ObservedAtUtcMsc);
                    AddParameter(command, "@status", state.Status);
                    command.ExecuteNonQuery();
                    transaction.Commit();
                }
            }
        }

        public StreamStateRecord ReadStreamState(string resource)
        {
            RequireText(resource, "bridge_cache_stream_resource_invalid", 64);
            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT resource, connection_epoch, revision, payload_hash, source_time_utc_msc, observed_at_utc_msc, status FROM stream_state WHERE profile_id = @profile_id AND resource = @resource AND connection_epoch = @epoch LIMIT 1";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@epoch", connectionEpoch);
                    AddParameter(command, "@resource", resource);
                    using (SQLiteDataReader reader = command.ExecuteReader(CommandBehavior.SingleRow))
                    {
                        return reader.Read() ? ReadStreamState(reader) : null;
                    }
                }
            }
        }

        public IList<StreamStateRecord> ReadStreamStates()
        {
            lock (writeGate)
            {
                EnsureNotDisposed();
                List<StreamStateRecord> rows = new List<StreamStateRecord>();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT resource, connection_epoch, revision, payload_hash, source_time_utc_msc, observed_at_utc_msc, status FROM stream_state WHERE profile_id = @profile_id AND connection_epoch = @epoch ORDER BY resource ASC";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@epoch", connectionEpoch);
                    using (SQLiteDataReader reader = command.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            rows.Add(ReadStreamState(reader));
                        }
                    }
                }
                return rows;
            }
        }

        public void UpsertAccountLatest(long expectedConnectionEpoch, AccountLatestRecord account)
        {
            ValidateAccountLatest(account, expectedConnectionEpoch);
            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "INSERT OR IGNORE INTO account_latest (profile_id, connection_epoch, revision, account_number, currency, balance_text, equity_text, margin_text, free_margin_text, margin_level_text, profit_text, observed_at_utc_msc, fact_json) VALUES (@profile_id, @epoch, @revision, @account_number, @currency, @balance, @equity, @margin, @free_margin, @margin_level, @profit, @observed_at, @fact_json); UPDATE account_latest SET connection_epoch = @epoch, revision = @revision, account_number = @account_number, currency = @currency, balance_text = @balance, equity_text = @equity, margin_text = @margin, free_margin_text = @free_margin, margin_level_text = @margin_level, profit_text = @profit, observed_at_utc_msc = @observed_at, fact_json = @fact_json WHERE profile_id = @profile_id AND (connection_epoch <> @epoch OR observed_at_utc_msc < @observed_at OR (observed_at_utc_msc = @observed_at AND COALESCE(revision, '') = COALESCE(@revision, '')))";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@epoch", expectedConnectionEpoch);
                    AddNullableParameter(command, "@revision", account.Revision);
                    AddNullableParameter(command, "@account_number", account.AccountNumber);
                    AddNullableParameter(command, "@currency", account.Currency);
                    AddNullableParameter(command, "@balance", DecimalText(account.Balance));
                    AddNullableParameter(command, "@equity", DecimalText(account.Equity));
                    AddNullableParameter(command, "@margin", DecimalText(account.Margin));
                    AddNullableParameter(command, "@free_margin", DecimalText(account.FreeMargin));
                    AddNullableParameter(command, "@margin_level", DecimalText(account.MarginLevel));
                    AddNullableParameter(command, "@profit", DecimalText(account.Profit));
                    AddParameter(command, "@observed_at", account.ObservedAtUtcMsc);
                    AddParameter(command, "@fact_json", account.FactJson);
                    command.ExecuteNonQuery();
                    transaction.Commit();
                }
            }
        }

        public AccountLatestRecord ReadAccountLatest()
        {
            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT connection_epoch, revision, account_number, currency, balance_text, equity_text, margin_text, free_margin_text, margin_level_text, profit_text, observed_at_utc_msc, fact_json FROM account_latest WHERE profile_id = @profile_id AND connection_epoch = @epoch LIMIT 1";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@epoch", connectionEpoch);
                    using (SQLiteDataReader reader = command.ExecuteReader(CommandBehavior.SingleRow))
                    {
                        return reader.Read() ? ReadAccountLatest(reader) : null;
                    }
                }
            }
        }

        private static void ValidateStreamState(StreamStateRecord state, long expectedConnectionEpoch)
        {
            if (state == null)
            {
                throw new InvalidDataException("bridge_cache_stream_state_invalid");
            }
            RequireText(state.Resource, "bridge_cache_stream_resource_invalid", 64);
            if (!ProtocolCatalog.IsStreamResource(state.Resource))
            {
                throw new InvalidDataException("bridge_cache_stream_resource_invalid");
            }
            RequireEpoch(expectedConnectionEpoch, "bridge_cache_epoch_invalid");
            if (state.ConnectionEpoch != expectedConnectionEpoch)
            {
                throw new InvalidDataException("bridge_cache_profile_epoch_mismatch");
            }
            RequireOptionalText(state.Revision, "bridge_cache_stream_revision_invalid", 191);
            RequireOptionalText(state.PayloadHash, "bridge_cache_stream_payload_hash_invalid", 128);
            RequireOptionalTime(state.SourceTimeUtcMsc, "bridge_cache_stream_source_time_invalid");
            if (state.ObservedAtUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_stream_state_invalid");
            }
            if (state.Status != "live" && state.Status != "stale" && state.Status != "offline" && state.Status != "unknown")
            {
                throw new InvalidDataException("bridge_cache_stream_status_invalid");
            }
        }

        private static void ValidateAccountLatest(AccountLatestRecord account, long expectedConnectionEpoch)
        {
            if (account == null)
            {
                throw new InvalidDataException("bridge_cache_account_latest_invalid");
            }
            RequireEpoch(expectedConnectionEpoch, "bridge_cache_epoch_invalid");
            if (account.ConnectionEpoch != expectedConnectionEpoch)
            {
                throw new InvalidDataException("bridge_cache_profile_epoch_mismatch");
            }
            RequireOptionalText(account.Revision, "bridge_cache_account_revision_invalid", 191);
            RequireOptionalText(account.AccountNumber, "bridge_cache_account_number_invalid", 64);
            RequireOptionalText(account.Currency, "bridge_cache_account_currency_invalid", 32);
            RequireDecimal(account.Balance, "bridge_cache_account_value_invalid");
            RequireDecimal(account.Equity, "bridge_cache_account_value_invalid");
            RequireDecimal(account.Margin, "bridge_cache_account_value_invalid");
            RequireDecimal(account.FreeMargin, "bridge_cache_account_value_invalid");
            RequireDecimal(account.MarginLevel, "bridge_cache_account_value_invalid");
            RequireDecimal(account.Profit, "bridge_cache_account_value_invalid");
            RequireText(account.FactJson, "bridge_cache_account_json_invalid", 1024 * 1024);
            if (account.ObservedAtUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_account_latest_invalid");
            }
        }

        private static StreamStateRecord ReadStreamState(SQLiteDataReader reader)
        {
            return new StreamStateRecord
            {
                Resource = reader.GetString(0),
                ConnectionEpoch = Convert.ToInt64(reader.GetValue(1), CultureInfo.InvariantCulture),
                Revision = ReadNullableString(reader, 2),
                PayloadHash = ReadNullableString(reader, 3),
                SourceTimeUtcMsc = reader.IsDBNull(4) ? (long?)null : Convert.ToInt64(reader.GetValue(4), CultureInfo.InvariantCulture),
                ObservedAtUtcMsc = Convert.ToInt64(reader.GetValue(5), CultureInfo.InvariantCulture),
                Status = reader.GetString(6)
            };
        }

        private static AccountLatestRecord ReadAccountLatest(SQLiteDataReader reader)
        {
            return new AccountLatestRecord
            {
                ConnectionEpoch = Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture),
                Revision = ReadNullableString(reader, 1),
                AccountNumber = ReadNullableString(reader, 2),
                Currency = ReadNullableString(reader, 3),
                Balance = DecimalValue(reader, 4),
                Equity = DecimalValue(reader, 5),
                Margin = DecimalValue(reader, 6),
                FreeMargin = DecimalValue(reader, 7),
                MarginLevel = DecimalValue(reader, 8),
                Profit = DecimalValue(reader, 9),
                ObservedAtUtcMsc = Convert.ToInt64(reader.GetValue(10), CultureInfo.InvariantCulture),
                FactJson = reader.GetString(11)
            };
        }
    }
}
