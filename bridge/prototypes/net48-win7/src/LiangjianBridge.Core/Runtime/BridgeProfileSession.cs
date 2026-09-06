using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Storage;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.Runtime
{
    public sealed class BridgeProfileSession
    {
        private readonly ProfileRuntime runtime;
        private readonly ITerminalQuerySource terminal;
        private readonly ITerminalCommandSource commands;
        private readonly ProjectionQueryCoordinator projections;
        private readonly ProfileOutboxCoordinator outbox;
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        private PendingCommand pendingCommand;

        public BridgeProfileSession(ProfileRuntime runtimeValue, ITerminalQuerySource terminalValue)
            : this(runtimeValue, terminalValue, null)
        {
        }

        public BridgeProfileSession(ProfileRuntime runtimeValue, ITerminalQuerySource terminalValue,
            ITerminalCommandSource commandValue)
        {
            if (runtimeValue == null || terminalValue == null)
            {
                throw new ArgumentNullException("runtimeValue");
            }
            runtime = runtimeValue;
            terminal = terminalValue;
            commands = commandValue;
            projections = new ProjectionQueryCoordinator();
            outbox = new ProfileOutboxCoordinator();
            serializer.MaxJsonLength = 1024 * 1024;
        }

        public string Handle(string incomingJson, long nowUtcMsc)
        {
            if (nowUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_session_time_invalid");
            }
            BridgeEnvelope envelope = BridgeEnvelope.Parse(incomingJson);
            runtime.ValidateRoute(envelope.TerminalInstanceId, envelope.BrokerServer, envelope.Login, envelope.ConnectionEpoch);
            if (envelope.MessageType == "data.persisted.ack")
            {
                outbox.ApplyPersistedAck(runtime, envelope);
                return null;
            }
            if (envelope.MessageType == "command.result_ack")
            {
                BridgeCommandResultAck ack = BridgeCommandResultAck.Parse(envelope);
                outbox.AcknowledgeDurableKind(runtime, ResultMessageKind(ack.CommandId), nowUtcMsc);
                return null;
            }
            if (envelope.MessageType == "command.reconcile")
            {
                return HandleReconcile(envelope, BridgeCommandReconcile.Parse(envelope), nowUtcMsc);
            }
            if (envelope.MessageType == "command.request")
            {
                return HandleCommand(envelope, BridgeCommandRequest.Parse(envelope), nowUtcMsc);
            }
            if (envelope.MessageType != "query.request")
            {
                throw new InvalidDataException("bridge_session_message_unsupported");
            }

            BridgeQueryRequest request = BridgeQueryRequest.Parse(envelope);
            if (request.DeadlineUtcMsc <= nowUtcMsc)
            {
                return QueryError(envelope, request, nowUtcMsc, "bridge_query_deadline_expired", "Query deadline expired.", false);
            }
            try
            {
                return request.UsesLocalProjection
                    ? QueryProjection(envelope, request, nowUtcMsc)
                    : QueryTerminal(envelope, request, nowUtcMsc);
            }
            catch (InvalidOperationException error)
            {
                return QueryError(envelope, request, nowUtcMsc, SafeCode(error.Message, "bridge_terminal_unavailable"), "Terminal is unavailable.", true);
            }
            catch (InvalidDataException error)
            {
                return QueryError(envelope, request, nowUtcMsc, SafeCode(error.Message, "bridge_query_invalid"), "Query could not be completed.", false);
            }
        }

        public void AfterResponseSent(long nowUtcMsc)
        {
            PendingCommand pending = pendingCommand;
            pendingCommand = null;
            if (pending == null) return;
            ExecuteRecorded(pending, nowUtcMsc);
        }

        public void PrepareReconnect(long nowUtcMsc)
        {
            pendingCommand = null;
            IList<CommandLedgerRecord> rows = runtime.CommandLedger.ReadRecoverable(
                runtime.Configuration.ProfileId, 500);
            for (int index = 0; index < rows.Count; index++)
            {
                CommandLedgerRecord row = rows[index];
                if (row.State == "accepted")
                {
                    IDictionary<string, object> payload = ResultPayload(row.CommandId, row.Action,
                        "uncertain", nowUtcMsc, new Dictionary<string, object>
                        {
                            { "reconciliation_required", true }
                        }, "bridge_command_interrupted_after_dispatch", null);
                    StoreResult(row.IdempotencyKey, payload, "uncertain", nowUtcMsc);
                    row = runtime.CommandLedger.ReadByCommandId(runtime.Configuration.ProfileId, row.CommandId);
                }
                EnsureResultEnqueued(row, nowUtcMsc);
            }
        }

        private string HandleCommand(BridgeEnvelope envelope, BridgeCommandRequest request, long nowUtcMsc)
        {
            string profileId = runtime.Configuration.ProfileId;
            CommandAcceptance acceptance = runtime.CommandLedger.Accept(profileId, request.CommandId,
                request.IdempotencyKey, request.Action, request.RequestHash, nowUtcMsc);
            CommandLedgerRecord record = runtime.CommandLedger.ReadByIdempotencyKey(profileId, request.IdempotencyKey);
            if (acceptance.Duplicate && record.State != "recorded")
            {
                if (record.State == "accepted")
                {
                    IDictionary<string, object> interrupted = ResultPayload(record.CommandId, record.Action,
                        "uncertain", nowUtcMsc, new Dictionary<string, object>
                        {
                            { "reconciliation_required", true }
                        }, "bridge_command_dispatch_state_unknown", null);
                    StoreResult(record.IdempotencyKey, interrupted, "uncertain", nowUtcMsc);
                    record = runtime.CommandLedger.ReadByCommandId(profileId, record.CommandId);
                }
                EnsureResultEnqueued(record, nowUtcMsc);
            }
            else if (request.DeadlineUtcMsc <= nowUtcMsc)
            {
                IDictionary<string, object> expired = ResultPayload(request.CommandId, request.Action,
                    "rejected", nowUtcMsc, null, "bridge_command_deadline_expired", null);
                StoreResult(request.IdempotencyKey, expired, "rejected", nowUtcMsc);
            }
            else if (commands == null)
            {
                IDictionary<string, object> unavailable = ResultPayload(request.CommandId, request.Action,
                    "rejected", nowUtcMsc, null, "bridge_command_capability_unavailable", null);
                StoreResult(request.IdempotencyKey, unavailable, "rejected", nowUtcMsc);
            }
            else
            {
                pendingCommand = new PendingCommand(envelope, request);
            }
            return SerializeEnvelope(envelope, "command.accepted", new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "command_id", request.CommandId },
                { "status", acceptance.Duplicate ? "duplicate" : "recorded" },
                { "accepted_at_utc_msc", record.AcceptedAtUtcMsc }
            }, nowUtcMsc);
        }

        private string HandleReconcile(BridgeEnvelope envelope, BridgeCommandReconcile request, long nowUtcMsc)
        {
            CommandLedgerRecord record = runtime.CommandLedger.ReadByCommandId(
                runtime.Configuration.ProfileId, request.CommandId);
            if (record == null || !string.Equals(record.Action, request.Action, StringComparison.Ordinal))
                throw new InvalidDataException("bridge_command_reconcile_not_found");
            if (record.State != "uncertain" || commands == null)
            {
                EnsureResultEnqueued(record, nowUtcMsc);
                return null;
            }
            TerminalCommandExecutionResult result = commands.Reconcile(runtime, request, record, nowUtcMsc);
            IDictionary<string, object> payload = ResultPayload(record.CommandId, record.Action,
                result.Status, nowUtcMsc, result.Result, result.ErrorCode, result.TerminalCode);
            StoreResult(record.IdempotencyKey, payload, result.Status, nowUtcMsc);
            return null;
        }

        private void ExecuteRecorded(PendingCommand pending, long nowUtcMsc)
        {
            BridgeCommandRequest request = pending.Request;
            if (request.DeadlineUtcMsc <= nowUtcMsc)
            {
                StoreResult(request.IdempotencyKey, ResultPayload(request.CommandId, request.Action,
                    "rejected", nowUtcMsc, null, "bridge_command_deadline_expired", null), "rejected", nowUtcMsc);
                return;
            }
            if (!runtime.CommandLedger.TryMarkDispatched(runtime.Configuration.ProfileId, request.IdempotencyKey))
                return;
            TerminalCommandExecutionResult result;
            try
            {
                result = commands.Execute(runtime, request, nowUtcMsc);
            }
            catch (Exception error)
            {
                result = TerminalCommandExecutionResult.Uncertain("bridge_terminal_execution_interrupted",
                    new Dictionary<string, object> { { "detail", Limit(error.Message, 512) } });
            }
            if (result.Status == "uncertain")
            {
                IDictionary<string, object> details = result.Result == null
                    ? new Dictionary<string, object>(StringComparer.Ordinal)
                    : new Dictionary<string, object>(result.Result, StringComparer.Ordinal);
                details["reconcile"] = new Dictionary<string, object>(StringComparer.Ordinal)
                {
                    { "bridge_action", request.Action }, { "params", request.Parameters },
                    { "expected_state", request.ExpectedState },
                    { "original_command_id", request.CommandId },
                    { "original_issued_at_utc_msc", request.IssuedAtUtcMsc }
                };
                result = TerminalCommandExecutionResult.Create("uncertain", details,
                    result.ErrorCode, result.TerminalCode);
            }
            IDictionary<string, object> payload = ResultPayload(request.CommandId, request.Action,
                result.Status, nowUtcMsc, result.Result, result.ErrorCode, result.TerminalCode);
            StoreResult(request.IdempotencyKey, payload, result.Status, nowUtcMsc);
        }

        private void StoreResult(string idempotencyKey, IDictionary<string, object> payload,
            string state, long completedAtUtcMsc)
        {
            string payloadJson = serializer.Serialize(payload);
            runtime.CommandLedger.RecordResult(runtime.Configuration.ProfileId, idempotencyKey,
                state, completedAtUtcMsc, payloadJson);
            string commandId = (string)payload["command_id"];
            outbox.AcknowledgeDurableKind(runtime, ResultMessageKind(commandId), completedAtUtcMsc);
            EnqueueResult(commandId, payload, payloadJson, completedAtUtcMsc);
        }

        private void EnsureResultEnqueued(CommandLedgerRecord record, long nowUtcMsc)
        {
            if (record == null || string.IsNullOrEmpty(record.ResultJson)) return;
            string messageId = ResultMessageId(record.CommandId, record.ResultJson);
            if (runtime.DataStore.ReadOutboxMessage(messageId) != null) return;
            IDictionary<string, object> payload = serializer.DeserializeObject(record.ResultJson)
                as IDictionary<string, object>;
            if (payload == null) throw new InvalidDataException("bridge_command_result_invalid");
            outbox.AcknowledgeDurableKind(runtime, ResultMessageKind(record.CommandId), nowUtcMsc);
            EnqueueResult(record.CommandId, payload, record.ResultJson, nowUtcMsc);
        }

        private void EnqueueResult(string commandId, IDictionary<string, object> payload,
            string payloadJson, long nowUtcMsc)
        {
            string messageId = ResultMessageId(commandId, payloadJson);
            string envelope = SerializeEnvelope(messageId, null, "command.result", payload, nowUtcMsc);
            outbox.Enqueue(runtime, messageId, ResultMessageKind(commandId), envelope, 100, nowUtcMsc);
        }

        private static IDictionary<string, object> ResultPayload(string commandId, string action,
            string status, long completedAtUtcMsc, IDictionary<string, object> result,
            string errorCode, object terminalCode)
        {
            if (status != "succeeded" && status != "rejected" && status != "failed" && status != "uncertain")
                throw new InvalidDataException("bridge_command_result_status_invalid");
            return new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "command_id", commandId }, { "action", action }, { "status", status },
                { "completed_at_utc_msc", completedAtUtcMsc }, { "result", result },
                { "error_code", errorCode }, { "terminal_code", terminalCode }
            };
        }

        private static string ResultMessageId(string commandId, string payloadJson)
        {
            string hash = ProjectionQueryCoordinator.Hash(commandId + "|" + payloadJson);
            return "bridge-result-" + hash.Substring("sha256:".Length);
        }

        private static string ResultMessageKind(string commandId)
        {
            string hash = ProjectionQueryCoordinator.Hash(commandId);
            return "cmd." + hash.Substring("sha256:".Length, 32);
        }

        private string QueryProjection(BridgeEnvelope envelope, BridgeQueryRequest request, long nowUtcMsc)
        {
            bool candles = request.Resource == "market.candles";
            ProjectionCursorState cursor = ProjectionCursorCodec.Decode(
                BridgeQueryRequest.ReadOptionalText(request.Parameters, "cursor", 2048), candles);
            string scopeKey = candles
                ? BridgeQueryRequest.ReadText(request.Parameters, "symbol", 64) + "|" + BridgeQueryRequest.ReadText(request.Parameters, "timeframe", 4)
                : "*";
            ProjectionQueryResult result = projections.Query(runtime, new ProjectionQueryRequest
            {
                Resource = request.Resource,
                ScopeKey = scopeKey,
                RangeStartUtcMsc = BridgeQueryRequest.ReadLong(request.Parameters, "range_start_utc_msc"),
                RangeEndUtcMsc = BridgeQueryRequest.ReadLong(request.Parameters, "range_end_utc_msc"),
                Limit = BridgeQueryRequest.ReadInt(request.Parameters, "limit", 1, 500),
                SnapshotId = cursor.SnapshotId,
                CandleCursor = cursor.CandleCursor,
                HistoryCursor = cursor.HistoryCursor
            }, nowUtcMsc);
            if (result.Status == "refreshing")
            {
                return QueryError(envelope, request, nowUtcMsc, "bridge_projection_refreshing", "Local projection is refreshing.", true);
            }
            if (result.Status == "blocked")
            {
                return QueryError(envelope, request, nowUtcMsc, "bridge_projection_sync_blocked", "Local projection sync is blocked.", false);
            }
            IList<object> items = candles ? CandleItems(result.Candles.Items) : HistoryItems(result.History.Items);
            bool hasMore = candles ? result.Candles.HasMore : result.History.HasMore;
            string nextCursor = !hasMore ? null : candles
                ? ProjectionCursorCodec.EncodeCandles(result.SnapshotId, result.Candles.NextCursor)
                : ProjectionCursorCodec.EncodeHistory(result.SnapshotId, result.History.NextCursor);
            return QueryResponse(envelope, request, result.ObservedAtUtcMsc, result.SourceRevision,
                "local_projection", items, hasMore, nextCursor, nowUtcMsc);
        }

        private string QueryTerminal(BridgeEnvelope envelope, BridgeQueryRequest request, long nowUtcMsc)
        {
            TerminalQueryResult result = terminal.Query(runtime, request, nowUtcMsc);
            if (result.Resource != TerminalQueryTranslator.ResourceCode(request.Resource)
                || !string.Equals(result.RequestId, request.RequestId, StringComparison.Ordinal))
            {
                throw new InvalidDataException("bridge_terminal_response_correlation_invalid");
            }
            if (!result.Succeeded)
            {
                return QueryError(envelope, request, nowUtcMsc,
                    SafeCode(result.ErrorCode, "bridge_terminal_query_failed"), Limit(result.ErrorMessage, 512), true);
            }
            object parsed = serializer.DeserializeObject(result.DataJson);
            IDictionary<string, object> root = parsed as IDictionary<string, object>;
            if (root == null)
            {
                throw new InvalidDataException("bridge_terminal_response_json_invalid");
            }
            IList<object> items = new List<object>();
            object rawItems;
            object[] array;
            if (root.TryGetValue("items", out rawItems) && (array = rawItems as object[]) != null)
            {
                for (int index = 0; index < array.Length; index++)
                {
                    if (!(array[index] is IDictionary<string, object>))
                    {
                        throw new InvalidDataException("bridge_terminal_response_items_invalid");
                    }
                    items.Add(array[index]);
                }
            }
            else
            {
                items.Add(root);
            }
            string revision = ProjectionQueryCoordinator.Hash(request.Resource + "|"
                + result.ObservedAtUtcMsc.ToString(CultureInfo.InvariantCulture) + "|" + result.DataJson);
            return QueryResponse(envelope, request, result.ObservedAtUtcMsc, revision,
                "terminal", items, result.HasMore, EmptyToNull(result.NextCursor), nowUtcMsc);
        }

        private string QueryResponse(BridgeEnvelope envelope, BridgeQueryRequest request, long observedAtUtcMsc,
            string revision, string source, IList<object> items, bool hasMore, string nextCursor, long nowUtcMsc)
        {
            return SerializeEnvelope(envelope, "query.response", new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "request_id", request.RequestId }, { "resource", request.Resource },
                { "observed_at_utc_msc", observedAtUtcMsc }, { "source_revision", revision },
                { "source", source }, { "items", items }, { "has_more", hasMore }, { "next_cursor", nextCursor }
            }, nowUtcMsc);
        }

        private string QueryError(BridgeEnvelope envelope, BridgeQueryRequest request, long nowUtcMsc,
            string code, string message, bool retryable)
        {
            return SerializeEnvelope(envelope, "query.error", new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "request_id", request.RequestId }, { "resource", request.Resource },
                { "code", code }, { "message", message ?? string.Empty }, { "retryable", retryable }
            }, nowUtcMsc);
        }

        private string SerializeEnvelope(BridgeEnvelope incoming, string type, IDictionary<string, object> payload, long nowUtcMsc)
        {
            return SerializeEnvelope("bridge-" + Guid.NewGuid().ToString("N"), incoming.MessageId,
                type, payload, nowUtcMsc);
        }

        private string SerializeEnvelope(string messageId, string correlationId, string type,
            IDictionary<string, object> payload, long nowUtcMsc)
        {
            ProfileRuntimeConfiguration route = runtime.Configuration;
            return serializer.Serialize(new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "v", 4 }, { "message_id", messageId }, { "type", type },
                { "sent_at_utc_msc", nowUtcMsc }, { "correlation_id", correlationId },
                { "route", new Dictionary<string, object>(StringComparer.Ordinal)
                    {
                        { "terminal_instance_id", route.TerminalInstanceId },
                        { "account_ref", new Dictionary<string, object>(StringComparer.Ordinal)
                            { { "broker_server", route.BrokerServer }, { "login", route.Login } } },
                        { "connection_epoch", runtime.ConnectionEpoch }
                    }
                },
                { "payload", payload }
            });
        }

        private IList<object> CandleItems(IList<CandleRecord> records)
        {
            List<object> items = new List<object>(records.Count);
            for (int index = 0; index < records.Count; index++)
            {
                CandleRecord row = records[index];
                items.Add(new Dictionary<string, object>(StringComparer.Ordinal)
                {
                    { "symbol", row.Symbol }, { "timeframe", row.Timeframe }, { "open_time_utc_msc", row.OpenTimeUtcMsc },
                    { "open", row.Open }, { "high", row.High }, { "low", row.Low }, { "close", row.Close },
                    { "tick_volume", row.TickVolume }, { "real_volume", row.RealVolume }, { "spread", row.Spread }, { "closed", row.Closed }
                });
            }
            return items;
        }

        private IList<object> HistoryItems(IList<HistoryItemRecord> records)
        {
            List<object> items = new List<object>(records.Count);
            for (int index = 0; index < records.Count; index++)
            {
                object item = serializer.DeserializeObject(records[index].FactJson);
                if (!(item is IDictionary<string, object>))
                {
                    throw new InvalidDataException("bridge_history_fact_invalid");
                }
                items.Add(item);
            }
            return items;
        }

        private static string EmptyToNull(string value) { return string.IsNullOrEmpty(value) ? null : value; }
        private static string Limit(string value, int maximum) { return string.IsNullOrEmpty(value) || value.Length <= maximum ? value : value.Substring(0, maximum); }
        private static string SafeCode(string value, string fallback)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 128 || value[0] < 'a' || value[0] > 'z') return fallback;
            for (int i = 1; i < value.Length; i++) if (!((value[i] >= 'a' && value[i] <= 'z') || (value[i] >= '0' && value[i] <= '9') || value[i] == '_')) return fallback;
            return value.Length < 2 ? fallback : value;
        }

        private sealed class PendingCommand
        {
            public PendingCommand(BridgeEnvelope envelopeValue, BridgeCommandRequest requestValue)
            {
                Envelope = envelopeValue;
                Request = requestValue;
            }
            public BridgeEnvelope Envelope { get; private set; }
            public BridgeCommandRequest Request { get; private set; }
        }
    }
}
