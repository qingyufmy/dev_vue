using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Liangjian.BridgeV4.Storage;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.Runtime
{
    public sealed class TerminalPipeProjectionSource : ITerminalProjectionSource
    {
        private readonly TerminalSessionHost host;

        public TerminalPipeProjectionSource(TerminalSessionHost value)
        {
            if (value == null)
            {
                throw new ArgumentNullException("value");
            }
            host = value;
        }

        public ProjectionSyncBatch Fetch(ProjectionSyncRequest request)
        {
            Validate(request);
            TerminalSessionSnapshot session = FindSession(request);
            return request.Resource == "market.candles"
                ? FetchCandles(request, session)
                : FetchHistory(request, session);
        }

        private ProjectionSyncBatch FetchCandles(
            ProjectionSyncRequest request, TerminalSessionSnapshot session)
        {
            string[] scope = request.ScopeKey.Split('|');
            long windowMsc = ProjectionSourceSupport.CandleWindowMsc(
                scope[1], Math.Max(1, request.Limit - 1));
            ProjectionSourceCursor cursor = ProjectionSourceSupport.ResolveWindow(request, windowMsc);
            string requestId = RequestId();
            TerminalTimeframeCode timeframe;
            if (!Enum.TryParse<TerminalTimeframeCode>(scope[1], false, out timeframe))
            {
                throw new InvalidDataException("bridge_projection_timeframe_invalid");
            }
            TerminalQueryResult result = host.Query(
                request.TerminalInstanceId,
                TerminalQueryPayload.Candles(requestId, scope[0], timeframe, 0,
                    cursor.WindowStartUtcMsc, cursor.WindowEndUtcMsc, Deadline()),
                requestId,
                TerminalResourceCode.MarketCandles);
            RequireSuccess(result, TerminalResourceCode.MarketCandles);
            string revision = ProjectionSourceSupport.SourceRevision(request);
            IDictionary<string, object> root = ProjectionSourceSupport.DeserializeObject(result.DataJson);
            bool hasMore = cursor.WindowEndUtcMsc < request.RangeEndUtcMsc;
            return new ProjectionSyncBatch
            {
                Resource = request.Resource,
                ScopeKey = request.ScopeKey,
                CoveredRangeStartUtcMsc = cursor.WindowStartUtcMsc,
                CoveredRangeEndUtcMsc = cursor.WindowEndUtcMsc,
                SourceRevision = revision,
                Candles = ProjectionSourceSupport.MapCandles(root, scope[0], scope[1],
                    cursor.WindowStartUtcMsc, cursor.WindowEndUtcMsc,
                    result.ObservedAtUtcMsc, revision, request.AllowOpenCandles),
                History = new List<HistoryItemRecord>(),
                PublishCoverage = true,
                HasMore = hasMore,
                NextCursor = hasMore ? ProjectionSourceSupport.EncodeCursor(
                    ProjectionSourceSupport.NextWindow(request, cursor.WindowEndUtcMsc, windowMsc)) : null
            };
        }

        private ProjectionSyncBatch FetchHistory(
            ProjectionSyncRequest request, TerminalSessionSnapshot session)
        {
            ProjectionSourceCursor cursor = ProjectionSourceSupport.ResolveWindow(
                request, ProjectionSourceSupport.HistoryWindowMsc);
            string requestId = RequestId();
            TerminalResourceCode resource = TerminalQueryTranslator.ResourceCode(request.Resource);
            TerminalQueryResult result = host.Query(
                request.TerminalInstanceId,
                TerminalQueryPayload.History(requestId, resource,
                    cursor.WindowStartUtcMsc, cursor.WindowEndUtcMsc,
                    request.Limit, cursor.NativeOffset, Deadline()),
                requestId,
                resource);
            RequireSuccess(result, resource);
            IDictionary<string, object> root = ProjectionSourceSupport.DeserializeObject(result.DataJson);
            string revision = ProjectionSourceSupport.SourceRevision(request);
            bool publishCoverage = !result.HasMore;
            bool hasMore = result.HasMore || cursor.WindowEndUtcMsc < request.RangeEndUtcMsc;
            string nextCursor = null;
            if (result.HasMore)
            {
                long offset;
                if (!long.TryParse(result.NextCursor, NumberStyles.None,
                    CultureInfo.InvariantCulture, out offset) || offset <= cursor.NativeOffset)
                {
                    throw new InvalidDataException("bridge_projection_terminal_cursor_invalid");
                }
                cursor.NativeOffset = offset;
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
                    ProjectionSourceSupport.ReadArray(root, "items"), HistoryKind(request.Resource),
                    cursor.WindowStartUtcMsc, cursor.WindowEndUtcMsc,
                    result.ObservedAtUtcMsc, revision),
                PublishCoverage = publishCoverage,
                HasMore = hasMore,
                NextCursor = nextCursor
            };
        }

        private TerminalSessionSnapshot FindSession(ProjectionSyncRequest request)
        {
            IList<TerminalSessionSnapshot> sessions = host.Snapshot();
            foreach (TerminalSessionSnapshot session in sessions)
            {
                if (session.TerminalInstanceId == request.TerminalInstanceId
                    && string.Equals(session.Platform, request.Platform, StringComparison.OrdinalIgnoreCase)
                    && session.BrokerServer == request.BrokerServer
                    && session.Login == request.Login)
                {
                    return session;
                }
            }
            throw new InvalidOperationException("bridge_terminal_session_not_found");
        }

        private static void Validate(ProjectionSyncRequest request)
        {
            if (request == null || !string.Equals(request.Platform, "mt4", StringComparison.OrdinalIgnoreCase)
                || request.ConnectionEpoch < 1 || request.RangeStartUtcMsc < 1
                || request.RangeEndUtcMsc <= request.RangeStartUtcMsc
                || request.Limit < 1 || request.Limit > ProfileDataStore.MaxBatchSize)
            {
                throw new InvalidDataException("bridge_mt4_projection_request_invalid");
            }
            if (request.Resource == "market.candles")
            {
                string[] scope = (request.ScopeKey ?? string.Empty).Split('|');
                if (scope.Length != 2 || string.IsNullOrWhiteSpace(scope[0]))
                {
                    throw new InvalidDataException("bridge_mt4_projection_scope_invalid");
                }
                ProjectionSourceSupport.CandleWindowMsc(scope[1], 1);
            }
            else if ((request.Resource != "history.orders" && request.Resource != "history.trades"
                    && request.Resource != "history.deals") || request.ScopeKey != "*")
            {
                throw new InvalidDataException("bridge_mt4_projection_resource_invalid");
            }
        }

        private static void RequireSuccess(TerminalQueryResult result, TerminalResourceCode resource)
        {
            if (result == null || !result.Succeeded || result.Resource != resource)
            {
                throw new InvalidDataException(result == null || string.IsNullOrEmpty(result.ErrorCode)
                    ? "bridge_terminal_projection_failed" : result.ErrorCode);
            }
        }

        private static string HistoryKind(string resource)
        {
            return resource.Substring("history.".Length);
        }

        private static string RequestId()
        {
            return "projection-" + Guid.NewGuid().ToString("N");
        }

        private static long Deadline()
        {
            return checked((DateTime.UtcNow.Ticks - 621355968000000000L)
                / TimeSpan.TicksPerMillisecond + 30000L);
        }
    }
}
