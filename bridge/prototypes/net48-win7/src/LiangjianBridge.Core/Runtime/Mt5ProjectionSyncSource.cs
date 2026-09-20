using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Liangjian.BridgeV4.Storage;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.Runtime
{
    public sealed class Mt5ProjectionSyncSource : ITerminalProjectionSource
    {
        private readonly Mt5WorkerHost liveHost;
        private readonly Mt5WorkerHost archiveHost;

        public Mt5ProjectionSyncSource(Mt5WorkerHost live, Mt5WorkerHost archive)
        {
            if (live == null || archive == null)
            {
                throw new ArgumentNullException(live == null ? "live" : "archive");
            }
            liveHost = live;
            archiveHost = archive;
        }

        public ProjectionSyncBatch Fetch(ProjectionSyncRequest request)
        {
            Validate(request);
            return request.Resource == "market.candles"
                ? FetchCandles(request)
                : FetchHistory(request);
        }

        private ProjectionSyncBatch FetchCandles(ProjectionSyncRequest request)
        {
            string[] scope = request.ScopeKey.Split('|');
            long windowMsc = ProjectionSourceSupport.CandleWindowMsc(
                scope[1], Math.Max(1, request.Limit - 1));
            ProjectionSourceCursor cursor = ProjectionSourceSupport.ResolveWindow(request, windowMsc);
            Mt5WorkerResponse response = liveHost.Request(
                request.TerminalInstanceId, request.BrokerServer, request.Login, "live", "data",
                new Dictionary<string, object>(StringComparer.Ordinal)
                {
                    { "action", "rates" },
                    { "params", new Dictionary<string, object>(StringComparer.Ordinal)
                        {
                            { "symbol", scope[0] },
                            { "timeframe", scope[1] },
                            { "count", request.Limit },
                            { "start_utc_msc", cursor.WindowStartUtcMsc },
                            { "end_utc_msc", cursor.WindowEndUtcMsc - 1 }
                        }
                    }
                });
            RequireOutcome(response, "data");
            IDictionary<string, object> data = ProjectionSourceSupport.ReadObject(response.Payload, "data");
            if (ReadText(data, "action") != "rates")
            {
                throw new InvalidDataException("bridge_mt5_projection_action_mismatch");
            }
            long observedAt = ProjectionSourceSupport.ReadLong(data, "observed_at_utc_msc");
            IDictionary<string, object> payload = ProjectionSourceSupport.ReadObject(data, "payload");
            string revision = ProjectionSourceSupport.SourceRevision(request);
            bool hasMore = cursor.WindowEndUtcMsc < request.RangeEndUtcMsc;
            return new ProjectionSyncBatch
            {
                Resource = request.Resource,
                ScopeKey = request.ScopeKey,
                CoveredRangeStartUtcMsc = cursor.WindowStartUtcMsc,
                CoveredRangeEndUtcMsc = cursor.WindowEndUtcMsc,
                SourceRevision = revision,
                Candles = ProjectionSourceSupport.MapCandles(payload, scope[0], scope[1],
                    cursor.WindowStartUtcMsc, cursor.WindowEndUtcMsc, observedAt, revision, request.AllowOpenCandles),
                History = new List<HistoryItemRecord>(),
                PublishCoverage = true,
                HasMore = hasMore,
                NextCursor = hasMore ? ProjectionSourceSupport.EncodeCursor(
                    ProjectionSourceSupport.NextWindow(request, cursor.WindowEndUtcMsc, windowMsc)) : null
            };
        }

        private ProjectionSyncBatch FetchHistory(ProjectionSyncRequest request)
        {
            ProjectionSourceCursor cursor = ProjectionSourceSupport.ResolveWindow(
                request, ProjectionSourceSupport.HistoryWindowMsc);
            int workerLimit = Math.Min(request.Limit, 250);
            Mt5WorkerResponse response = null;
            for (int split = 0; split <= 12; split++)
            {
                response = archiveHost.Request(
                request.TerminalInstanceId, request.BrokerServer, request.Login, "archive",
                "history_range_sync",
                new Dictionary<string, object>(StringComparer.Ordinal)
                {
                    { "range_start_utc_msc", cursor.WindowStartUtcMsc },
                    { "range_end_utc_msc", cursor.WindowEndUtcMsc },
                    { "cursor", new Dictionary<string, object>(StringComparer.Ordinal)
                        {
                            { "time_msc", cursor.NativeTimeUtcMsc },
                            { "ticket", cursor.NativeTicket ?? "0" }
                        }
                    },
                    { "limit", workerLimit }
                });
                object errorCode;
                bool dense = response != null && response.IsError && response.Payload != null
                    && response.Payload.TryGetValue("error_code", out errorCode)
                    && Convert.ToString(errorCode, CultureInfo.InvariantCulture) == "mt5_history_range_too_dense";
                if (!dense) break;
                // Preserve the exact covered prefix; only divide a fresh window, never skip a cursor group.
                if (split == 12 || !ProjectionSourceSupport.ShrinkFreshHistoryWindow(cursor)) break;
            }
            RequireOutcome(response, "history_batch");
            IDictionary<string, object> batch = ProjectionSourceSupport.ReadObject(response.Payload, "batch");
            bool nativeHasMore = ProjectionSourceSupport.ReadBoolean(batch, "has_more");
            long observedAt = ProjectionSourceSupport.ReadLong(batch, "observed_at_utc_msc");
            string collection = request.Resource == "history.orders" ? "history_orders"
                : request.Resource == "history.trades" ? "trades" : "deals";
            string revision = ProjectionSourceSupport.SourceRevision(request);
            bool publishCoverage = !nativeHasMore;
            bool hasMore = nativeHasMore || cursor.WindowEndUtcMsc < request.RangeEndUtcMsc;
            string nextCursor = null;
            if (nativeHasMore)
            {
                IDictionary<string, object> next = ProjectionSourceSupport.ReadObject(batch, "next_cursor");
                long nextTime = ProjectionSourceSupport.ReadLong(next, "time_msc");
                string nextTicket = Identifier(next, "ticket");
                if (nextTime < cursor.NativeTimeUtcMsc
                    || (nextTime == cursor.NativeTimeUtcMsc
                        && CompareNumeric(nextTicket, cursor.NativeTicket) <= 0))
                {
                    throw new InvalidDataException("bridge_mt5_projection_cursor_not_advanced");
                }
                cursor.NativeTimeUtcMsc = nextTime;
                cursor.NativeTicket = nextTicket;
                nextCursor = ProjectionSourceSupport.EncodeCursor(cursor);
            }
            else if (hasMore)
            {
                nextCursor = ProjectionSourceSupport.EncodeCursor(
                    ProjectionSourceSupport.NextWindow(request, cursor.WindowEndUtcMsc,
                        ProjectionSourceSupport.HistoryWindowMsc));
            }
            return new ProjectionSyncBatch
            {
                Resource = request.Resource,
                ScopeKey = request.ScopeKey,
                CoveredRangeStartUtcMsc = cursor.WindowStartUtcMsc,
                CoveredRangeEndUtcMsc = cursor.WindowEndUtcMsc,
                SourceRevision = revision,
                Candles = new List<CandleRecord>(),
                History = ProjectionSourceSupport.MapHistory(
                    ProjectionSourceSupport.ReadArray(batch, collection), HistoryKind(request.Resource),
                    cursor.WindowStartUtcMsc, cursor.WindowEndUtcMsc, observedAt, revision),
                PublishCoverage = publishCoverage,
                HasMore = hasMore,
                NextCursor = nextCursor
            };
        }

        private static void Validate(ProjectionSyncRequest request)
        {
            if (request == null || !string.Equals(request.Platform, "mt5", StringComparison.OrdinalIgnoreCase)
                || request.ConnectionEpoch < 1 || request.RangeStartUtcMsc < 1
                || request.RangeEndUtcMsc <= request.RangeStartUtcMsc
                || request.Limit < 1 || request.Limit > ProfileDataStore.MaxBatchSize)
            {
                throw new InvalidDataException("bridge_mt5_projection_request_invalid");
            }
            if (request.Resource == "market.candles")
            {
                string[] scope = (request.ScopeKey ?? string.Empty).Split('|');
                if (scope.Length != 2 || string.IsNullOrWhiteSpace(scope[0]))
                {
                    throw new InvalidDataException("bridge_mt5_projection_scope_invalid");
                }
                ProjectionSourceSupport.CandleWindowMsc(scope[1], 1);
            }
            else if ((request.Resource != "history.orders" && request.Resource != "history.trades"
                    && request.Resource != "history.deals") || request.ScopeKey != "*")
            {
                throw new InvalidDataException("bridge_mt5_projection_resource_invalid");
            }
        }

        private static void RequireOutcome(Mt5WorkerResponse response, string expected)
        {
            if (response == null || response.IsError || response.Outcome != expected)
            {
                object code;
                throw new InvalidDataException(response != null && response.Payload != null
                    && response.Payload.TryGetValue("error_code", out code)
                    ? Convert.ToString(code, CultureInfo.InvariantCulture)
                    : "bridge_mt5_projection_failed");
            }
        }

        private static string ReadText(IDictionary<string, object> root, string field)
        {
            object value;
            string text;
            if (!root.TryGetValue(field, out value) || (text = value as string) == null)
            {
                throw new InvalidDataException("bridge_mt5_projection_text_invalid");
            }
            return text;
        }

        private static string Identifier(IDictionary<string, object> root, string field)
        {
            object value;
            string text;
            ulong parsed;
            if (!root.TryGetValue(field, out value)
                || string.IsNullOrEmpty(text = Convert.ToString(value, CultureInfo.InvariantCulture))
                || !ulong.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out parsed))
            {
                throw new InvalidDataException("bridge_mt5_projection_cursor_invalid");
            }
            return text;
        }

        private static int CompareNumeric(string left, string right)
        {
            left = (left ?? "0").TrimStart('0');
            right = (right ?? "0").TrimStart('0');
            if (left.Length != right.Length)
            {
                return left.Length.CompareTo(right.Length);
            }
            return string.Compare(left, right, StringComparison.Ordinal);
        }

        private static string HistoryKind(string resource)
        {
            return resource.Substring("history.".Length);
        }
    }
}
