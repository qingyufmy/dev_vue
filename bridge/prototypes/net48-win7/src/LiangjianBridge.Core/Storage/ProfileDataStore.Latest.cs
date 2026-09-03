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
        public bool ReplacePositionsSnapshot(long expectedConnectionEpoch, string revision, long observedAtUtcMsc, IList<PositionLatestRecord> positions)
        {
            ValidateSnapshotHeader(expectedConnectionEpoch, revision, observedAtUtcMsc);
            if (positions == null)
            {
                ValidateEmptySnapshot(positions);
            }
            if (positions.Count > 0)
            {
                NormalizeBatchSize(positions.Count);
            }
            for (int i = 0; i < positions.Count; i++)
            {
                ValidatePosition(positions[i], expectedConnectionEpoch);
            }

            return ReplaceLatestSnapshot(
                expectedConnectionEpoch,
                "positions",
                revision,
                observedAtUtcMsc,
                positions,
                "positions_latest",
                delegate(SQLiteCommand command, PositionLatestRecord item, long epoch, string snapshotRevision, long observed)
                {
                    command.Parameters["@ticket"].Value = item.Ticket;
                    command.Parameters["@symbol"].Value = item.Symbol;
                    command.Parameters["@direction"].Value = item.Direction;
                    command.Parameters["@volume"].Value = DecimalText(item.Volume);
                    command.Parameters["@open_price"].Value = (object)DecimalText(item.OpenPrice) ?? DBNull.Value;
                    command.Parameters["@stop_loss"].Value = (object)DecimalText(item.StopLoss) ?? DBNull.Value;
                    command.Parameters["@take_profit"].Value = (object)DecimalText(item.TakeProfit) ?? DBNull.Value;
                    command.Parameters["@current_price"].Value = (object)DecimalText(item.CurrentPrice) ?? DBNull.Value;
                    command.Parameters["@profit"].Value = (object)DecimalText(item.Profit) ?? DBNull.Value;
                    command.Parameters["@fact_json"].Value = item.FactJson;
                },
                "INSERT INTO positions_latest (profile_id, ticket, connection_epoch, revision, observed_at_utc_msc, symbol, direction, volume_text, open_price_text, stop_loss_text, take_profit_text, current_price_text, profit_text, fact_json) VALUES (@profile_id, @ticket, @epoch, @revision, @observed, @symbol, @direction, @volume, @open_price, @stop_loss, @take_profit, @current_price, @profit, @fact_json)");
        }

        public bool ReplacePendingOrdersSnapshot(long expectedConnectionEpoch, string revision, long observedAtUtcMsc, IList<PendingOrderLatestRecord> orders)
        {
            ValidateSnapshotHeader(expectedConnectionEpoch, revision, observedAtUtcMsc);
            if (orders == null)
            {
                ValidateEmptySnapshot(orders);
            }
            if (orders.Count > 0)
            {
                NormalizeBatchSize(orders.Count);
            }
            for (int i = 0; i < orders.Count; i++)
            {
                ValidatePendingOrder(orders[i], expectedConnectionEpoch);
            }

            return ReplaceLatestSnapshot(
                expectedConnectionEpoch,
                "pending_orders",
                revision,
                observedAtUtcMsc,
                orders,
                "pending_orders_latest",
                delegate(SQLiteCommand command, PendingOrderLatestRecord item, long epoch, string snapshotRevision, long observed)
                {
                    command.Parameters["@ticket"].Value = item.Ticket;
                    command.Parameters["@symbol"].Value = item.Symbol;
                    command.Parameters["@order_type"].Value = item.OrderType;
                    command.Parameters["@direction"].Value = item.Direction;
                    command.Parameters["@volume"].Value = DecimalText(item.Volume);
                    command.Parameters["@requested_price"].Value = (object)DecimalText(item.RequestedPrice) ?? DBNull.Value;
                    command.Parameters["@stop_loss"].Value = (object)DecimalText(item.StopLoss) ?? DBNull.Value;
                    command.Parameters["@take_profit"].Value = (object)DecimalText(item.TakeProfit) ?? DBNull.Value;
                    command.Parameters["@fact_json"].Value = item.FactJson;
                },
                "INSERT INTO pending_orders_latest (profile_id, ticket, connection_epoch, revision, observed_at_utc_msc, symbol, order_type, direction, volume_text, requested_price_text, stop_loss_text, take_profit_text, fact_json) VALUES (@profile_id, @ticket, @epoch, @revision, @observed, @symbol, @order_type, @direction, @volume, @requested_price, @stop_loss, @take_profit, @fact_json)");
        }

        public IList<PositionLatestRecord> ReadPositionsLatest()
        {
            lock (writeGate)
            {
                EnsureNotDisposed();
                List<PositionLatestRecord> rows = new List<PositionLatestRecord>();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT ticket, connection_epoch, revision, observed_at_utc_msc, symbol, direction, volume_text, open_price_text, stop_loss_text, take_profit_text, current_price_text, profit_text, fact_json FROM positions_latest WHERE profile_id = @profile_id AND connection_epoch = @epoch ORDER BY ticket ASC";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@epoch", connectionEpoch);
                    using (SQLiteDataReader reader = command.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            rows.Add(new PositionLatestRecord
                            {
                                Ticket = reader.GetString(0),
                                ConnectionEpoch = Convert.ToInt64(reader.GetValue(1), CultureInfo.InvariantCulture),
                                Revision = reader.GetString(2),
                                ObservedAtUtcMsc = Convert.ToInt64(reader.GetValue(3), CultureInfo.InvariantCulture),
                                Symbol = reader.GetString(4),
                                Direction = reader.GetString(5),
                                Volume = DecimalValue(reader, 6).GetValueOrDefault(),
                                OpenPrice = DecimalValue(reader, 7),
                                StopLoss = DecimalValue(reader, 8),
                                TakeProfit = DecimalValue(reader, 9),
                                CurrentPrice = DecimalValue(reader, 10),
                                Profit = DecimalValue(reader, 11),
                                FactJson = reader.GetString(12)
                            });
                        }
                    }
                }
                return rows;
            }
        }

        public IList<PendingOrderLatestRecord> ReadPendingOrdersLatest()
        {
            lock (writeGate)
            {
                EnsureNotDisposed();
                List<PendingOrderLatestRecord> rows = new List<PendingOrderLatestRecord>();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT ticket, connection_epoch, revision, observed_at_utc_msc, symbol, order_type, direction, volume_text, requested_price_text, stop_loss_text, take_profit_text, fact_json FROM pending_orders_latest WHERE profile_id = @profile_id AND connection_epoch = @epoch ORDER BY ticket ASC";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@epoch", connectionEpoch);
                    using (SQLiteDataReader reader = command.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            rows.Add(new PendingOrderLatestRecord
                            {
                                Ticket = reader.GetString(0),
                                ConnectionEpoch = Convert.ToInt64(reader.GetValue(1), CultureInfo.InvariantCulture),
                                Revision = reader.GetString(2),
                                ObservedAtUtcMsc = Convert.ToInt64(reader.GetValue(3), CultureInfo.InvariantCulture),
                                Symbol = reader.GetString(4),
                                OrderType = reader.GetString(5),
                                Direction = reader.GetString(6),
                                Volume = DecimalValue(reader, 7).GetValueOrDefault(),
                                RequestedPrice = DecimalValue(reader, 8),
                                StopLoss = DecimalValue(reader, 9),
                                TakeProfit = DecimalValue(reader, 10),
                                FactJson = reader.GetString(11)
                            });
                        }
                    }
                }
                return rows;
            }
        }

        private bool ReplaceLatestSnapshot<T>(long expectedConnectionEpoch, string resource, string revision, long observedAtUtcMsc, IList<T> items, string tableName, Action<SQLiteCommand, T, long, string, long> bindItem, string insertSql)
        {
            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                {
                    if (!IsSnapshotFresh(transaction, resource, expectedConnectionEpoch, revision, observedAtUtcMsc))
                    {
                        transaction.Commit();
                        return false;
                    }

                    using (SQLiteCommand delete = connection.CreateCommand())
                    {
                        delete.Transaction = transaction;
                        delete.CommandText = "DELETE FROM " + tableName + " WHERE profile_id = @profile_id";
                        AddParameter(delete, "@profile_id", profileId);
                        delete.ExecuteNonQuery();
                    }
                    using (SQLiteCommand insert = connection.CreateCommand())
                    {
                        insert.Transaction = transaction;
                        insert.CommandText = insertSql;
                        AddParameter(insert, "@profile_id", profileId);
                        AddParameter(insert, "@ticket", null);
                        AddParameter(insert, "@epoch", expectedConnectionEpoch);
                        AddParameter(insert, "@revision", revision);
                        AddParameter(insert, "@observed", observedAtUtcMsc);
                        AddParameter(insert, "@symbol", null);
                        AddParameter(insert, "@direction", null);
                        AddParameter(insert, "@volume", null);
                        AddParameter(insert, "@open_price", DBNull.Value);
                        AddParameter(insert, "@stop_loss", DBNull.Value);
                        AddParameter(insert, "@take_profit", DBNull.Value);
                        AddParameter(insert, "@current_price", DBNull.Value);
                        AddParameter(insert, "@profit", DBNull.Value);
                        AddParameter(insert, "@order_type", null);
                        AddParameter(insert, "@requested_price", DBNull.Value);
                        AddParameter(insert, "@fact_json", null);
                        for (int i = 0; i < items.Count; i++)
                        {
                            bindItem(insert, items[i], expectedConnectionEpoch, revision, observedAtUtcMsc);
                            insert.ExecuteNonQuery();
                        }
                    }
                    UpsertSnapshotState(transaction, resource, expectedConnectionEpoch, revision, observedAtUtcMsc);
                    transaction.Commit();
                    return true;
                }
            }
        }

        private bool IsSnapshotFresh(SQLiteTransaction transaction, string resource, long expectedConnectionEpoch, string revision, long observedAtUtcMsc)
        {
            using (SQLiteCommand command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "SELECT connection_epoch, revision, observed_at_utc_msc FROM stream_state WHERE profile_id = @profile_id AND resource = @resource LIMIT 1";
                AddParameter(command, "@profile_id", profileId);
                AddParameter(command, "@resource", resource);
                using (SQLiteDataReader reader = command.ExecuteReader(CommandBehavior.SingleRow))
                {
                    if (!reader.Read())
                    {
                        return true;
                    }
                    long currentEpoch = Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture);
                    long currentObserved = Convert.ToInt64(reader.GetValue(2), CultureInfo.InvariantCulture);
                    string currentRevision = ReadNullableString(reader, 1);
                    return currentEpoch != expectedConnectionEpoch
                        || currentObserved < observedAtUtcMsc
                        || (currentObserved == observedAtUtcMsc && string.Equals(currentRevision ?? string.Empty, revision ?? string.Empty, StringComparison.Ordinal));
                }
            }
        }

        private void UpsertSnapshotState(SQLiteTransaction transaction, string resource, long expectedConnectionEpoch, string revision, long observedAtUtcMsc)
        {
            using (SQLiteCommand command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "INSERT OR IGNORE INTO stream_state (profile_id, resource, connection_epoch, revision, payload_hash, source_time_utc_msc, observed_at_utc_msc, status) VALUES (@profile_id, @resource, @epoch, @revision, NULL, NULL, @observed, 'live'); UPDATE stream_state SET connection_epoch = @epoch, revision = @revision, payload_hash = NULL, source_time_utc_msc = NULL, observed_at_utc_msc = @observed, status = 'live' WHERE profile_id = @profile_id AND resource = @resource";
                AddParameter(command, "@profile_id", profileId);
                AddParameter(command, "@resource", resource);
                AddParameter(command, "@epoch", expectedConnectionEpoch);
                AddParameter(command, "@revision", revision);
                AddParameter(command, "@observed", observedAtUtcMsc);
                command.ExecuteNonQuery();
            }
        }

        private static void ValidateSnapshotHeader(long expectedConnectionEpoch, string revision, long observedAtUtcMsc)
        {
            RequireEpoch(expectedConnectionEpoch, "bridge_cache_epoch_invalid");
            RequireText(revision, "bridge_cache_snapshot_revision_invalid", 191);
            if (observedAtUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_snapshot_time_invalid");
            }
        }

        private static void ValidateEmptySnapshot<T>(IList<T> items)
        {
            if (items == null)
            {
                throw new InvalidDataException("bridge_cache_snapshot_items_invalid");
            }
        }

        private static void ValidatePosition(PositionLatestRecord item, long expectedConnectionEpoch)
        {
            if (item == null)
            {
                throw new InvalidDataException("bridge_cache_position_invalid");
            }
            RequireNumericIdentifier(item.Ticket, "bridge_cache_ticket_invalid", 20);
            if (item.ConnectionEpoch != 0 && item.ConnectionEpoch != expectedConnectionEpoch)
            {
                throw new InvalidDataException("bridge_cache_profile_epoch_mismatch");
            }
            RequireText(item.Symbol, "bridge_cache_symbol_invalid", 64);
            RequireText(item.Direction, "bridge_cache_direction_invalid", 32);
            if (item.Volume < 0)
            {
                throw new InvalidDataException("bridge_cache_volume_invalid");
            }
            RequireDecimal(item.OpenPrice, "bridge_cache_price_invalid");
            RequireDecimal(item.StopLoss, "bridge_cache_price_invalid");
            RequireDecimal(item.TakeProfit, "bridge_cache_price_invalid");
            RequireDecimal(item.CurrentPrice, "bridge_cache_price_invalid");
            RequireDecimal(item.Profit, "bridge_cache_profit_invalid");
            ValidateFactJson(item.FactJson, "bridge_cache_position_json_invalid");
        }

        private static void ValidatePendingOrder(PendingOrderLatestRecord item, long expectedConnectionEpoch)
        {
            if (item == null)
            {
                throw new InvalidDataException("bridge_cache_pending_order_invalid");
            }
            RequireNumericIdentifier(item.Ticket, "bridge_cache_ticket_invalid", 20);
            if (item.ConnectionEpoch != 0 && item.ConnectionEpoch != expectedConnectionEpoch)
            {
                throw new InvalidDataException("bridge_cache_profile_epoch_mismatch");
            }
            RequireText(item.Symbol, "bridge_cache_symbol_invalid", 64);
            RequireText(item.OrderType, "bridge_cache_order_type_invalid", 32);
            RequireText(item.Direction, "bridge_cache_direction_invalid", 32);
            if (item.Volume < 0)
            {
                throw new InvalidDataException("bridge_cache_volume_invalid");
            }
            RequireDecimal(item.RequestedPrice, "bridge_cache_price_invalid");
            RequireDecimal(item.StopLoss, "bridge_cache_price_invalid");
            RequireDecimal(item.TakeProfit, "bridge_cache_price_invalid");
            ValidateFactJson(item.FactJson, "bridge_cache_pending_order_json_invalid");
        }
    }
}
