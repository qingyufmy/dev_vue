using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Storage;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.Runtime
{
    public sealed class Mt4TerminalCommandSource : ITerminalCommandSource
    {
        private readonly TerminalSessionHost host;

        public Mt4TerminalCommandSource(TerminalSessionHost value)
        {
            if (value == null) throw new ArgumentNullException("value");
            host = value;
        }

        public TerminalCommandExecutionResult Execute(ProfileRuntime runtime,
            BridgeCommandRequest request, long nowUtcMsc)
        {
            TerminalSessionSnapshot session;
            TerminalCommandSpec spec;
            try
            {
                session = FindSession(runtime.Configuration);
                spec = TerminalCommandTranslator.TranslateSpec(
                    TerminalCommandSourceSupport.BuildTerminalRequest(runtime, request, session.SessionEpoch));
            }
            catch (InvalidDataException error)
            {
                return TerminalCommandExecutionResult.Rejected(SafeCode(error.Message, "bridge_mt4_command_invalid"));
            }
            catch (InvalidOperationException error)
            {
                return TerminalCommandExecutionResult.Failed(SafeCode(error.Message, "bridge_mt4_terminal_unavailable"));
            }
            try
            {
                TerminalCommandResult result = host.ExecuteCommand(runtime.Configuration.TerminalInstanceId,
                    TerminalCommandPayload.Create(spec), request.CommandId, request.CommandId, spec.Action);
                return TerminalCommandSourceSupport.FromMt4(result);
            }
            catch (Exception error)
            {
                return TerminalCommandExecutionResult.Uncertain(
                    SafeCode(error.Message, "bridge_mt4_execution_interrupted"), null);
            }
        }

        public TerminalCommandExecutionResult Reconcile(ProfileRuntime runtime,
            BridgeCommandReconcile request, CommandLedgerRecord original, long nowUtcMsc)
        {
            long ticket;
            if (string.IsNullOrEmpty(request.TerminalTicket)
                || !long.TryParse(request.TerminalTicket, NumberStyles.None,
                    CultureInfo.InvariantCulture, out ticket) || ticket <= 0)
                return TerminalCommandExecutionResult.Uncertain("bridge_reconcile_ticket_required", null);
            TerminalSessionSnapshot session;
            try { session = FindSession(runtime.Configuration); }
            catch (Exception error)
            {
                return TerminalCommandExecutionResult.Uncertain(
                    SafeCode(error.Message, "bridge_mt4_terminal_unavailable"), null);
            }
            TerminalCommandSpec lookup = new TerminalCommandSpec(original.CommandId, original.CommandId,
                original.IdempotencyKey, TerminalCommandActionCode.ExecutionLookup, nowUtcMsc,
                checked(nowUtcMsc + 30000L), runtime.Configuration.TerminalInstanceId,
                runtime.Configuration.BrokerServer, runtime.Configuration.Login, session.SessionEpoch,
                ticket, string.Empty, TerminalCommandDirectionCode.None, TerminalCommandOrderTypeCode.None,
                0, string.Empty, false, string.Empty, false, string.Empty, false, string.Empty,
                false, 0, 0, string.Empty, string.Empty, null);
            try
            {
                TerminalCommandResult terminal = host.ExecuteCommand(runtime.Configuration.TerminalInstanceId,
                    TerminalCommandPayload.Create(lookup), original.CommandId, original.CommandId,
                    TerminalCommandActionCode.ExecutionLookup);
                TerminalCommandExecutionResult evidence = TerminalCommandSourceSupport.FromMt4(terminal);
                string resolved = Resolve(original.Action, terminal.ResourceState);
                return resolved == null
                    ? TerminalCommandExecutionResult.Uncertain("bridge_reconciliation_inconclusive", evidence.Result)
                    : TerminalCommandExecutionResult.Create(resolved, evidence.Result,
                        resolved == "failed" ? "bridge_reconciliation_proved_not_applied" : null,
                        evidence.TerminalCode);
            }
            catch (Exception error)
            {
                return TerminalCommandExecutionResult.Uncertain(
                    SafeCode(error.Message, "bridge_mt4_reconciliation_interrupted"), null);
            }
        }

        private TerminalSessionSnapshot FindSession(ProfileRuntimeConfiguration route)
        {
            foreach (TerminalSessionSnapshot session in host.Snapshot())
            {
                if (session.TerminalInstanceId == route.TerminalInstanceId
                    && session.Platform.Equals("mt4", StringComparison.OrdinalIgnoreCase)
                    && session.BrokerServer == route.BrokerServer && session.Login == route.Login)
                    return session;
            }
            throw new InvalidOperationException("bridge_terminal_session_not_found");
        }

        private static string Resolve(string action, TerminalCommandResourceStateCode state)
        {
            if (action == "order.place")
                return state == TerminalCommandResourceStateCode.Position
                    || state == TerminalCommandResourceStateCode.Pending
                    || state == TerminalCommandResourceStateCode.Filled ? "succeeded" : null;
            if (action == "position.close")
                return state == TerminalCommandResourceStateCode.Closed ? "succeeded" :
                    state == TerminalCommandResourceStateCode.Position ? "failed" : null;
            if (action == "pending_order.cancel")
                return state == TerminalCommandResourceStateCode.Closed
                    || state == TerminalCommandResourceStateCode.Absent ? "succeeded" :
                    state == TerminalCommandResourceStateCode.Pending
                    || state == TerminalCommandResourceStateCode.Filled ? "failed" : null;
            return null;
        }

        private static string SafeCode(string value, string fallback)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 128) return fallback;
            for (int index = 0; index < value.Length; index++)
            {
                char item = value[index];
                if (!((item >= 'a' && item <= 'z') || (item >= '0' && item <= '9') || item == '_'))
                    return fallback;
            }
            return value;
        }
    }
}
