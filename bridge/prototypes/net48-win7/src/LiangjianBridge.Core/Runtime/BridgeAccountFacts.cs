using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.Runtime
{
    public static class BridgeAccountFacts
    {
        public static IDictionary<string, object> Read(ProfileRuntime runtime, ITerminalQuerySource source, long nowUtcMsc)
        {
            if (runtime == null || source == null || nowUtcMsc < 1)
                throw new ArgumentException("bridge_account_facts_configuration_invalid");
            ProfileRuntimeConfiguration route = runtime.Configuration;
            string requestId = "account-facts-" + Guid.NewGuid().ToString("N");
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            string json = serializer.Serialize(new Dictionary<string, object>
            {
                { "v", 4 }, { "message_id", requestId }, { "type", "query.request" },
                { "sent_at_utc_msc", nowUtcMsc }, { "correlation_id", null },
                { "route", new Dictionary<string, object>
                    {
                        { "terminal_instance_id", route.TerminalInstanceId },
                        { "account_ref", new Dictionary<string, object>
                            { { "broker_server", route.BrokerServer }, { "login", route.Login } } },
                        { "connection_epoch", runtime.ConnectionEpoch }
                    } },
                { "payload", new Dictionary<string, object>
                    {
                        { "request_id", requestId }, { "resource", "account.snapshot" },
                        { "params", new Dictionary<string, object>() },
                        { "deadline_utc_msc", checked(nowUtcMsc + 15000) }
                    } }
            });
            TerminalQueryResult result = source.Query(runtime, BridgeQueryRequest.Parse(BridgeEnvelope.Parse(json)), nowUtcMsc);
            if (result == null || !result.Succeeded || result.RequestId != requestId
                || result.Resource != TerminalQueryTranslator.ResourceCode("account.snapshot")
                || result.HasMore || !string.IsNullOrEmpty(result.NextCursor)
                || result.ObservedAtUtcMsc < nowUtcMsc - 60000 || result.ObservedAtUtcMsc > nowUtcMsc + 15000)
                throw new InvalidDataException("bridge_account_facts_unavailable");
            IDictionary<string, object> data = serializer.DeserializeObject(result.DataJson) as IDictionary<string, object>;
            if (data == null) throw new InvalidDataException("bridge_account_facts_invalid");
            object rawLogin;
            if (!data.TryGetValue("login", out rawLogin)) throw new InvalidDataException("bridge_account_facts_invalid");
            string login = rawLogin as string;
            if (rawLogin is int || rawLogin is long) login = Convert.ToString(rawLogin, CultureInfo.InvariantCulture);
            string server = Text(data, route.Platform == "mt5" ? "server" : "broker_server");
            if (login != route.Login || server != route.BrokerServer)
                throw new InvalidDataException("bridge_account_facts_route_mismatch");
            string currency = Text(data, "currency");
            if (!Regex.IsMatch(currency, "\\A[A-Za-z0-9][A-Za-z0-9._-]{0,11}\\z"))
                throw new InvalidDataException("bridge_account_facts_currency_invalid");
            object connected;
            if (!data.TryGetValue(route.Platform == "mt5" ? "terminal_connected" : "connected", out connected)
                || !(connected is bool) || !(bool)connected)
                throw new InvalidDataException("bridge_account_facts_terminal_offline");
            return new Dictionary<string, object>
            {
                { "currency", currency }, { "login", login }, { "broker_server", server },
                { "observed_at_utc_msc", result.ObservedAtUtcMsc }
            };
        }

        private static string Text(IDictionary<string, object> data, string key)
        {
            object value;
            if (!data.TryGetValue(key, out value) || !(value is string) || string.IsNullOrWhiteSpace((string)value))
                throw new InvalidDataException("bridge_account_facts_invalid");
            return (string)value;
        }
    }
}
