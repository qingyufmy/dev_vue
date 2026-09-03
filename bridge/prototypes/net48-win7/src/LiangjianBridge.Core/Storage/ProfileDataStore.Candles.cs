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
        public void UpsertClosedCandle(long expectedConnectionEpoch, CandleRecord candle)
        {
            UpsertClosedCandles(expectedConnectionEpoch, new[] { candle });
        }

        public void UpsertClosedCandles(long expectedConnectionEpoch, IList<CandleRecord> candles)
        {
            if (candles == null || candles.Count < 1)
            {
                throw new InvalidDataException("bridge_cache_candle_batch_invalid");
            }
            NormalizeBatchSize(candles.Count);
            for (int i = 0; i < candles.Count; i++)
            {
                ValidateCandle(candles[i]);
            }

            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "INSERT OR IGNORE INTO market_candles (profile_id, symbol, timeframe, open_time_utc_msc, open_price, high_price, low_price, close_price, tick_volume, real_volume, spread, closed, source_revision, observed_at_utc_msc, last_accessed_utc_msc) VALUES (@profile_id, @symbol, @timeframe, @open_time_value, @open_price_value, @high_price_value, @low_price_value, @close_price_value, @tick_volume_value, @real_volume_value, @spread_value, 1, @source_revision, @observed_at_value, @last_accessed_value); UPDATE market_candles SET open_price = @open_price_value, high_price = @high_price_value, low_price = @low_price_value, close_price = @close_price_value, tick_volume = @tick_volume_value, real_volume = @real_volume_value, spread = @spread_value, source_revision = @source_revision, observed_at_utc_msc = @observed_at_value, last_accessed_utc_msc = CASE WHEN last_accessed_utc_msc > @last_accessed_value THEN last_accessed_utc_msc ELSE @last_accessed_value END WHERE profile_id = @profile_id AND symbol = @symbol AND timeframe = @timeframe AND open_time_utc_msc = @open_time_value AND (observed_at_utc_msc < @observed_at_value OR (observed_at_utc_msc = @observed_at_value AND COALESCE(source_revision, '') = COALESCE(@source_revision, '')))";
                    SQLiteParameter profile = AddParameter(command, "@profile_id", null);
                    SQLiteParameter symbol = AddParameter(command, "@symbol", null);
                    SQLiteParameter timeframe = AddParameter(command, "@timeframe", null);
                    SQLiteParameter openTime = AddParameter(command, "@open_time_value", 0L);
                    SQLiteParameter open = AddParameter(command, "@open_price_value", 0D);
                    SQLiteParameter high = AddParameter(command, "@high_price_value", 0D);
                    SQLiteParameter low = AddParameter(command, "@low_price_value", 0D);
                    SQLiteParameter close = AddParameter(command, "@close_price_value", 0D);
                    SQLiteParameter tickVolume = AddParameter(command, "@tick_volume_value", 0L);
                    SQLiteParameter realVolume = AddParameter(command, "@real_volume_value", 0L);
                    SQLiteParameter spread = AddParameter(command, "@spread_value", 0D);
                    SQLiteParameter sourceRevision = AddParameter(command, "@source_revision", null);
                    SQLiteParameter observed = AddParameter(command, "@observed_at_value", 0L);
                    SQLiteParameter lastAccessed = AddParameter(command, "@last_accessed_value", 0L);

                    for (int i = 0; i < candles.Count; i++)
                    {
                        CandleRecord candle = candles[i];
                        profile.Value = profileId;
                        symbol.Value = candle.Symbol;
                        timeframe.Value = candle.Timeframe;
                        openTime.Value = candle.OpenTimeUtcMsc;
                        open.Value = candle.Open;
                        high.Value = candle.High;
                        low.Value = candle.Low;
                        close.Value = candle.Close;
                        tickVolume.Value = candle.TickVolume;
                        realVolume.Value = candle.RealVolume;
                        spread.Value = candle.Spread;
                        sourceRevision.Value = candle.SourceRevision ?? (object)DBNull.Value;
                        observed.Value = candle.ObservedAtUtcMsc;
                        lastAccessed.Value = candle.LastAccessedUtcMsc > 0 ? candle.LastAccessedUtcMsc : candle.ObservedAtUtcMsc;
                        command.ExecuteNonQuery();
                    }
                    transaction.Commit();
                }
            }
        }

        public CandlePage ReadCandles(
            string symbol,
            string timeframe,
            long rangeStartUtcMsc,
            long rangeEndUtcMsc,
            int limit,
            CandleCursor cursor)
        {
            RequireText(symbol, "bridge_cache_symbol_invalid", 64);
            RequireText(timeframe, "bridge_cache_timeframe_invalid", 32);
            ValidateRange(rangeStartUtcMsc, rangeEndUtcMsc, "bridge_cache_candle_range_invalid");
            int pageSize = NormalizePageSize(limit);
            if (cursor != null && cursor.OpenTimeUtcMsc < rangeStartUtcMsc)
            {
                throw new InvalidDataException("bridge_cache_cursor_invalid");
            }

            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                {
                    List<CandleRecord> rows = new List<CandleRecord>();
                    using (SQLiteCommand command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "SELECT symbol, timeframe, open_time_utc_msc, open_price, high_price, low_price, close_price, tick_volume, real_volume, spread, closed, source_revision, observed_at_utc_msc, last_accessed_utc_msc FROM market_candles WHERE profile_id = @profile_id AND symbol = @symbol AND timeframe = @timeframe AND open_time_utc_msc >= @range_start AND open_time_utc_msc < @range_end AND (@has_cursor = 0 OR open_time_utc_msc > @cursor_value) ORDER BY open_time_utc_msc ASC LIMIT @limit_value";
                        AddParameter(command, "@profile_id", profileId);
                        AddParameter(command, "@symbol", symbol);
                        AddParameter(command, "@timeframe", timeframe);
                        AddParameter(command, "@range_start", rangeStartUtcMsc);
                        AddParameter(command, "@range_end", rangeEndUtcMsc);
                        AddParameter(command, "@has_cursor", cursor == null ? 0 : 1);
                        AddParameter(command, "@cursor_value", cursor == null ? 0 : cursor.OpenTimeUtcMsc);
                        AddParameter(command, "@limit_value", pageSize + 1);
                        using (SQLiteDataReader reader = command.ExecuteReader())
                        {
                            while (reader.Read())
                            {
                                rows.Add(ReadCandle(reader));
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
                            touch.CommandText = "UPDATE market_candles SET last_accessed_utc_msc = @last_accessed WHERE profile_id = @profile_id AND symbol = @symbol AND timeframe = @timeframe AND open_time_utc_msc >= @range_start AND open_time_utc_msc < @range_end AND (@has_cursor = 0 OR open_time_utc_msc > @cursor_value) AND open_time_utc_msc <= @last_open_time";
                            AddParameter(touch, "@last_accessed", touchAt);
                            AddParameter(touch, "@profile_id", profileId);
                            AddParameter(touch, "@symbol", symbol);
                            AddParameter(touch, "@timeframe", timeframe);
                            AddParameter(touch, "@range_start", rangeStartUtcMsc);
                            AddParameter(touch, "@range_end", rangeEndUtcMsc);
                            AddParameter(touch, "@has_cursor", cursor == null ? 0 : 1);
                            AddParameter(touch, "@cursor_value", cursor == null ? 0 : cursor.OpenTimeUtcMsc);
                            AddParameter(touch, "@last_open_time", rows[rows.Count - 1].OpenTimeUtcMsc);
                            touch.ExecuteNonQuery();
                        }
                        for (int i = 0; i < rows.Count; i++)
                        {
                            rows[i].LastAccessedUtcMsc = touchAt;
                        }
                    }
                    transaction.Commit();
                    return new CandlePage
                    {
                        Items = rows,
                        HasMore = hasMore,
                        NextCursor = rows.Count == 0 ? null : new CandleCursor(rows[rows.Count - 1].OpenTimeUtcMsc)
                    };
                }
            }
        }

        private static CandleRecord ReadCandle(SQLiteDataReader reader)
        {
            return new CandleRecord
            {
                Symbol = reader.GetString(0),
                Timeframe = reader.GetString(1),
                OpenTimeUtcMsc = Convert.ToInt64(reader.GetValue(2), CultureInfo.InvariantCulture),
                Open = Convert.ToDouble(reader.GetValue(3), CultureInfo.InvariantCulture),
                High = Convert.ToDouble(reader.GetValue(4), CultureInfo.InvariantCulture),
                Low = Convert.ToDouble(reader.GetValue(5), CultureInfo.InvariantCulture),
                Close = Convert.ToDouble(reader.GetValue(6), CultureInfo.InvariantCulture),
                TickVolume = Convert.ToInt64(reader.GetValue(7), CultureInfo.InvariantCulture),
                RealVolume = Convert.ToInt64(reader.GetValue(8), CultureInfo.InvariantCulture),
                Spread = Convert.ToDouble(reader.GetValue(9), CultureInfo.InvariantCulture),
                Closed = Convert.ToInt32(reader.GetValue(10), CultureInfo.InvariantCulture) == 1,
                SourceRevision = ReadNullableString(reader, 11),
                ObservedAtUtcMsc = Convert.ToInt64(reader.GetValue(12), CultureInfo.InvariantCulture),
                LastAccessedUtcMsc = Convert.ToInt64(reader.GetValue(13), CultureInfo.InvariantCulture)
            };
        }

        private static void ValidateCandle(CandleRecord candle)
        {
            if (candle == null)
            {
                throw new InvalidDataException("bridge_cache_candle_invalid");
            }
            RequireText(candle.Symbol, "bridge_cache_symbol_invalid", 64);
            RequireText(candle.Timeframe, "bridge_cache_timeframe_invalid", 32);
            if (candle.OpenTimeUtcMsc < 1 || candle.ObservedAtUtcMsc < 1 || !candle.Closed)
            {
                throw new InvalidDataException(!candle.Closed ? "bridge_cache_open_candle_not_persisted" : "bridge_cache_candle_invalid");
            }
            RequireFinite(candle.Open, "bridge_cache_candle_price_invalid");
            RequireFinite(candle.High, "bridge_cache_candle_price_invalid");
            RequireFinite(candle.Low, "bridge_cache_candle_price_invalid");
            RequireFinite(candle.Close, "bridge_cache_candle_price_invalid");
            RequireFinite(candle.Spread, "bridge_cache_candle_spread_invalid");
            if (candle.TickVolume < 0 || candle.RealVolume < 0)
            {
                throw new InvalidDataException("bridge_cache_candle_volume_invalid");
            }
            if (candle.LastAccessedUtcMsc < 0)
            {
                throw new InvalidDataException("bridge_cache_candle_access_time_invalid");
            }
        }
    }
}
