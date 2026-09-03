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
        public void UpsertHistoryItem(long expectedConnectionEpoch, HistoryItemRecord item)
        {
            UpsertHistoryItems(expectedConnectionEpoch, new[] { item });
        }

        public void UpsertHistoryItems(long expectedConnectionEpoch, IList<HistoryItemRecord> items)
        {
            if (items == null || items.Count < 1)
            {
                throw new InvalidDataException("bridge_cache_history_batch_invalid");
            }
            NormalizeBatchSize(items.Count);
            for (int i = 0; i < items.Count; i++)
            {
                ValidateHistoryItem(items[i]);
            }

            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "INSERT OR IGNORE INTO history_items (profile_id, item_kind, item_id, event_time_utc_msc, ticket, order_id, position_id, symbol, funds_kind, amount_text, fact_json, source_revision, observed_at_utc_msc, last_accessed_utc_msc) VALUES (@profile_id, @item_kind, @item_id, @event_time_value, @ticket_value, @order_id_value, @position_id_value, @symbol_value, @funds_kind_value, @amount_value, @fact_json_value, @source_revision_value, @observed_at_value, @last_accessed_value); UPDATE history_items SET event_time_utc_msc = @event_time_value, ticket = @ticket_value, order_id = @order_id_value, position_id = @position_id_value, symbol = @symbol_value, funds_kind = @funds_kind_value, amount_text = @amount_value, source_revision = @source_revision_value, observed_at_utc_msc = @observed_at_value, fact_json = @fact_json_value, last_accessed_utc_msc = CASE WHEN last_accessed_utc_msc > @last_accessed_value THEN last_accessed_utc_msc ELSE @last_accessed_value END WHERE profile_id = @profile_id AND item_kind = @item_kind AND item_id = @item_id AND (observed_at_utc_msc < @observed_at_value OR (observed_at_utc_msc = @observed_at_value AND COALESCE(source_revision, '') = COALESCE(@source_revision_value, '')))";
                    SQLiteParameter profile = AddParameter(command, "@profile_id", null);
                    SQLiteParameter itemKind = AddParameter(command, "@item_kind", null);
                    SQLiteParameter itemId = AddParameter(command, "@item_id", null);
                    SQLiteParameter eventTime = AddParameter(command, "@event_time_value", 0L);
                    SQLiteParameter ticket = AddParameter(command, "@ticket_value", DBNull.Value);
                    SQLiteParameter orderId = AddParameter(command, "@order_id_value", DBNull.Value);
                    SQLiteParameter positionId = AddParameter(command, "@position_id_value", DBNull.Value);
                    SQLiteParameter symbol = AddParameter(command, "@symbol_value", DBNull.Value);
                    SQLiteParameter fundsKind = AddParameter(command, "@funds_kind_value", DBNull.Value);
                    SQLiteParameter amount = AddParameter(command, "@amount_value", DBNull.Value);
                    SQLiteParameter factJson = AddParameter(command, "@fact_json_value", null);
                    SQLiteParameter sourceRevision = AddParameter(command, "@source_revision_value", DBNull.Value);
                    SQLiteParameter observed = AddParameter(command, "@observed_at_value", 0L);
                    SQLiteParameter lastAccessed = AddParameter(command, "@last_accessed_value", 0L);

                    for (int i = 0; i < items.Count; i++)
                    {
                        HistoryItemRecord item = items[i];
                        profile.Value = profileId;
                        itemKind.Value = item.ItemKind;
                        itemId.Value = item.ItemId;
                        eventTime.Value = item.EventTimeUtcMsc;
                        ticket.Value = item.Ticket ?? (object)DBNull.Value;
                        orderId.Value = item.OrderId ?? (object)DBNull.Value;
                        positionId.Value = item.PositionId ?? (object)DBNull.Value;
                        symbol.Value = item.Symbol ?? (object)DBNull.Value;
                        fundsKind.Value = item.FundsKind ?? (object)DBNull.Value;
                        amount.Value = item.Amount.HasValue ? item.Amount.Value.ToString("G29", CultureInfo.InvariantCulture) : (object)DBNull.Value;
                        factJson.Value = item.FactJson;
                        sourceRevision.Value = item.SourceRevision ?? (object)DBNull.Value;
                        observed.Value = item.ObservedAtUtcMsc;
                        lastAccessed.Value = item.LastAccessedUtcMsc > 0 ? item.LastAccessedUtcMsc : item.ObservedAtUtcMsc;
                        command.ExecuteNonQuery();
                    }
                    transaction.Commit();
                }
            }
        }

        public HistoryPage ReadHistory(
            string itemKind,
            long rangeStartUtcMsc,
            long rangeEndUtcMsc,
            int limit,
            HistoryCursor cursor)
        {
            RequireText(itemKind, "bridge_cache_history_kind_invalid", 64);
            ValidateRange(rangeStartUtcMsc, rangeEndUtcMsc, "bridge_cache_history_range_invalid");
            int pageSize = NormalizePageSize(limit);
            if (cursor != null && (cursor.EventTimeUtcMsc < rangeStartUtcMsc || string.IsNullOrEmpty(cursor.ItemId)))
            {
                throw new InvalidDataException("bridge_cache_cursor_invalid");
            }

            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                {
                    List<HistoryItemRecord> rows = new List<HistoryItemRecord>();
                    using (SQLiteCommand command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "SELECT item_kind, item_id, event_time_utc_msc, ticket, order_id, position_id, symbol, funds_kind, amount_text, fact_json, source_revision, observed_at_utc_msc, last_accessed_utc_msc FROM history_items WHERE profile_id = @profile_id AND item_kind = @item_kind AND event_time_utc_msc >= @range_start AND event_time_utc_msc < @range_end AND (@has_cursor = 0 OR event_time_utc_msc > @cursor_time OR (event_time_utc_msc = @cursor_time AND item_id > @cursor_id)) ORDER BY event_time_utc_msc ASC, item_id ASC LIMIT @limit_value";
                        AddParameter(command, "@profile_id", profileId);
                        AddParameter(command, "@item_kind", itemKind);
                        AddParameter(command, "@range_start", rangeStartUtcMsc);
                        AddParameter(command, "@range_end", rangeEndUtcMsc);
                        AddParameter(command, "@has_cursor", cursor == null ? 0 : 1);
                        AddParameter(command, "@cursor_time", cursor == null ? 0 : cursor.EventTimeUtcMsc);
                        AddParameter(command, "@cursor_id", cursor == null ? string.Empty : cursor.ItemId);
                        AddParameter(command, "@limit_value", pageSize + 1);
                        using (SQLiteDataReader reader = command.ExecuteReader())
                        {
                            while (reader.Read())
                            {
                                rows.Add(ReadHistoryItem(reader));
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
                        HistoryItemRecord last = rows[rows.Count - 1];
                        using (SQLiteCommand touch = connection.CreateCommand())
                        {
                            touch.Transaction = transaction;
                            touch.CommandText = "UPDATE history_items SET last_accessed_utc_msc = @last_accessed WHERE profile_id = @profile_id AND item_kind = @item_kind AND event_time_utc_msc >= @range_start AND event_time_utc_msc < @range_end AND (@has_cursor = 0 OR event_time_utc_msc > @cursor_time OR (event_time_utc_msc = @cursor_time AND item_id > @cursor_id)) AND (event_time_utc_msc < @last_event_time OR (event_time_utc_msc = @last_event_time AND item_id <= @last_item_id))";
                            AddParameter(touch, "@last_accessed", touchAt);
                            AddParameter(touch, "@profile_id", profileId);
                            AddParameter(touch, "@item_kind", itemKind);
                            AddParameter(touch, "@range_start", rangeStartUtcMsc);
                            AddParameter(touch, "@range_end", rangeEndUtcMsc);
                            AddParameter(touch, "@has_cursor", cursor == null ? 0 : 1);
                            AddParameter(touch, "@cursor_time", cursor == null ? 0 : cursor.EventTimeUtcMsc);
                            AddParameter(touch, "@cursor_id", cursor == null ? string.Empty : cursor.ItemId);
                            AddParameter(touch, "@last_event_time", last.EventTimeUtcMsc);
                            AddParameter(touch, "@last_item_id", last.ItemId);
                            touch.ExecuteNonQuery();
                        }
                        for (int i = 0; i < rows.Count; i++)
                        {
                            rows[i].LastAccessedUtcMsc = touchAt;
                        }
                    }
                    transaction.Commit();
                    return new HistoryPage
                    {
                        Items = rows,
                        HasMore = hasMore,
                        NextCursor = rows.Count == 0 ? null : new HistoryCursor(rows[rows.Count - 1].EventTimeUtcMsc, rows[rows.Count - 1].ItemId)
                    };
                }
            }
        }

        private static HistoryItemRecord ReadHistoryItem(SQLiteDataReader reader)
        {
            string amountText = ReadNullableString(reader, 8);
            decimal amount;
            return new HistoryItemRecord
            {
                ItemKind = reader.GetString(0),
                ItemId = reader.GetString(1),
                EventTimeUtcMsc = Convert.ToInt64(reader.GetValue(2), CultureInfo.InvariantCulture),
                Ticket = ReadNullableString(reader, 3),
                OrderId = ReadNullableString(reader, 4),
                PositionId = ReadNullableString(reader, 5),
                Symbol = ReadNullableString(reader, 6),
                FundsKind = ReadNullableString(reader, 7),
                Amount = string.IsNullOrEmpty(amountText) || !decimal.TryParse(amountText, NumberStyles.Number, CultureInfo.InvariantCulture, out amount) ? (decimal?)null : amount,
                FactJson = reader.GetString(9),
                SourceRevision = ReadNullableString(reader, 10),
                ObservedAtUtcMsc = Convert.ToInt64(reader.GetValue(11), CultureInfo.InvariantCulture),
                LastAccessedUtcMsc = Convert.ToInt64(reader.GetValue(12), CultureInfo.InvariantCulture)
            };
        }

        private static void ValidateHistoryItem(HistoryItemRecord item)
        {
            if (item == null)
            {
                throw new InvalidDataException("bridge_cache_history_item_invalid");
            }
            RequireText(item.ItemKind, "bridge_cache_history_kind_invalid", 64);
            RequireText(item.ItemId, "bridge_cache_history_id_invalid", 191);
            RequireNumericIdentifierIfPresent(item.Ticket, "bridge_cache_ticket_invalid", 20);
            RequireNumericIdentifierIfPresent(item.OrderId, "bridge_cache_order_id_invalid", 20);
            RequireNumericIdentifierIfPresent(item.PositionId, "bridge_cache_position_id_invalid", 20);
            RequireText(item.FactJson, "bridge_cache_history_json_invalid", 1024 * 1024);
            if (item.EventTimeUtcMsc < 1 || item.ObservedAtUtcMsc < 1 || item.LastAccessedUtcMsc < 0)
            {
                throw new InvalidDataException("bridge_cache_history_item_invalid");
            }
        }

        private static void RequireNumericIdentifierIfPresent(string value, string error, int maxLength)
        {
            if (value == null)
            {
                return;
            }
            RequireNumericIdentifier(value, error, maxLength);
        }
    }
}
