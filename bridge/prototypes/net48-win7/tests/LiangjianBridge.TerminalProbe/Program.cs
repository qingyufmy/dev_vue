using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.TerminalProbe
{
    internal static class Program
    {
        private const string DefaultPipeName = "LiangjianBridgeV4";

        private static int Main(string[] arguments)
        {
            if (arguments.Length > 0 && string.Equals(arguments[0], "--python", StringComparison.Ordinal))
            {
                return RunPythonWorker(arguments);
            }

            bool execute = Contains(arguments, "--execute");
            bool matrix = Contains(arguments, "--matrix");
            if (execute != matrix)
            {
                Console.Error.WriteLine("FAIL terminal_probe --execute and --matrix must be supplied together");
                return 2;
            }
            List<string> positional = new List<string>();
            foreach (string argument in arguments)
            {
                if (argument == "--execute" || argument == "--matrix") continue;
                if (argument.StartsWith("--", StringComparison.Ordinal))
                {
                    Console.Error.WriteLine("FAIL terminal_probe unknown option " + argument);
                    return 2;
                }
                positional.Add(argument);
            }
            string pipeName = positional.Count > 0 ? positional[0] : DefaultPipeName;
            string symbol = positional.Count > 1 ? positional[1] : "XAUUSD";
            try
            {
                Console.WriteLine("WAIT terminal pipe=" + pipeName);
                using (TerminalPipeServer server = new TerminalPipeServer(pipeName))
                using (TerminalReadOnlySession session = TerminalReadOnlySession.Accept(server, 60000))
                {
                    Console.WriteLine(
                        "CONNECTED platform=" + session.Hello.Platform
                        + " build=" + session.Hello.TerminalBuild
                        + " server=" + session.Hello.BrokerServer
                        + " login=" + session.Hello.Login
                        + " instance=" + session.TerminalInstanceId);

                    Query(session, TerminalResourceCode.TerminalInfo, TerminalQueryPayload.NoParameters);
                    Query(session, TerminalResourceCode.TerminalClock, TerminalQueryPayload.NoParameters);
                    Query(session, TerminalResourceCode.AccountSnapshot, TerminalQueryPayload.NoParameters);
                    Query(session, TerminalResourceCode.MarketSymbols, delegate(string id, TerminalResourceCode resource, long deadline)
                    {
                        return TerminalQueryPayload.Symbols(id, 100, 0, deadline);
                    });
                    TerminalQueryResult instrument = Query(session, TerminalResourceCode.MarketInstrument, delegate(string id, TerminalResourceCode resource, long deadline)
                    {
                        return TerminalQueryPayload.Symbol(id, resource, symbol, deadline);
                    });
                    TerminalQueryResult quote = Query(session, TerminalResourceCode.MarketQuote, delegate(string id, TerminalResourceCode resource, long deadline)
                    {
                        return TerminalQueryPayload.Quote(id, new List<string> { symbol }, deadline);
                    });
                    Query(session, TerminalResourceCode.MarketCandles, delegate(string id, TerminalResourceCode resource, long deadline)
                    {
                        return TerminalQueryPayload.Candles(id, symbol, TerminalTimeframeCode.M5, 120, 0, 0, deadline);
                    });
                    Query(session, TerminalResourceCode.TradingPositions, delegate(string id, TerminalResourceCode resource, long deadline)
                    {
                        return TerminalQueryPayload.TradingCollection(id, resource, 100, 0, string.Empty, deadline);
                    });
                    Query(session, TerminalResourceCode.TradingPendingOrders, delegate(string id, TerminalResourceCode resource, long deadline)
                    {
                        return TerminalQueryPayload.TradingCollection(id, resource, 100, 0, string.Empty, deadline);
                    });

                    long endUtcMsc = UtcNowMsc();
                    long startUtcMsc = endUtcMsc - (7L * 24L * 60L * 60L * 1000L);
                    foreach (TerminalResourceCode historyResource in new[]
                    {
                        TerminalResourceCode.HistoryOrders,
                        TerminalResourceCode.HistoryTrades,
                        TerminalResourceCode.HistoryDeals
                    })
                    {
                        TerminalResourceCode captured = historyResource;
                        Query(session, historyResource, delegate(string id, TerminalResourceCode resource, long deadline)
                        {
                            return TerminalQueryPayload.History(id, captured, startUtcMsc, endUtcMsc, 50, 0, deadline);
                        });
                    }
                    Query(session, TerminalResourceCode.DiagnosticsHealth, TerminalQueryPayload.NoParameters);
                    if (execute)
                    {
                        RunTradeMatrix(session, symbol, instrument.DataJson, quote.DataJson);
                    }
                }
                Console.WriteLine(execute ? "PASS terminal_trade_matrix" : "PASS terminal_read_only_probe");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("FAIL terminal_read_only_probe " + error.Message);
                return 1;
            }
        }

        private static bool Contains(string[] values, string expected)
        {
            foreach (string value in values)
            {
                if (string.Equals(value, expected, StringComparison.Ordinal)) return true;
            }
            return false;
        }

        private static int RunPythonWorker(string[] arguments)
        {
            try
            {
                PythonProbeArguments options = PythonProbeArguments.Parse(arguments);
                Console.WriteLine("WAIT mt5_python_worker");
                Mt5WorkerConfiguration configuration = new Mt5WorkerConfiguration(
                    options.PythonExecutablePath,
                    options.WorkerScriptPath,
                    options.TerminalPath,
                    options.TerminalInstanceId,
                    options.BrokerServer,
                    options.Login,
                    0,
                    "live",
                    null);

                using (Mt5WorkerHost host = new Mt5WorkerHost())
                {
                    Mt5WorkerSession session = host.Connect(configuration);
                    try
                    {
                        Console.WriteLine("CONNECTED mt5_python_worker instance=" + session.TerminalInstanceId);
                        WorkerRequest(session, "collect_snapshot", new Dictionary<string, object>
                        {
                            { "streams", new object[] { "account", "positions", "orders" } }
                        }, "snapshot");
                        WorkerRequest(session, "quote", new Dictionary<string, object>
                        {
                            { "symbol", options.Symbol }
                        }, "quote");
                        WorkerRequest(session, "data", new Dictionary<string, object>
                        {
                            { "action", "rates" },
                            { "params", new Dictionary<string, object>
                                {
                                    { "symbol", options.Symbol },
                                    { "timeframe", "M5" },
                                    { "count", 100 }
                                }
                            }
                        }, "data");
                        WorkerRequest(session, "data", new Dictionary<string, object>
                        {
                            { "action", "symbols" },
                            { "params", new Dictionary<string, object>() }
                        }, "data");
                    }
                    finally
                    {
                        // Remove the live session from the host registry as well as
                        // stopping its owned worker before opening the archive role.
                        host.Disconnect(configuration.TerminalInstanceId);
                    }

                    // The live role intentionally does not expose history_sync.  Open a
                    // separate archive worker with a new epoch for bounded history reads.
                    Mt5WorkerConfiguration archive = new Mt5WorkerConfiguration(
                        options.PythonExecutablePath,
                        options.WorkerScriptPath,
                        options.TerminalPath,
                        options.TerminalInstanceId,
                        options.BrokerServer,
                        options.Login,
                        0,
                        "archive",
                        null);
                    Mt5WorkerSession archiveSession = host.Connect(archive);
                    try
                    {
                        long endUtcMsc = UtcNowMsc();
                        long startUtcMsc = endUtcMsc - (7L * 24L * 60L * 60L * 1000L);
                        WorkerRequest(archiveSession, "history_range_sync", new Dictionary<string, object>
                        {
                            { "range_start_utc_msc", startUtcMsc },
                            { "range_end_utc_msc", endUtcMsc },
                            { "cursor", new Dictionary<string, object>
                                {
                                    { "time_msc", startUtcMsc },
                                    { "ticket", "0" }
                                }
                            },
                            { "limit", 250 }
                        }, "history_batch");
                    }
                    finally
                    {
                        host.Disconnect(archive.TerminalInstanceId);
                    }
                }
                Console.WriteLine("PASS mt5_python_worker_probe");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("FAIL mt5_python_worker_probe " + error.Message);
                return 1;
            }
        }

        private static void WorkerRequest(Mt5WorkerSession session, string operation,
            IDictionary<string, object> payload, string expectedOutcome)
        {
            Mt5WorkerResponse response = session.Request(operation, payload, 30000);
            if (response.IsError || response.Outcome != expectedOutcome)
            {
                IDictionary<string, object> error = response.Payload;
                object errorCode;
                string code = error != null && error.TryGetValue("error_code", out errorCode)
                    ? errorCode as string
                    : null;
                throw new InvalidOperationException(operation + " failed" +
                    (string.IsNullOrEmpty(code) ? string.Empty : ":" + code));
            }
            Console.WriteLine("PASS " + operation + " outcome=" + response.Outcome);
        }

        private sealed class PythonProbeArguments
        {
            public string PythonExecutablePath;
            public string WorkerScriptPath;
            public string TerminalPath;
            public string TerminalInstanceId;
            public string BrokerServer;
            public string Login;
            public string Symbol;

            public static PythonProbeArguments Parse(string[] arguments)
            {
                Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.Ordinal);
                for (int index = 1; index < arguments.Length; index++)
                {
                    string option = arguments[index];
                    if (string.IsNullOrEmpty(option) || !option.StartsWith("--", StringComparison.Ordinal)
                        || index + 1 >= arguments.Length)
                    {
                        throw new InvalidDataException("usage: --python --executable <python.exe> --worker <worker.py> --terminal <terminal64.exe> --instance <id> --broker <server> --login <login> [--symbol <symbol>]");
                    }
                    values[option.Substring(2)] = arguments[++index];
                }
                PythonProbeArguments result = new PythonProbeArguments
                {
                    PythonExecutablePath = Required(values, "executable"),
                    WorkerScriptPath = Required(values, "worker"),
                    TerminalPath = Required(values, "terminal"),
                    TerminalInstanceId = Required(values, "instance"),
                    BrokerServer = Required(values, "broker"),
                    Login = Required(values, "login"),
                    Symbol = values.ContainsKey("symbol") ? values["symbol"] : "XAUUSD"
                };
                return result;
            }

            private static string Required(IDictionary<string, string> values, string key)
            {
                string value;
                if (!values.TryGetValue(key, out value) || string.IsNullOrWhiteSpace(value))
                {
                    throw new InvalidDataException("usage: missing --" + key);
                }
                return value;
            }
        }

        private delegate byte[] QueryBuilder(string requestId, TerminalResourceCode resource, long deadlineUtcMsc);

        private static TerminalQueryResult Query(TerminalReadOnlySession session, TerminalResourceCode resource, QueryBuilder builder)
        {
            string requestId = "probe-" + Guid.NewGuid().ToString("N");
            long deadline = UtcNowMsc() + 10000;
            TerminalQueryResult result = session.Query(builder(requestId, resource, deadline), requestId, resource);
            if (!result.Succeeded)
            {
                throw new InvalidOperationException(resource + ":" + result.ErrorCode + ":" + result.ErrorMessage);
            }
            Console.WriteLine(
                "PASS " + resource
                + " bytes=" + result.DataJson.Length
                + " offset=" + result.ServerOffsetMinutes
                + " clock=" + result.ClockStatus
                + " has_more=" + result.HasMore);
            return result;
        }

        private static void RunTradeMatrix(TerminalReadOnlySession session, string symbol,
            string instrumentJson, string quoteJson)
        {
            if (!string.Equals(session.Hello.Platform, "mt4", StringComparison.OrdinalIgnoreCase)
                || session.Hello.BrokerServer.IndexOf("demo", StringComparison.OrdinalIgnoreCase) < 0)
            {
                throw new InvalidOperationException("trade_matrix_requires_mt4_demo_account");
            }

            IDictionary<string, object> instrument = JsonObject(instrumentJson);
            IDictionary<string, object> quote = FirstItem(JsonObject(quoteJson));
            decimal volume = DecimalValue(instrument, "volume_min");
            int digits = IntValue(instrument, "digits");
            decimal bid = DecimalValue(quote, "bid");
            if (volume <= 0 || bid <= 0 || digits < 0 || digits > 10)
            {
                throw new InvalidOperationException("trade_matrix_market_data_invalid");
            }

            int magic = 870000000 + (int)(UtcNowMsc() % 100000000);
            TerminalCommandResult position = null;
            TerminalCommandResult pending = null;
            string marketKey = "matrix-market-" + Guid.NewGuid().ToString("N");
            string pendingKey = "matrix-pending-" + Guid.NewGuid().ToString("N");
            try
            {
                position = Command(session, "order.place", marketKey,
                    ObjectOf("symbol", symbol, "direction", "buy", "order_type", "market",
                        "volume", DecimalText(volume), "magic", magic, "deviation", 100), null);
                RequireSucceeded(position, "market_place");

                decimal open = Decimal.Parse(position.ActualPrice, CultureInfo.InvariantCulture);
                decimal stopLoss = Round(open * 0.98m, digits);
                decimal takeProfit = Round(open * 1.02m, digits);
                position = Command(session, "position.protection.set", UniqueKey("protect"),
                    ObjectOf("ticket", position.Ticket.ToString(CultureInfo.InvariantCulture),
                        "stop_loss", DecimalText(stopLoss), "take_profit", DecimalText(takeProfit)),
                    Expected(position));
                RequireSucceeded(position, "position_protection_set");

                RequireSucceeded(Command(session, "execution.lookup", UniqueKey("lookup-ticket"),
                    ObjectOf("ticket", position.Ticket.ToString(CultureInfo.InvariantCulture)), null),
                    "position_lookup_ticket");
                RequireSucceeded(Command(session, "execution.lookup", UniqueKey("lookup-key"),
                    ObjectOf("idempotency_key", marketKey, "symbol", symbol, "magic", magic), null),
                    "position_lookup_idempotency");

                TerminalCommandResult closed = Command(session, "position.close", UniqueKey("close"),
                    ObjectOf("ticket", position.Ticket.ToString(CultureInfo.InvariantCulture), "deviation", 100),
                    Expected(position));
                RequireSucceeded(closed, "position_close");
                position = null;

                decimal pendingPrice = Round(bid * 0.90m, digits);
                pending = Command(session, "order.place", pendingKey,
                    ObjectOf("symbol", symbol, "direction", "buy", "order_type", "buy_limit",
                        "volume", DecimalText(volume), "price", DecimalText(pendingPrice),
                        "magic", magic, "deviation", 100), null);
                RequireSucceeded(pending, "pending_place");

                decimal changedPrice = Round(bid * 0.89m, digits);
                decimal pendingSl = Round(changedPrice * 0.98m, digits);
                decimal pendingTp = Round(changedPrice * 1.02m, digits);
                long expiration = UtcNowMsc() + (2L * 60L * 60L * 1000L);
                pending = Command(session, "pending_order.modify", UniqueKey("pending-modify"),
                    ObjectOf("ticket", pending.Ticket.ToString(CultureInfo.InvariantCulture),
                        "price", DecimalText(changedPrice), "stop_loss", DecimalText(pendingSl),
                        "take_profit", DecimalText(pendingTp), "expiration_utc_msc", expiration),
                    Expected(pending));
                RequireSucceeded(pending, "pending_modify");

                RequireSucceeded(Command(session, "execution.lookup", UniqueKey("pending-lookup"),
                    ObjectOf("idempotency_key", pendingKey, "symbol", symbol, "magic", magic), null),
                    "pending_lookup_idempotency");
                TerminalCommandResult cancelled = Command(session, "pending_order.cancel", UniqueKey("cancel"),
                    ObjectOf("ticket", pending.Ticket.ToString(CultureInfo.InvariantCulture)), Expected(pending));
                RequireSucceeded(cancelled, "pending_cancel");
                pending = null;
            }
            finally
            {
                Cleanup(session, position, pending, magic);
            }
        }

        private static TerminalCommandResult Command(TerminalReadOnlySession session, string action,
            string idempotencyKey, IDictionary<string, object> parameters,
            IDictionary<string, object> expected)
        {
            string requestId = "probe-" + Guid.NewGuid().ToString("N");
            string commandId = "command-" + Guid.NewGuid().ToString("N");
            long issued = UtcNowMsc();
            IDictionary<string, object> root = ObjectOf(
                "v", 1,
                "type", "command_request",
                "request_id", requestId,
                "terminal_instance_id", session.TerminalInstanceId,
                "account_ref", ObjectOf("broker_server", session.Hello.BrokerServer, "login", session.Hello.Login),
                "session_epoch", session.SessionEpoch,
                "issued_at_utc_msc", issued,
                "deadline_utc_msc", issued + 15000,
                "action", action,
                "command_id", commandId,
                "idempotency_key", idempotencyKey,
                "params", parameters,
                "expected_state", expected);
            TerminalRequest request = TerminalRequest.Parse(new JavaScriptSerializer().Serialize(root));
            TerminalTranslatedCommand translated = TerminalCommandTranslator.Translate(request, session);
            TerminalCommandResult result = session.ExecuteCommand(translated.Payload, requestId, commandId,
                translated.Action);
            Console.WriteLine("COMMAND " + action + " status=" + result.Status
                + " ticket=" + result.Ticket + " state=" + result.ResourceState
                + (string.IsNullOrEmpty(result.ErrorCode) ? string.Empty : " error=" + result.ErrorCode));
            return result;
        }

        private static void RequireSucceeded(TerminalCommandResult result, string step)
        {
            if (result == null || !result.Succeeded)
            {
                throw new InvalidOperationException(step + " failed:"
                    + (result == null ? "no_result" : result.ErrorCode + ":" + result.ErrorMessage));
            }
            Console.WriteLine("PASS " + step);
        }

        private static IDictionary<string, object> Expected(TerminalCommandResult result)
        {
            if (result == null || result.Ticket <= 0 || string.IsNullOrEmpty(result.ActualSymbol)
                || string.IsNullOrEmpty(result.ActualVolume) || string.IsNullOrEmpty(result.ActualPrice))
            {
                throw new InvalidOperationException("trade_matrix_expected_state_unavailable");
            }
            return ObjectOf(
                "ticket", result.Ticket.ToString(CultureInfo.InvariantCulture),
                "symbol", result.ActualSymbol,
                "direction", DirectionText(result.ActualDirection),
                "order_type", OrderTypeText(result.ActualOrderType),
                "magic", result.ActualMagic,
                "volume", result.ActualVolume,
                "open_price", result.ActualPrice,
                "stop_limit_price", null,
                "stop_loss", result.ActualStopLossSpecified ? (object)result.ActualStopLoss : null,
                "take_profit", result.ActualTakeProfitSpecified ? (object)result.ActualTakeProfit : null,
                "expiration_utc_msc", result.ActualExpirationSpecified ? (object)result.ActualExpirationUtcMsc : null);
        }

        private static void Cleanup(TerminalReadOnlySession session, TerminalCommandResult position,
            TerminalCommandResult pending, int magic)
        {
            if (pending != null && pending.Ticket > 0 && pending.ActualMagic == magic)
            {
                try
                {
                    TerminalCommandResult current = Command(session, "execution.lookup", UniqueKey("cleanup-lookup"),
                        ObjectOf("ticket", pending.Ticket.ToString(CultureInfo.InvariantCulture)), null);
                    if (current.Succeeded && current.ResourceState == TerminalCommandResourceStateCode.Pending
                        && current.ActualMagic == magic)
                    {
                        Command(session, "pending_order.cancel", UniqueKey("cleanup-cancel"),
                            ObjectOf("ticket", current.Ticket.ToString(CultureInfo.InvariantCulture)), Expected(current));
                    }
                }
                catch (Exception error) { Console.Error.WriteLine("WARN pending cleanup " + error.Message); }
            }
            if (position != null && position.Ticket > 0 && position.ActualMagic == magic)
            {
                try
                {
                    TerminalCommandResult current = Command(session, "execution.lookup", UniqueKey("cleanup-lookup"),
                        ObjectOf("ticket", position.Ticket.ToString(CultureInfo.InvariantCulture)), null);
                    if (current.Succeeded && current.ResourceState == TerminalCommandResourceStateCode.Position
                        && current.ActualMagic == magic)
                    {
                        Command(session, "position.close", UniqueKey("cleanup-close"),
                            ObjectOf("ticket", current.Ticket.ToString(CultureInfo.InvariantCulture), "deviation", 100),
                            Expected(current));
                    }
                }
                catch (Exception error) { Console.Error.WriteLine("WARN position cleanup " + error.Message); }
            }
        }

        private static IDictionary<string, object> JsonObject(string json)
        {
            IDictionary<string, object> result = new JavaScriptSerializer().DeserializeObject(json)
                as IDictionary<string, object>;
            if (result == null) throw new InvalidOperationException("trade_matrix_json_invalid");
            return result;
        }

        private static IDictionary<string, object> FirstItem(IDictionary<string, object> value)
        {
            object raw;
            object[] items;
            if (!value.TryGetValue("items", out raw) || (items = raw as object[]) == null
                || items.Length == 0 || !(items[0] is IDictionary<string, object>))
            {
                throw new InvalidOperationException("trade_matrix_quote_invalid");
            }
            return (IDictionary<string, object>)items[0];
        }

        private static decimal DecimalValue(IDictionary<string, object> value, string key)
        {
            object raw;
            if (!value.TryGetValue(key, out raw) || raw == null)
                throw new InvalidOperationException("trade_matrix_" + key + "_missing");
            return Convert.ToDecimal(raw, CultureInfo.InvariantCulture);
        }

        private static int IntValue(IDictionary<string, object> value, string key)
        {
            object raw;
            if (!value.TryGetValue(key, out raw) || raw == null)
                throw new InvalidOperationException("trade_matrix_" + key + "_missing");
            return Convert.ToInt32(raw, CultureInfo.InvariantCulture);
        }

        private static decimal Round(decimal value, int digits)
        {
            return Math.Round(value, digits, MidpointRounding.AwayFromZero);
        }

        private static string DecimalText(decimal value)
        {
            return value.ToString("0.##########", CultureInfo.InvariantCulture);
        }

        private static string UniqueKey(string prefix)
        {
            return prefix + "-" + Guid.NewGuid().ToString("N");
        }

        private static string DirectionText(TerminalCommandDirectionCode value)
        {
            if (value == TerminalCommandDirectionCode.Buy) return "buy";
            if (value == TerminalCommandDirectionCode.Sell) return "sell";
            throw new InvalidOperationException("trade_matrix_direction_invalid");
        }

        private static string OrderTypeText(TerminalCommandOrderTypeCode value)
        {
            switch (value)
            {
                case TerminalCommandOrderTypeCode.Market: return "market";
                case TerminalCommandOrderTypeCode.BuyLimit: return "buy_limit";
                case TerminalCommandOrderTypeCode.BuyStop: return "buy_stop";
                case TerminalCommandOrderTypeCode.SellLimit: return "sell_limit";
                case TerminalCommandOrderTypeCode.SellStop: return "sell_stop";
                default: throw new InvalidOperationException("trade_matrix_order_type_invalid");
            }
        }

        private static IDictionary<string, object> ObjectOf(params object[] values)
        {
            Dictionary<string, object> result = new Dictionary<string, object>(StringComparer.Ordinal);
            for (int index = 0; index < values.Length; index += 2)
            {
                result.Add((string)values[index], values[index + 1]);
            }
            return result;
        }

        private static long UtcNowMsc()
        {
            return (DateTime.UtcNow.Ticks - 621355968000000000L) / TimeSpan.TicksPerMillisecond;
        }
    }
}
