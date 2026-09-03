using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.Runtime
{
    public interface ITerminalQuerySource
    {
        TerminalQueryResult Query(ProfileRuntime runtime, BridgeQueryRequest request, long nowUtcMsc);
    }

    public sealed class TerminalPipeQuerySource : ITerminalQuerySource
    {
        private readonly TerminalSessionHost host;

        public TerminalPipeQuerySource(TerminalSessionHost hostValue)
        {
            if (hostValue == null)
            {
                throw new ArgumentNullException("hostValue");
            }
            host = hostValue;
        }

        public TerminalQueryResult Query(ProfileRuntime runtime, BridgeQueryRequest request, long nowUtcMsc)
        {
            if (runtime == null || request == null || nowUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_terminal_query_source_invalid");
            }
            ProfileRuntimeConfiguration route = runtime.Configuration;
            TerminalSessionSnapshot session = FindSession(route);
            Dictionary<string, object> root = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "v", 1 },
                { "type", "query_request" },
                { "request_id", request.RequestId },
                { "terminal_instance_id", route.TerminalInstanceId },
                { "account_ref", new Dictionary<string, object>(StringComparer.Ordinal)
                    {
                        { "broker_server", route.BrokerServer },
                        { "login", route.Login }
                    }
                },
                { "session_epoch", session.SessionEpoch },
                { "deadline_utc_msc", request.DeadlineUtcMsc },
                { "resource", request.Resource },
                { "params", request.Parameters }
            };
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            return host.Query(TerminalRequest.Parse(serializer.Serialize(root)));
        }

        private TerminalSessionSnapshot FindSession(ProfileRuntimeConfiguration route)
        {
            IList<TerminalSessionSnapshot> sessions = host.Snapshot();
            for (int index = 0; index < sessions.Count; index++)
            {
                TerminalSessionSnapshot session = sessions[index];
                if (session.TerminalInstanceId == route.TerminalInstanceId
                    && string.Equals(session.Platform, route.Platform, StringComparison.OrdinalIgnoreCase)
                    && session.BrokerServer == route.BrokerServer
                    && session.Login == route.Login)
                {
                    return session;
                }
            }
            throw new InvalidOperationException("bridge_terminal_session_not_found");
        }
    }
}
