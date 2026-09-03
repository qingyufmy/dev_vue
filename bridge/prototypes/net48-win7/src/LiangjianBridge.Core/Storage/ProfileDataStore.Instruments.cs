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
        public void UpsertInstrumentCache(long expectedConnectionEpoch, InstrumentCacheRecord instrument)
        {
            UpsertInstrumentCaches(expectedConnectionEpoch, new[] { instrument });
        }

        public void UpsertInstrumentCaches(long expectedConnectionEpoch, IList<InstrumentCacheRecord> instruments)
        {
            if (instruments == null || instruments.Count < 1)
            {
                throw new InvalidDataException("bridge_cache_instrument_batch_invalid");
            }
            NormalizeBatchSize(instruments.Count);
            for (int i = 0; i < instruments.Count; i++)
            {
                ValidateInstrument(instruments[i]);
            }

            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "INSERT OR IGNORE INTO instrument_cache (profile_id, symbol, terminal_build, spec_revision, observed_at_utc_msc, last_accessed_utc_msc, expires_at_utc_msc, fact_json) VALUES (@profile_id, @symbol, @terminal_build, @spec_revision, @observed_at, @last_accessed, @expires_at, @fact_json); UPDATE instrument_cache SET terminal_build = @terminal_build, spec_revision = @spec_revision, observed_at_utc_msc = @observed_at, last_accessed_utc_msc = CASE WHEN last_accessed_utc_msc > @last_accessed THEN last_accessed_utc_msc ELSE @last_accessed END, expires_at_utc_msc = @expires_at, fact_json = @fact_json WHERE profile_id = @profile_id AND symbol = @symbol AND (observed_at_utc_msc < @observed_at OR (observed_at_utc_msc = @observed_at AND COALESCE(spec_revision, '') = COALESCE(@spec_revision, '')))";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@symbol", null);
                    AddParameter(command, "@terminal_build", 0);
                    AddNullableParameter(command, "@spec_revision", null);
                    AddParameter(command, "@observed_at", 0L);
                    AddParameter(command, "@last_accessed", 0L);
                    AddParameter(command, "@expires_at", 0L);
                    AddParameter(command, "@fact_json", null);
                    for (int i = 0; i < instruments.Count; i++)
                    {
                        InstrumentCacheRecord instrument = instruments[i];
                        command.Parameters["@symbol"].Value = instrument.Symbol;
                        command.Parameters["@terminal_build"].Value = instrument.TerminalBuild;
                        command.Parameters["@spec_revision"].Value = (object)instrument.SpecRevision ?? DBNull.Value;
                        command.Parameters["@observed_at"].Value = instrument.ObservedAtUtcMsc;
                        command.Parameters["@last_accessed"].Value = instrument.LastAccessedUtcMsc > 0 ? instrument.LastAccessedUtcMsc : instrument.ObservedAtUtcMsc;
                        command.Parameters["@expires_at"].Value = instrument.ExpiresAtUtcMsc;
                        command.Parameters["@fact_json"].Value = instrument.FactJson;
                        command.ExecuteNonQuery();
                    }
                    transaction.Commit();
                }
            }
        }

        public InstrumentCacheRecord ReadInstrumentCache(string symbol)
        {
            RequireText(symbol, "bridge_cache_symbol_invalid", 64);
            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT symbol, terminal_build, spec_revision, observed_at_utc_msc, last_accessed_utc_msc, expires_at_utc_msc, fact_json FROM instrument_cache WHERE profile_id = @profile_id AND symbol = @symbol LIMIT 1";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@symbol", symbol);
                    using (SQLiteDataReader reader = command.ExecuteReader(CommandBehavior.SingleRow))
                    {
                        return reader.Read() ? ReadInstrument(reader) : null;
                    }
                }
            }
        }

        public InstrumentCachePage ReadInstrumentCachePage(int limit, InstrumentCacheCursor cursor)
        {
            int pageSize = NormalizePageSize(limit);
            if (cursor != null)
            {
                RequireText(cursor.Symbol, "bridge_cache_cursor_invalid", 64);
            }
            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                {
                    List<InstrumentCacheRecord> rows = new List<InstrumentCacheRecord>();
                    using (SQLiteCommand command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "SELECT symbol, terminal_build, spec_revision, observed_at_utc_msc, last_accessed_utc_msc, expires_at_utc_msc, fact_json FROM instrument_cache WHERE profile_id = @profile_id AND (@has_cursor = 0 OR symbol > @cursor_symbol) ORDER BY symbol ASC LIMIT @limit_value";
                        AddParameter(command, "@profile_id", profileId);
                        AddParameter(command, "@has_cursor", cursor == null ? 0 : 1);
                        AddParameter(command, "@cursor_symbol", cursor == null ? string.Empty : cursor.Symbol);
                        AddParameter(command, "@limit_value", pageSize + 1);
                        using (SQLiteDataReader reader = command.ExecuteReader())
                        {
                            while (reader.Read())
                            {
                                rows.Add(ReadInstrument(reader));
                            }
                        }
                    }
                    bool hasMore = rows.Count > pageSize;
                    if (hasMore)
                    {
                        rows.RemoveAt(rows.Count - 1);
                    }
                    if (rows.Count > 0)
                    {
                        long touchAt = UtcNowMsc();
                        using (SQLiteCommand touch = connection.CreateCommand())
                        {
                            touch.Transaction = transaction;
                            touch.CommandText = "UPDATE instrument_cache SET last_accessed_utc_msc = @last_accessed WHERE profile_id = @profile_id AND (@has_cursor = 0 OR symbol > @cursor_symbol) AND symbol <= @last_symbol";
                            AddParameter(touch, "@last_accessed", touchAt);
                            AddParameter(touch, "@profile_id", profileId);
                            AddParameter(touch, "@has_cursor", cursor == null ? 0 : 1);
                            AddParameter(touch, "@cursor_symbol", cursor == null ? string.Empty : cursor.Symbol);
                            AddParameter(touch, "@last_symbol", rows[rows.Count - 1].Symbol);
                            touch.ExecuteNonQuery();
                        }
                        for (int i = 0; i < rows.Count; i++)
                        {
                            rows[i].LastAccessedUtcMsc = touchAt;
                        }
                    }
                    transaction.Commit();
                    return new InstrumentCachePage
                    {
                        Items = rows,
                        HasMore = hasMore,
                        NextCursor = rows.Count == 0 ? null : new InstrumentCacheCursor(rows[rows.Count - 1].Symbol)
                    };
                }
            }
        }

        private static InstrumentCacheRecord ReadInstrument(SQLiteDataReader reader)
        {
            return new InstrumentCacheRecord
            {
                Symbol = reader.GetString(0),
                TerminalBuild = Convert.ToInt32(reader.GetValue(1), CultureInfo.InvariantCulture),
                SpecRevision = ReadNullableString(reader, 2),
                ObservedAtUtcMsc = Convert.ToInt64(reader.GetValue(3), CultureInfo.InvariantCulture),
                LastAccessedUtcMsc = Convert.ToInt64(reader.GetValue(4), CultureInfo.InvariantCulture),
                ExpiresAtUtcMsc = Convert.ToInt64(reader.GetValue(5), CultureInfo.InvariantCulture),
                FactJson = reader.GetString(6)
            };
        }

        private static void ValidateInstrument(InstrumentCacheRecord instrument)
        {
            if (instrument == null)
            {
                throw new InvalidDataException("bridge_cache_instrument_invalid");
            }
            RequireText(instrument.Symbol, "bridge_cache_symbol_invalid", 64);
            if (instrument.TerminalBuild < 0)
            {
                throw new InvalidDataException("bridge_cache_terminal_build_invalid");
            }
            RequireOptionalText(instrument.SpecRevision, "bridge_cache_instrument_revision_invalid", 191);
            if (instrument.ObservedAtUtcMsc < 1 || instrument.LastAccessedUtcMsc < 0 || instrument.ExpiresAtUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_instrument_time_invalid");
            }
            ValidateFactJson(instrument.FactJson, "bridge_cache_instrument_json_invalid");
        }
    }
}
