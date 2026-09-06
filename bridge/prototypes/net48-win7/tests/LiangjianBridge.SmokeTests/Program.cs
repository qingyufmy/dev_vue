using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Data.SQLite;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4;
using Liangjian.BridgeV4.LauncherApp;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Storage;
using Liangjian.BridgeV4.Terminal;
using Liangjian.BridgeV4.Transport;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class Program
    {
        private static int failures;

        private static int Main(string[] arguments)
        {
            if (arguments != null && arguments.Length == 4 && arguments[0].EndsWith(".probe-fixture", StringComparison.Ordinal)
                && arguments[1] == "--probe" && arguments[2] == "--terminal" && File.Exists(arguments[0]))
                return TerminalDiscoverySmokeTests.RunFixture(arguments[0], arguments[3]);
            if (arguments != null && arguments.Length == 1 && File.Exists(arguments[0]))
            {
                string[] fakeLines = File.ReadAllLines(arguments[0]);
                if (fakeLines.Length > 0 && (fakeLines[0] == "never-connect" || fakeLines[0] == "hello-and-exit"))
                {
                    return RunFakeWorker(arguments[0], fakeLines);
                }
            }

            Run("runtime_release_threshold", TestRuntimeThreshold);
            Run("envelope_accepts_v4", TestEnvelopeAcceptsV4);
            Run("envelope_rejects_unknown_field", TestEnvelopeRejectsUnknownField);
            Run("protocol_catalog_is_narrow", TestProtocolCatalog);
            Run("websocket_rfc_accept", TestWebSocketAccept);
            Run("websocket_client_frame_is_masked", TestClientFrameMasking);
            Run("websocket_server_frame_reads", TestServerFrame);
            Run("pipe_frame_round_trip", TestPipeFrameRoundTrip);
            Run("mt5_worker_json_frame_is_little_endian", TestMt5WorkerJsonFrame);
            Run("mt5_worker_connect_timeout_is_bounded", TestMt5WorkerConnectTimeout);
            Run("mt5_worker_idle_exit_is_removed", TestMt5WorkerIdleExit);
            Run("mt5_worker_immediate_exit_does_not_leak", TestMt5WorkerImmediateExit);
            Run("named_pipe_round_trip", TestNamedPipeRoundTrip);
            Run("mt4_mt5_share_narrow_pipe_contract", TestTerminalContract);
            Run("terminal_binary_wire_is_strict", TestTerminalBinaryWire);
            Run("terminal_read_only_session_correlates", TestTerminalReadOnlySession);
            Run("terminal_host_accepts_multiple_instances", TestTerminalHostMultipleInstances);
            Run("sqlite_ledger_idempotency", TestSqliteLedgerIdempotency);
            Run("sqlite_profile_data_store", TestSqliteProfileDataStore);
            Run("sqlite_profile_data_migration_upgrade", TestSqliteMigrationUpgrade);
            Run("sqlite_profile_data_v2", TestSqliteProfileDataV2);
            Run("sqlite_profile_data_cleanup_v2", TestSqliteProfileDataCleanupV2);
            Run("sqlite_profile_data_cleanup", TestSqliteProfileDataCleanup);
            Run("sqlite_ledger_data_store_write_gate", TestSqliteLedgerDataStoreWriteGate);
            Run("runtime_profile_registry_isolated", RuntimeSmokeTests.TestProfileRegistryIsolation);
            Run("profile_current_user_secret_and_atomic_catalog", ProfileConfigurationSmokeTests.TestCurrentUserSecretsAndAtomicCatalog);
            Run("profile_catalog_rejects_corruption_and_duplicates", ProfileConfigurationSmokeTests.TestCatalogRejectsCorruptionAndDuplicates);
            Run("profile_epoch_survives_restart", ProfileConfigurationSmokeTests.TestPersistedEpochSurvivesRestart);
            Run("mt5_query_source_maps_quote_and_account", Mt5QuerySourceSmokeTests.TestQuoteAndAccountMapping);
            Run("runtime_projection_gap_hit_and_snapshot", RuntimeSmokeTests.TestProjectionGapHitAndSnapshot);
            Run("runtime_projection_fetch_does_not_block_commands", RuntimeSmokeTests.TestProjectionFetchDoesNotBlockCommands);
            Run("runtime_outbox_and_persisted_ack", RuntimeSmokeTests.TestOutboxAndPersistedAck);
            Run("projection_source_cursor_and_window", ProjectionSourceSmokeTests.TestCursorAndWindowAreBounded);
            Run("projection_source_closed_candles", ProjectionSourceSmokeTests.TestClosedCandleMapping);
            Run("projection_source_history_identity_and_funds", ProjectionSourceSmokeTests.TestHistoryIdentityAndFundsMapping);
            Run("query_contract_is_strict", SessionSmokeTests.TestQueryContractIsStrict);
            Run("profile_session_routes_terminal_query", SessionSmokeTests.TestDirectTerminalQuery);
            Run("profile_session_projection_cursor", SessionSmokeTests.TestProjectionCursorFlow);
            Run("profile_connection_pumps_one_message", SessionSmokeTests.TestConnectionPump);
            Run("command_contract_and_canonical_hash", CommandSessionContractSmokeTests.TestCommandContractAndCanonicalHash);
            Run("command_ack_and_reconcile_are_strict", CommandSessionContractSmokeTests.TestCommandAckAndReconcileAreStrict);
            Run("command_result_survives_epoch_change", CommandSessionContractSmokeTests.TestDurableOutboxSurvivesEpochChange);
            Run("command_executes_after_accepted_and_deduplicates", CommandSessionContractSmokeTests.TestCommandExecutesAfterAcceptedAndDeduplicates);
            Run("expired_and_interrupted_commands_never_execute", CommandSessionContractSmokeTests.TestExpiredAndInterruptedCommandsNeverExecute);
            Run("uncertain_result_reconciles_without_replay", CommandSessionContractSmokeTests.TestUncertainResultCanReconcileWithoutReplay);
            Run("mt5_command_mapping_and_outcomes", TerminalCommandSourceSmokeTests.TestMt5MappingAndOutcomeClassification);
            Run("mt4_missing_session_is_pre_send_failure", TerminalCommandSourceSmokeTests.TestMt4MissingSessionIsPreSendFailure);
            Run("profile_session_hello_heartbeat_and_backoff", SessionLifecycleSmokeTests.TestHelloHeartbeatAndBackoff);
            Run("profile_worker_reconnects_independently", SessionLifecycleSmokeTests.TestWorkerReconnects);
            Run("profile_worker_stop_rejects_late_connect", SessionLifecycleSmokeTests.TestWorkerStopRejectsLateConnect);
            Run("profile_worker_pause_during_connect_resumes", SessionLifecycleSmokeTests.TestWorkerPauseDuringConnectResumes);
            Run("bridge_account_facts_fresh_exact_route", BridgeAccountFactsSmokeTests.RunAll);
            Run("profile_worker_stop_retains_runtime_and_lease", SessionLifecycleSmokeTests.TestWorkerStopRetainsRuntimeAndLease);
            Run("profile_manager_retries_close_and_cleans_independently", SessionLifecycleSmokeTests.TestManagerRetriesFailedCloseAndCleansOtherProfiles);
            Run("profile_worker_pauses_and_resumes_for_update", SessionLifecycleSmokeTests.TestWorkerPauseAndResumeForUpdate);
            Run("profile_worker_reports_release_status", SessionLifecycleSmokeTests.TestWorkerReportsReleaseStatus);
            Run("update_restart_waits_for_server_time_and_idle", SessionLifecycleSmokeTests.TestUpdateRestartGate);
            Run("version_pointer_is_scoped", TestVersionPointer);
            Run("version_activation_rolls_back", TestVersionActivationRollback);
            Run("launcher_health_failure_rolls_back_and_starts_previous", TestLauncherHealthFailureRollback);
            Run("launcher_recovers_interrupted_activation", TestLauncherInterruptedActivation);
            Run("signed_update_manifest_and_package_staging", UpdatePackageSmokeTests.RunAll);
            Run("bounded_update_downloader", UpdateDownloadSmokeTests.RunAll);
            Run("automatic_update_orchestration", UpdateOrchestrationSmokeTests.RunAll);
            Run("legacy_v3_launcher_contract", LegacyLauncherContractSmokeTests.RunAll);
            Run("legacy_v3_migration_snapshot", LegacyV3MigrationSmokeTests.RunAll);
            Run("legacy_v3_credential_exchange_and_import", LegacyV3CredentialExchangeSmokeTests.RunAll);
            Run("bridge_session_token_provider", BridgeSessionTokenProviderSmokeTests.RunAll);
            Run("bridge_pairing", BridgePairingSmokeTests.RunAll);
            Run("bridge_pairing_durable_retry", BridgePairingDraftSmokeTests.RunAll);
            Run("terminal_discovery_readonly_selection", TerminalDiscoverySmokeTests.RunAll);
            Run("profile_account_data_isolation", ProfileAccountDataSmokeTests.RunAll);

            Console.WriteLine(failures == 0 ? "PASS bridge_v4_prototype_smoke" : "FAIL bridge_v4_prototype_smoke " + failures);
            return failures == 0 ? 0 : 1;
        }

        private static void TestRuntimeThreshold()
        {
            Assert(RuntimePrerequisite.NetFramework48MinimumRelease == 528040, "wrong_net48_release_threshold");
            RuntimeStatus status = RuntimePrerequisite.Detect();
            Assert(status.Release >= 0, "runtime_release_negative");
        }

        private static void TestEnvelopeAcceptsV4()
        {
            const string json = "{\"v\":4,\"message_id\":\"message-1\",\"type\":\"query.request\",\"sent_at_utc_msc\":1788307200000,\"correlation_id\":null,\"route\":{\"terminal_instance_id\":\"terminal-1\",\"account_ref\":{\"broker_server\":\"Demo\",\"login\":\"10001\"},\"connection_epoch\":1},\"payload\":{\"request_id\":\"request-1\",\"resource\":\"account.snapshot\",\"params\":{},\"deadline_utc_msc\":1788307205000}}";
            BridgeEnvelope envelope = BridgeEnvelope.Parse(json);
            Assert(envelope.ProtocolVersion == 4, "protocol_version_not_parsed");
            Assert(envelope.MessageType == "query.request", "message_type_not_parsed");
            Assert(envelope.TerminalInstanceId == "terminal-1", "route_not_parsed");
        }

        private static void TestEnvelopeRejectsUnknownField()
        {
            const string json = "{\"v\":4,\"message_id\":\"message-1\",\"type\":\"system.heartbeat\",\"sent_at_utc_msc\":1788307200000,\"correlation_id\":null,\"payload\":{},\"unsafe\":true}";
            AssertThrows<BridgeProtocolException>(delegate { BridgeEnvelope.Parse(json); }, "unknown_field_accepted");
        }

        private static void TestProtocolCatalog()
        {
            Assert(ProtocolCatalog.IsQueryResource("market.quote"), "market_quote_missing");
            Assert(!ProtocolCatalog.IsQueryResource("risk.snapshot"), "composed_risk_resource_accepted");
            Assert(!ProtocolCatalog.IsQueryResource("sql.query"), "arbitrary_query_accepted");
            Assert(ProtocolCatalog.IsCommandAction("position.protection.set"), "protection_command_missing");
            Assert(!ProtocolCatalog.IsCommandAction("script.execute"), "arbitrary_command_accepted");
            Assert(ProtocolCatalog.IsStreamResource("current_candle"), "current_candle_stream_missing");
            const string persistedAck = "{\"v\":4,\"message_id\":\"message-ack-1\",\"type\":\"data.persisted.ack\",\"sent_at_utc_msc\":1788307200000,\"correlation_id\":null,\"route\":{\"terminal_instance_id\":\"terminal-1\",\"account_ref\":{\"broker_server\":\"Demo\",\"login\":\"10001\"},\"connection_epoch\":1},\"payload\":{\"resource\":\"market.candles\",\"scope_key\":\"XAUUSD|M5\",\"range_start_utc_msc\":1788300000000,\"range_end_utc_msc\":1788307200000,\"source_revision\":\"revision-1\",\"status\":\"persisted\",\"persisted_at_utc_msc\":1788307200000}}";
            Assert(BridgeEnvelope.Parse(persistedAck).MessageType == "data.persisted.ack", "data_persisted_ack_missing");
        }

        private static void TestWebSocketAccept()
        {
            const string key = "dGhlIHNhbXBsZSBub25jZQ==";
            Assert(WebSocketHandshake.ComputeAccept(key) == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "rfc_accept_mismatch");
            string response = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
            WebSocketHandshake.ValidateResponse(response, key);
        }

        private static void TestClientFrameMasking()
        {
            byte[] encoded = WebSocketFrameCodec.EncodeClientText("hello");
            Assert((encoded[1] & 0x80) != 0, "client_frame_not_masked");
            Assert((encoded[0] & 0x0F) == 0x01, "client_frame_not_text");
        }

        private static void TestServerFrame()
        {
            byte[] bytes = new byte[] { 0x81, 0x05, (byte)'h', (byte)'e', (byte)'l', (byte)'l', (byte)'o' };
            WebSocketFrame frame = WebSocketFrameCodec.ReadServerFrame(new MemoryStream(bytes));
            Assert(frame.Final, "server_frame_not_final");
            Assert(frame.Opcode == WebSocketOpcode.Text, "server_frame_opcode_wrong");
            Assert(Encoding.UTF8.GetString(frame.Payload) == "hello", "server_frame_payload_wrong");
        }

        private static void TestPipeFrameRoundTrip()
        {
            MemoryStream stream = new MemoryStream();
            PipeFrameCodec.WriteJson(stream, "{\"message_type\":\"heartbeat\"}");
            stream.Position = 0;
            Assert(PipeFrameCodec.ReadJson(stream) == "{\"message_type\":\"heartbeat\"}", "pipe_round_trip_failed");
        }

        private static void TestMt5WorkerJsonFrame()
        {
            MemoryStream stream = new MemoryStream();
            Mt5WorkerFrameCodec.WriteJson(stream, "{\"ok\":true}");
            byte[] bytes = stream.ToArray();
            Assert(bytes[0] == 11 && bytes[1] == 0 && bytes[2] == 0 && bytes[3] == 0,
                "mt5_worker_frame_not_little_endian");
            stream.Position = 0;
            Assert(Mt5WorkerFrameCodec.ReadJson(stream) == "{\"ok\":true}",
                "mt5_worker_frame_round_trip_failed");
        }

        private static void TestMt5WorkerConnectTimeout()
        {
            string root = Path.Combine(Path.GetTempPath(),
                "liangjian-bridge-v4-worker-timeout-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            string marker = Path.Combine(root, "still-running.marker");
            string fakeWorker = Path.Combine(root, "never-connect.vbs");
            string systemHost = Path.Combine(Environment.SystemDirectory, "wscript.exe");
            try
            {
                Assert(File.Exists(systemHost), "wscript_missing_for_timeout_test");
                File.WriteAllText(fakeWorker,
                    "Set fso = CreateObject(\"Scripting.FileSystemObject\")\r\n"
                    + "WScript.Sleep 1500\r\n"
                    + "fso.CreateTextFile(\"" + marker + "\", True).Close\r\n");
                Mt5WorkerConfiguration configuration = new Mt5WorkerConfiguration(
                    systemHost, fakeWorker, systemHost, "mt5-timeout-test", "Demo", "10001");
                using (Mt5WorkerHost host = new Mt5WorkerHost(
                    "LiangjianBridgeV4.Timeout", 150, 500))
                {
                    int started = Environment.TickCount;
                    bool timedOut = false;
                    try
                    {
                        host.Connect(configuration);
                    }
                    catch (TimeoutException)
                    {
                        timedOut = true;
                    }
                    int elapsed = unchecked(Environment.TickCount - started);
                    Assert(timedOut, "mt5_worker_timeout_not_reported");
                    Assert(elapsed < 3000, "mt5_worker_timeout_unbounded");
                    Assert(host.Snapshot().Count == 0, "mt5_worker_timeout_session_leaked");
                    Thread.Sleep(1800);
                    Assert(!File.Exists(marker), "mt5_worker_timeout_process_leaked");
                }
            }
            finally
            {
                if (Directory.Exists(root))
                {
                    Directory.Delete(root, true);
                }
            }
        }

        private static void TestMt5WorkerIdleExit()
        {
            string root = Path.Combine(Path.GetTempPath(),
                "liangjian-bridge-v4-worker-exit-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            string fakeWorker = Path.Combine(root, "hello-and-exit.fake");
            string executable = Process.GetCurrentProcess().MainModule.FileName;
            try
            {
                Assert(File.Exists(executable), "smoke_executable_missing_for_exit_test");
                File.WriteAllText(fakeWorker, "hello-and-exit\r\n500\r\n");
                Mt5WorkerConfiguration configuration = new Mt5WorkerConfiguration(
                    executable, fakeWorker, executable, "mt5-idle-exit-test", "Demo", "10002");
                using (Mt5WorkerHost host = new Mt5WorkerHost(
                    "LiangjianBridgeV4.Exit", 5000, 500))
                {
                    int disconnects = 0;
                    host.SessionDisconnected += delegate
                    {
                        Interlocked.Increment(ref disconnects);
                    };
                    Mt5WorkerSession session = host.Connect(configuration);
                    int started = Environment.TickCount;
                    while (unchecked(Environment.TickCount - started) < 3000
                        && Volatile.Read(ref disconnects) == 0)
                    {
                        Thread.Sleep(25);
                    }
                    Assert(Volatile.Read(ref disconnects) == 1,
                        "mt5_worker_idle_exit_event_missing_or_duplicate");
                    Assert(host.Snapshot().Count == 0, "mt5_worker_idle_exit_session_leaked");
                    Assert(!session.IsConnected, "mt5_worker_idle_exit_still_connected");
                    Thread.Sleep(250);
                    Assert(Volatile.Read(ref disconnects) == 1,
                        "mt5_worker_idle_exit_event_duplicated");
                }
            }
            finally
            {
                if (Directory.Exists(root))
                {
                    Directory.Delete(root, true);
                }
            }
        }

        private static void TestMt5WorkerImmediateExit()
        {
            string root = Path.Combine(Path.GetTempPath(),
                "liangjian-bridge-v4-worker-immediate-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            string fakeWorker = Path.Combine(root, "immediate-exit.fake");
            string executable = Process.GetCurrentProcess().MainModule.FileName;
            try
            {
                Assert(File.Exists(executable), "smoke_executable_missing_for_immediate_test");
                File.WriteAllText(fakeWorker, "hello-and-exit\r\n10\r\n");
                for (int index = 0; index < 20; index++)
                {
                    string terminalId = "mt5-immediate-exit-" + index.ToString();
                    Mt5WorkerConfiguration configuration = new Mt5WorkerConfiguration(
                        executable, fakeWorker, executable, terminalId, "Demo", "10003");
                    using (Mt5WorkerHost host = new Mt5WorkerHost(
                        "LiangjianBridgeV4.Immediate" + index.ToString(), 5000, 500))
                    {
                        int disconnects = 0;
                        host.SessionDisconnected += delegate
                        {
                            Interlocked.Increment(ref disconnects);
                        };
                        Mt5WorkerSession session = null;
                        try
                        {
                            session = host.Connect(configuration);
                        }
                        catch (InvalidOperationException error)
                        {
                            Assert(error.Message == "bridge_mt5_worker_process_exited"
                                || error.Message == "bridge_mt5_worker_start_failed",
                                "mt5_worker_immediate_exit_wrong_error");
                        }
                        int started = Environment.TickCount;
                        while (unchecked(Environment.TickCount - started) < 3000
                            && host.Snapshot().Count != 0)
                        {
                            Thread.Sleep(10);
                        }
                        Assert(host.Snapshot().Count == 0,
                            "mt5_worker_immediate_exit_session_leaked");
                        if (session != null)
                        {
                            Assert(!session.IsConnected,
                                "mt5_worker_immediate_exit_connected_session_leaked");
                        }
                        Thread.Sleep(20);
                        Assert(Volatile.Read(ref disconnects) <= 1,
                            "mt5_worker_immediate_exit_event_duplicated");
                    }
                }
            }
            finally
            {
                if (Directory.Exists(root))
                {
                    Directory.Delete(root, true);
                }
            }
        }

        private static int RunFakeWorker(string scriptPath, string[] lines)
        {
            if (lines[0] == "never-connect")
            {
                Thread.Sleep(1500);
                if (lines.Length > 1 && !string.IsNullOrWhiteSpace(lines[1]))
                {
                    File.WriteAllText(lines[1], "still-running");
                }
                return 0;
            }

            string pipeName = Environment.GetEnvironmentVariable("AURUM_BRIDGE_WORKER_PIPE");
            using (NamedPipeClientStream client = new NamedPipeClientStream(
                ".", pipeName, PipeDirection.InOut, PipeOptions.None))
            {
                client.Connect(5000);
                Dictionary<string, object> route = new Dictionary<string, object>(StringComparer.Ordinal)
                {
                    { "terminal_instance_id", Environment.GetEnvironmentVariable("AURUM_BRIDGE_WORKER_TERMINAL_ID") },
                    { "platform", "mt5" },
                    { "account_ref", new Dictionary<string, object>(StringComparer.Ordinal)
                        {
                            { "broker_server", Environment.GetEnvironmentVariable("AURUM_BRIDGE_WORKER_BROKER_SERVER") },
                            { "login", Environment.GetEnvironmentVariable("AURUM_BRIDGE_WORKER_LOGIN") }
                        }
                    },
                    { "connection_epoch", long.Parse(
                        Environment.GetEnvironmentVariable("AURUM_BRIDGE_WORKER_CONNECTION_EPOCH")) }
                };
                string role = Environment.GetEnvironmentVariable("AURUM_BRIDGE_WORKER_ROLE");
                object[] capabilities = role == "archive"
                    ? new object[] { "history_range_sync" }
                    : new object[] { "snapshot", "quote", "data", "execute_command", "query_execution" };
                Dictionary<string, object> hello = new Dictionary<string, object>(StringComparer.Ordinal)
                {
                    { "ipc_v", 2 },
                    { "type", "worker_hello" },
                    { "session_nonce", Environment.GetEnvironmentVariable("AURUM_BRIDGE_WORKER_NONCE") },
                    { "worker_version", "fake" },
                    { "route", route },
                    { "role", role },
                    { "capabilities", capabilities }
                };
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                Mt5WorkerFrameCodec.WriteJson(client, serializer.Serialize(hello), 5000);
                int delay = lines.Length > 1 ? int.Parse(lines[1]) : 0;
                if (delay > 0)
                {
                    Thread.Sleep(delay);
                }
            }
            return 0;
        }

        private static void TestNamedPipeRoundTrip()
        {
            string pipeName = "liangjian.bridge.v4.smoke." + Guid.NewGuid().ToString("N");
            Exception serverError = null;
            Thread serverThread = new Thread(delegate()
            {
                try
                {
                    using (TerminalPipeServer server = new TerminalPipeServer(pipeName))
                    {
                        server.WaitForConnection(5000);
                        string request = server.ReadJson();
                        Assert(request == "{\"message_type\":\"terminal.info\"}", "pipe_request_wrong");
                        server.WriteJson("{\"message_type\":\"query_response\"}");
                    }
                }
                catch (Exception error)
                {
                    serverError = error;
                }
            });
            serverThread.IsBackground = true;
            serverThread.Start();

            using (NamedPipeClientStream client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.None))
            {
                client.Connect(5000);
                PipeFrameCodec.WriteJson(client, "{\"message_type\":\"terminal.info\"}");
                Assert(PipeFrameCodec.ReadJson(client) == "{\"message_type\":\"query_response\"}", "pipe_response_wrong");
            }
            Assert(serverThread.Join(5000), "pipe_server_did_not_stop");
            if (serverError != null)
            {
                throw serverError;
            }
        }

        private static void TestTerminalContract()
        {
            foreach (string platform in new[] { "mt4", "mt5" })
            {
                string query = "{\"v\":1,\"type\":\"query_request\",\"request_id\":\"request-0001\",\"terminal_instance_id\":\"" + platform + "-terminal-0001\",\"account_ref\":{\"broker_server\":\"Demo\",\"login\":\"10001\"},\"session_epoch\":2,\"deadline_utc_msc\":1788307205000,\"resource\":\"market.quote\",\"params\":{\"symbols\":[\"XAUUSD\"]}}";
                TerminalRequest request = TerminalRequest.Parse(query);
                Assert(request.Resource == "market.quote", platform + "_query_resource_wrong");
                Assert(request.TerminalInstanceId == platform + "-terminal-0001", platform + "_terminal_route_wrong");
            }

            const string command = "{\"v\":1,\"type\":\"command_request\",\"request_id\":\"request-0002\",\"terminal_instance_id\":\"mt5-terminal-0001\",\"account_ref\":{\"broker_server\":\"Demo\",\"login\":\"10001\"},\"session_epoch\":2,\"issued_at_utc_msc\":1788307200000,\"deadline_utc_msc\":1788307205000,\"action\":\"position.close\",\"command_id\":\"command-0002\",\"idempotency_key\":\"idempotency-key-0002\",\"params\":{\"ticket\":\"123\",\"deviation\":5},\"expected_state\":{\"ticket\":\"123\",\"symbol\":\"XAUUSD\",\"direction\":\"buy\",\"order_type\":\"market\",\"magic\":0,\"volume\":\"0.10\",\"open_price\":\"1.0000\",\"stop_limit_price\":null,\"stop_loss\":null,\"take_profit\":null,\"expiration_utc_msc\":null}}";
            Assert(TerminalRequest.Parse(command).Action == "position.close", "terminal_command_action_wrong");

            const string composed = "{\"v\":1,\"type\":\"query_request\",\"request_id\":\"request-0003\",\"terminal_instance_id\":\"mt5-terminal-0001\",\"account_ref\":{\"broker_server\":\"Demo\",\"login\":\"10001\"},\"session_epoch\":2,\"deadline_utc_msc\":1788307205000,\"resource\":\"risk.snapshot\",\"params\":{}}";
            AssertThrows<InvalidDataException>(delegate { TerminalRequest.Parse(composed); }, "terminal_composed_query_accepted");

            const string arbitrary = "{\"v\":1,\"type\":\"command_request\",\"request_id\":\"request-0004\",\"terminal_instance_id\":\"mt5-terminal-0001\",\"account_ref\":{\"broker_server\":\"Demo\",\"login\":\"10001\"},\"session_epoch\":2,\"deadline_utc_msc\":1788307205000,\"action\":\"script.execute\",\"idempotency_key\":\"idempotency-key-0004\",\"params\":{}}";
            AssertThrows<InvalidDataException>(delegate { TerminalRequest.Parse(arbitrary); }, "terminal_arbitrary_command_accepted");
        }

        private static void TestTerminalBinaryWire()
        {
            byte[] helloPayload = BuildTerminalHello("mt5", "C:\\Test\\MT5", "Demo", "10001");
            TerminalHello hello = TerminalHello.Parse(helloPayload);
            Assert(hello.Platform == "mt5" && hello.TerminalBuild == 6140, "terminal_hello_wrong");

            TerminalWireWriter invalid = new TerminalWireWriter();
            invalid.WriteInt32((int)TerminalWireMessageType.Hello);
            invalid.WriteInt32(1);
            invalid.WriteString("4.0.0");
            invalid.WriteString("mt5");
            invalid.WriteString("C:\\Test\\MT5");
            invalid.WriteString("C:\\Program Files\\MT5");
            invalid.WriteString("Demo");
            invalid.WriteString("10001");
            invalid.WriteInt32(6140);
            invalid.WriteInt32(1);
            invalid.WriteInt32(0);
            invalid.WriteInt32(180);
            invalid.WriteString("calibrated");
            invalid.WriteInt64(1788307200000);
            invalid.WriteInt32(123);
            AssertThrows<InvalidDataException>(delegate { TerminalHello.Parse(invalid.ToArray()); }, "terminal_trailing_bytes_accepted");

            AssertThrows<ArgumentException>(delegate
            {
                TerminalQueryPayload.NoParameters("request-0001", TerminalResourceCode.MarketCandles, 1788307205000);
            }, "parameterized_resource_accepted_without_parameters");
        }

        private static void TestTerminalReadOnlySession()
        {
            string pipeName = "liangjian.bridge.v4.session." + Guid.NewGuid().ToString("N");
            Exception clientError = null;
            Thread clientThread = new Thread(delegate()
            {
                try
                {
                    using (NamedPipeClientStream client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.None))
                    {
                        client.Connect(5000);
                        PipeFrameCodec.WritePayload(client, BuildTerminalHello("mt4", "C:\\Test\\MT4", "Demo", "20002"));
                        TerminalWireReader welcome = new TerminalWireReader(PipeFrameCodec.ReadPayload(client));
                        welcome.ExpectMessageType(TerminalWireMessageType.Welcome);
                        Assert(welcome.ReadString(191).StartsWith("mt4-", StringComparison.Ordinal), "terminal_instance_id_wrong");
                        Assert(welcome.ReadInt64() > 0, "terminal_session_epoch_wrong");
                        welcome.EnsureEnd();

                        TerminalWireReader query = new TerminalWireReader(PipeFrameCodec.ReadPayload(client));
                        query.ExpectMessageType(TerminalWireMessageType.QueryRequest);
                        string requestId = query.ReadString(191);
                        int resource = query.ReadInt32();
                        Assert(resource == (int)TerminalResourceCode.AccountSnapshot, "terminal_query_resource_wrong");
                        Assert(query.ReadInt64() > 0, "terminal_query_deadline_wrong");
                        query.EnsureEnd();

                        TerminalWireWriter response = new TerminalWireWriter();
                        response.WriteInt32((int)TerminalWireMessageType.QueryResponse);
                        response.WriteString(requestId);
                        response.WriteInt32(resource);
                        response.WriteInt64(1788307200100);
                        response.WriteInt32(180);
                        response.WriteString("calibrated");
                        response.WriteString("{\"login\":\"20002\",\"balance\":\"1000.00\"}");
                        response.WriteString(string.Empty);
                        response.WriteInt32(0);
                        PipeFrameCodec.WritePayload(client, response.ToArray());
                    }
                }
                catch (Exception error)
                {
                    clientError = error;
                }
            });
            clientThread.IsBackground = true;
            clientThread.Start();

            using (TerminalPipeServer server = new TerminalPipeServer(pipeName))
            using (TerminalReadOnlySession session = TerminalReadOnlySession.Accept(server, 5000))
            {
                const string requestId = "request-0005";
                string requestJson = "{\"v\":1,\"type\":\"query_request\",\"request_id\":\"" + requestId
                    + "\",\"terminal_instance_id\":\"" + session.TerminalInstanceId
                    + "\",\"account_ref\":{\"broker_server\":\"Demo\",\"login\":\"20002\"},\"session_epoch\":"
                    + session.SessionEpoch
                    + ",\"deadline_utc_msc\":1788307205000,\"resource\":\"account.snapshot\",\"params\":{}}";
                TerminalTranslatedQuery translated = TerminalQueryTranslator.Translate(TerminalRequest.Parse(requestJson), session);
                TerminalQueryResult result = session.Query(translated.Payload, translated.RequestId, translated.Resource);
                Assert(result.Succeeded && result.DataJson.Contains("1000.00"), "terminal_query_result_wrong");

                string wrongRoute = requestJson.Replace("\"login\":\"20002\"", "\"login\":\"99999\"");
                AssertThrows<InvalidDataException>(delegate
                {
                    TerminalQueryTranslator.Translate(TerminalRequest.Parse(wrongRoute), session);
                }, "terminal_query_route_mismatch_accepted");

                string quoteJson = requestJson
                    .Replace("\"request_id\":\"request-0005\"", "\"request_id\":\"request-0006\"")
                    .Replace("\"resource\":\"account.snapshot\",\"params\":{}", "\"resource\":\"market.quote\",\"params\":{\"symbols\":[\"XAUUSD\"]}");
                TerminalTranslatedQuery quote = TerminalQueryTranslator.Translate(TerminalRequest.Parse(quoteJson), session);
                TerminalWireReader quoteWire = new TerminalWireReader(quote.Payload);
                quoteWire.ExpectMessageType(TerminalWireMessageType.QueryRequest);
                Assert(quoteWire.ReadString(191) == "request-0006", "terminal_quote_request_id_wrong");
                Assert(quoteWire.ReadInt32() == (int)TerminalResourceCode.MarketQuote, "terminal_quote_resource_wrong");
                quoteWire.ReadInt64();
                Assert(quoteWire.ReadInt32() == 1 && quoteWire.ReadString(64) == "XAUUSD", "terminal_quote_symbols_wrong");
                quoteWire.EnsureEnd();

                string place = CommandJson(session, "order.place",
                    "{\"symbol\":\"XAUUSD\",\"direction\":\"buy\",\"order_type\":\"market\",\"volume\":\"0.01\",\"magic\":7,\"deviation\":5}", "null");
                TerminalTranslatedCommand placeCommand = TerminalCommandTranslator.Translate(
                    TerminalRequest.Parse(place), session);
                Assert(placeCommand.Action == TerminalCommandActionCode.OrderPlace,
                    "terminal_canonical_place_not_translated");

                string alias = place.Replace("\"direction\":\"buy\"", "\"side\":\"buy\"");
                AssertThrows<InvalidDataException>(delegate
                {
                    TerminalCommandTranslator.Translate(TerminalRequest.Parse(alias), session);
                }, "terminal_legacy_side_alias_accepted");

                foreach (string invalidDecimal in new[] { "+1", ".5", "1.", "1e2", "-1" })
                {
                    string malformed = place.Replace("\"0.01\"", "\"" + invalidDecimal + "\"");
                    AssertThrows<InvalidDataException>(delegate
                    {
                        TerminalCommandTranslator.Translate(TerminalRequest.Parse(malformed), session);
                    }, "terminal_invalid_decimal_accepted_" + invalidDecimal);
                }

                string closeWithoutExpected = CommandJson(session, "position.close",
                    "{\"ticket\":\"123\",\"deviation\":5}", "null");
                AssertThrows<InvalidDataException>(delegate
                {
                    TerminalCommandTranslator.Translate(TerminalRequest.Parse(closeWithoutExpected), session);
                }, "terminal_management_null_expected_accepted");

                string stopLimit = CommandJson(session, "order.place",
                    "{\"symbol\":\"XAUUSD\",\"direction\":\"buy\",\"order_type\":\"buy_stop_limit\",\"volume\":\"0.01\",\"price\":\"100\",\"stop_limit_price\":\"99\",\"magic\":7,\"deviation\":5}", "null");
                AssertThrows<InvalidDataException>(delegate
                {
                    TerminalCommandTranslator.Translate(TerminalRequest.Parse(stopLimit), session);
                }, "terminal_mt4_stop_limit_not_rejected");
            }
            Assert(clientThread.Join(5000), "terminal_session_client_did_not_stop");
            if (clientError != null)
            {
                throw clientError;
            }
        }

        private static string CommandJson(TerminalReadOnlySession session, string action,
            string parametersJson, string expectedJson)
        {
            return "{\"v\":1,\"type\":\"command_request\",\"request_id\":\"request-command-0001\","
                + "\"terminal_instance_id\":\"" + session.TerminalInstanceId + "\","
                + "\"account_ref\":{\"broker_server\":\"Demo\",\"login\":\"20002\"},"
                + "\"session_epoch\":" + session.SessionEpoch + ","
                + "\"issued_at_utc_msc\":1788307200000,\"deadline_utc_msc\":1788307205000,"
                + "\"action\":\"" + action + "\",\"command_id\":\"command-0000000001\","
                + "\"idempotency_key\":\"idempotency-key-0001\",\"params\":" + parametersJson
                + ",\"expected_state\":" + expectedJson + "}";
        }

        private static byte[] BuildTerminalHello(string platform, string dataPath, string server, string login)
        {
            TerminalWireWriter writer = new TerminalWireWriter();
            writer.WriteInt32((int)TerminalWireMessageType.Hello);
            writer.WriteInt32(1);
            writer.WriteString("4.0.0");
            writer.WriteString(platform);
            writer.WriteString(dataPath);
            writer.WriteString("C:\\Program Files\\MetaTrader");
            writer.WriteString(server);
            writer.WriteString(login);
            writer.WriteInt32(platform == "mt4" ? 1475 : 6140);
            writer.WriteInt32(1);
            writer.WriteInt32(0);
            writer.WriteInt32(180);
            writer.WriteString("calibrated");
            writer.WriteInt64(1788307200000);
            return writer.ToArray();
        }

        private static void TestTerminalHostMultipleInstances()
        {
            string pipeName = "liangjian.bridge.v4.host." + Guid.NewGuid().ToString("N");
            ManualResetEvent release = new ManualResetEvent(false);
            CountdownEvent ready = new CountdownEvent(2);
            Exception firstError = null;
            Exception secondError = null;
            using (TerminalSessionHost host = new TerminalSessionHost(pipeName))
            {
                host.Start();
                Thread first = StartTerminalHelloClient(pipeName, "mt4", "C:\\Test\\MT4-A", "10001", ready, release, delegate(Exception error) { firstError = error; });
                Thread second = StartTerminalHelloClient(pipeName, "mt5", "C:\\Test\\MT5-B", "20002", ready, release, delegate(Exception error) { secondError = error; });
                Assert(ready.Wait(5000), "terminal_host_clients_not_ready");
                IList<TerminalSessionSnapshot> sessions = host.Snapshot();
                Assert(sessions.Count == 2, "terminal_host_session_count_wrong");
                Assert(sessions[0].TerminalInstanceId != sessions[1].TerminalInstanceId, "terminal_host_instances_collided");
                release.Set();
                Assert(first.Join(5000) && second.Join(5000), "terminal_host_clients_did_not_stop");
            }
            release.Dispose();
            ready.Dispose();
            if (firstError != null)
            {
                throw firstError;
            }
            if (secondError != null)
            {
                throw secondError;
            }
        }

        private static Thread StartTerminalHelloClient(
            string pipeName,
            string platform,
            string dataPath,
            string login,
            CountdownEvent ready,
            ManualResetEvent release,
            Action<Exception> reportError)
        {
            Thread thread = new Thread(delegate()
            {
                try
                {
                    using (NamedPipeClientStream client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.None))
                    {
                        client.Connect(5000);
                        PipeFrameCodec.WritePayload(client, BuildTerminalHello(platform, dataPath, "Demo", login));
                        TerminalWireReader welcome = new TerminalWireReader(PipeFrameCodec.ReadPayload(client));
                        welcome.ExpectMessageType(TerminalWireMessageType.Welcome);
                        welcome.ReadString(191);
                        welcome.ReadInt64();
                        welcome.EnsureEnd();
                        ready.Signal();
                        release.WaitOne(5000);
                    }
                }
                catch (Exception error)
                {
                    reportError(error);
                    ready.Signal();
                }
            });
            thread.IsBackground = true;
            thread.Start();
            return thread;
        }

        private static void TestSqliteLedgerIdempotency()
        {
            string testRoot = Path.Combine(Path.GetTempPath(), "liangjian-bridge-v4-tests", Guid.NewGuid().ToString("N"));
            string databasePath = Path.Combine(testRoot, "ledger.db");
            try
            {
                using (CommandLedger ledger = new CommandLedger(databasePath))
                {
                    CommandAcceptance first = ledger.Accept("profile-a", "command-0001", "idempotency-key-0001", "order.place", "sha256:abc", 1788307200000);
                    Assert(!first.Duplicate && first.State == "recorded", "ledger_first_accept_wrong");
                    Assert(ledger.ReadUpdateActivity("profile-a").ActiveCommands == 1,
                        "ledger_recorded_not_update_active");
                    CommandAcceptance duplicate = ledger.Accept("profile-a", "command-0001", "idempotency-key-0001", "order.place", "sha256:abc", 1788307200001);
                    Assert(duplicate.Duplicate && duplicate.State == "recorded", "ledger_duplicate_wrong");
                    AssertThrows<InvalidDataException>(delegate
                    {
                        ledger.Accept("profile-a", "command-0002", "idempotency-key-0001", "position.close", "sha256:def", 1788307200002);
                    }, "ledger_conflict_accepted");
                    Assert(ledger.TryMarkDispatched("profile-a", "idempotency-key-0001"), "ledger_dispatch_not_recorded");
                    Assert(!ledger.TryMarkDispatched("profile-a", "idempotency-key-0001"), "ledger_dispatch_repeated");
                    ledger.RecordResult("profile-a", "idempotency-key-0001", "uncertain", 1788307201000, "{\"reason\":\"transport_lost\"}");
                    ledger.RecordResult("profile-a", "idempotency-key-0001", "uncertain", 1788307201000, "{\"reason\":\"transport_lost\"}");
                    Assert(ledger.ReadState("profile-a", "idempotency-key-0001") == "uncertain", "ledger_uncertain_missing");
                    Assert(ledger.ReadUpdateActivity("profile-a").UncertainCommands == 1,
                        "ledger_uncertain_not_update_blocking");
                    ledger.RecordResult("profile-a", "idempotency-key-0001", "succeeded", 1788307202000, "{\"ticket\":\"123\"}");
                    Assert(ledger.ReadState("profile-a", "idempotency-key-0001") == "succeeded", "ledger_reconcile_missing");
                    Assert(ledger.ReadByCommandId("profile-a", "command-0001").ResultJson == "{\"ticket\":\"123\"}",
                        "ledger_result_not_readable");
                    CommandLedgerActivity completedActivity = ledger.ReadUpdateActivity("profile-a");
                    Assert(completedActivity.ActiveCommands == 0 && completedActivity.UncertainCommands == 0,
                        "ledger_completed_command_blocks_update");
                    CommandAcceptance isolated = ledger.Accept("profile-b", "command-0001", "idempotency-key-0001", "order.place", "sha256:abc", 1788307203000);
                    Assert(!isolated.Duplicate, "ledger_profile_not_isolated");
                }
                using (CommandLedger reopened = new CommandLedger(databasePath))
                {
                    Assert(reopened.ReadState("profile-a", "idempotency-key-0001") == "succeeded", "ledger_not_persisted");
                }
            }
            finally
            {
                if (Directory.Exists(testRoot))
                {
                    Directory.Delete(testRoot, true);
                }
            }
        }

        private static void TestSqliteProfileDataStore()
        {
            string testRoot = Path.Combine(Path.GetTempPath(), "liangjian-bridge-v4-profile-tests", Guid.NewGuid().ToString("N"));
            string databasePath = Path.Combine(testRoot, "profile.db");
            try
            {
                using (ProfileDataStore store = new ProfileDataStore(databasePath, "profile-a", "terminal-a", "mt5", "Demo", "10001", 7))
                {
                    IList<SchemaMigrationRecord> migrations = store.ReadSchemaMigrations();
                    Assert(migrations.Count == 2 && migrations[0].Version == 1 && migrations[1].Version == 2, "profile_migration_missing");
                    Assert(migrations[0].Checksum.Length == 64, "profile_migration_checksum_missing");
                    Assert(migrations[0].Checksum == "e94f281b3a22db4f7db84303c54e294083abfa214d2dfd29fa06ea15d3475eeb", "profile_v1_migration_checksum_changed");
                    Assert(migrations[1].Checksum.Length == 64 && migrations[1].Name == "profile_data_store_v2", "profile_v2_migration_checksum_missing");
                    Assert(migrations[0].AppliedAtUtcMsc > 1700000000000 && migrations[0].AppliedAtUtcMsc < 2000000000000, "profile_migration_time_not_unix_utc");
                    ProfileStateRecord state = store.ReadProfileState();
                    Assert(state.ProfileId == "profile-a" && state.ConnectionEpoch == 7, "profile_state_wrong");

                    CandleRecord candle = NewCandle(1788307200000, 1788307200000, "rev-1");
                    store.UpsertClosedCandle(7, candle);
                    candle.Close = 2.0;
                    candle.ObservedAtUtcMsc++;
                    store.UpsertClosedCandle(7, candle);
                    CandlePage candlePage = store.ReadCandles("XAUUSD", "M5", 1788307199000, 1788307201000, 10, null);
                    Assert(candlePage.Items.Count == 1 && candlePage.Items[0].Close == 2.0, "candle_idempotent_upsert_wrong");
                    CandleRecord oldCandle = NewCandle(1788307200000, 1788307200000, "old-revision");
                    oldCandle.Close = 9.0;
                    store.UpsertClosedCandle(7, oldCandle);
                    Assert(store.ReadCandles("XAUUSD", "M5", 1788307200000, 1788307201000, 10, null).Items[0].Close == 2.0, "older_candle_rewrote_newer_fact");
                    List<CandleRecord> candleBatch = new List<CandleRecord>();
                    candleBatch.Add(NewCandle(1788307210000, 1788307210000, "batch-rev"));
                    candleBatch.Add(NewCandle(1788307215000, 1788307215000, "batch-rev"));
                    store.UpsertClosedCandles(7, candleBatch);
                    store.UpsertClosedCandles(7, candleBatch);
                    Assert(store.ReadCandles("XAUUSD", "M5", 1788307210000, 1788307220000, 10, null).Items.Count == 2, "candle_batch_upsert_not_idempotent");
                    List<CandleRecord> tooManyCandles = new List<CandleRecord>();
                    for (int i = 0; i < 501; i++)
                    {
                        tooManyCandles.Add(NewCandle(1788307300000 + (i * 600000L), 1788307300000 + i, "too-many"));
                    }
                    AssertThrows<InvalidDataException>(delegate { store.UpsertClosedCandles(7, tooManyCandles); }, "candle_batch_over_500_accepted");
                    AssertThrows<InvalidDataException>(delegate { store.ReadCandles("XAUUSD", "M5", 1788307199000, 1788307201000, 501, null); }, "candle_page_over_500_accepted");
                    AssertThrows<InvalidDataException>(delegate
                    {
                        store.UpsertClosedCandle(7, new CandleRecord
                        {
                            Symbol = "XAUUSD",
                            Timeframe = "M5",
                            OpenTimeUtcMsc = 1788307201000,
                            Open = 1,
                            High = 1,
                            Low = 1,
                            Close = 1,
                            TickVolume = 1,
                            RealVolume = 0,
                            Spread = 0,
                            Closed = false,
                            ObservedAtUtcMsc = 1788307201001
                        });
                    }, "open_candle_persisted");

                    store.UpsertHistoryItem(7, NewHistory("orders", "2", 1788307200000, "rev-1", "first"));
                    store.UpsertHistoryItem(7, NewHistory("orders", "1", 1788307200000, "rev-1", "second"));
                    HistoryItemRecord duplicate = NewHistory("orders", "1", 1788307200000, "rev-1", "updated");
                    store.UpsertHistoryItem(7, duplicate);
                    HistoryItemRecord oldHistory = NewHistory("orders", "1", 1788307199500, "old-revision", "old");
                    store.UpsertHistoryItem(7, oldHistory);
                    Assert(store.ReadHistory("orders", 1788307199000, 1788307201000, 10, null).Items[0].FactJson.Contains("updated"), "older_history_rewrote_newer_fact");
                    HistoryItemRecord unsignedIdentifierHistory = NewHistory("orders", "uint64", 1788307200700, "rev-1", "uint64");
                    unsignedIdentifierHistory.Ticket = "18446744073709551615";
                    unsignedIdentifierHistory.OrderId = "18446744073709551615";
                    unsignedIdentifierHistory.PositionId = "18446744073709551615";
                    store.UpsertHistoryItem(7, unsignedIdentifierHistory);
                    HistoryItemRecord storedUnsignedIdentifier = store.ReadHistory("orders", 1788307200699, 1788307200701, 10, null).Items[0];
                    Assert(storedUnsignedIdentifier.Ticket == "18446744073709551615" && storedUnsignedIdentifier.OrderId == "18446744073709551615" && storedUnsignedIdentifier.PositionId == "18446744073709551615", "history_uint64_identifier_not_preserved");
                    store.UpsertHistoryItems(7, new List<HistoryItemRecord>
                    {
                        NewHistory("orders", "3", 1788307200500, "rev-1", "batch"),
                        NewHistory("orders", "4", 1788307200600, "rev-1", "batch")
                    });
                    List<HistoryItemRecord> tooManyHistoryItems = new List<HistoryItemRecord>();
                    for (int i = 0; i < 501; i++)
                    {
                        tooManyHistoryItems.Add(NewHistory("orders", "too-many-" + i, 1788307300000 + i, "too-many", "too-many"));
                    }
                    AssertThrows<InvalidDataException>(delegate { store.UpsertHistoryItems(7, tooManyHistoryItems); }, "history_batch_over_500_accepted");
                    HistoryPage firstPage = store.ReadHistory("orders", 1788307199000, 1788307201000, 1, null);
                    Assert(firstPage.Items.Count == 1 && firstPage.HasMore && firstPage.Items[0].ItemId == "1", "history_first_page_wrong");
                    HistoryPage secondPage = store.ReadHistory("orders", 1788307199000, 1788307201000, 1, firstPage.NextCursor);
                    Assert(secondPage.Items.Count == 1 && secondPage.HasMore && secondPage.Items[0].ItemId == "2", "history_keyset_cursor_wrong");
                    HistoryPage thirdPage = store.ReadHistory("orders", 1788307199000, 1788307201000, 1, secondPage.NextCursor);
                    Assert(thirdPage.Items.Count == 1 && thirdPage.HasMore && thirdPage.Items[0].ItemId == "3", "history_keyset_cursor_not_stable");

                    store.UpsertCoverage(7, new CoverageRangeRecord
                    {
                        Resource = "market.candles",
                        ScopeKey = ProfileDataStore.CandleScopeKey("XAUUSD", "M5"),
                        RangeStartUtcMsc = 1788307199000,
                        RangeEndUtcMsc = 1788307210000,
                        Completeness = "complete",
                        SourceRevision = "rev-1",
                        UpdatedAtUtcMsc = 1788307201000
                    });
                    store.UpsertCoverage(7, new CoverageRangeRecord
                    {
                        Resource = "market.candles",
                        ScopeKey = ProfileDataStore.CandleScopeKey("XAUUSD", "M5"),
                        RangeStartUtcMsc = 1788307199000,
                        RangeEndUtcMsc = 1788307210000,
                        Completeness = "incomplete",
                        SourceRevision = "old-revision",
                        UpdatedAtUtcMsc = 1788307200999
                    });
                    IList<CoverageRangeRecord> freshCoverage = store.ReadCoverage("market.candles", ProfileDataStore.CandleScopeKey("XAUUSD", "M5"));
                    Assert(freshCoverage.Count == 1 && freshCoverage[0].Completeness == "complete" && freshCoverage[0].SourceRevision == "rev-1", "older_coverage_rewrote_newer_fact");
                    CoverageRangeRecord expectedCoverage = new CoverageRangeRecord
                    {
                        Resource = "history.orders",
                        ScopeKey = "orders",
                        RangeStartUtcMsc = 1788307199000,
                        RangeEndUtcMsc = 1788307210000,
                        Completeness = "complete",
                        SourceRevision = "rev-1",
                        UpdatedAtUtcMsc = 1788307201000
                    };
                    store.UpsertCoverage(7, expectedCoverage);
                    store.CreateQuerySnapshot(7, new QuerySnapshotRecord
                    {
                        SnapshotId = "snapshot-1",
                        Resource = "market.candles",
                        ScopeKey = ProfileDataStore.CandleScopeKey("XAUUSD", "M5"),
                        QueryHash = "sha256:test",
                        FrozenRevision = "rev-1",
                        RangeStartUtcMsc = 1788307199000,
                        RangeEndUtcMsc = 1788307210000,
                        CreatedAtUtcMsc = 1788307201000,
                        ExpiresAtUtcMsc = 1788307205000
                    });
                    Assert(store.IsRangeProtected("market.candles", ProfileDataStore.CandleScopeKey("XAUUSD", "M5"), 1788307200000, 1788307200001, 1788307202000), "active_snapshot_not_protected");
                    store.RecordServerCoverageAck(7, new ServerCoverageAckRecord
                    {
                        Resource = "history.orders",
                        ScopeKey = "orders",
                        RangeStartUtcMsc = 1788307199000,
                        RangeEndUtcMsc = 1788307210000,
                        SourceRevision = "rev-1",
                        AckedAtUtcMsc = 1788307202000
                    });
                    AssertThrows<InvalidDataException>(delegate { store.UpsertCoverage(6, expectedCoverage); }, "old_epoch_coverage_accepted");
                    AssertThrows<InvalidDataException>(delegate { store.RecordServerCoverageAck(6, new ServerCoverageAckRecord
                    {
                        Resource = "history.orders",
                        ScopeKey = "orders",
                        RangeStartUtcMsc = 1788307199000,
                        RangeEndUtcMsc = 1788307210000,
                        SourceRevision = "rev-1",
                        AckedAtUtcMsc = 1788307202000
                    }); }, "old_epoch_ack_accepted");
                    AssertThrows<InvalidDataException>(delegate { store.CreateQuerySnapshot(6, new QuerySnapshotRecord
                    {
                        SnapshotId = "old-epoch-snapshot",
                        Resource = "market.candles",
                        ScopeKey = ProfileDataStore.CandleScopeKey("XAUUSD", "M5"),
                        QueryHash = "sha256:old",
                        RangeStartUtcMsc = 1788307199000,
                        RangeEndUtcMsc = 1788307210000,
                        CreatedAtUtcMsc = 1788307201000,
                        ExpiresAtUtcMsc = 1788307205000
                    }); }, "old_epoch_snapshot_accepted");
                    store.ValidateRoute("profile-a", "terminal-a", "mt5", "Demo", "10001", 7);
                    AssertThrows<InvalidDataException>(delegate
                    {
                        store.ValidateRoute("profile-a", "terminal-other", "mt5", "Demo", "10001", 7);
                    }, "wrong_terminal_route_accepted");
                    AssertThrows<InvalidDataException>(delegate
                    {
                        store.ValidateRoute("profile-a", "terminal-a", "mt5", "Demo", "10001", 8);
                    }, "wrong_epoch_route_accepted");
                    store.RebindEpoch(8);
                    AssertThrows<InvalidDataException>(delegate { store.UpsertClosedCandle(7, NewCandle(1788307220000, 1788307220000, "stale-epoch")); }, "old_epoch_candle_accepted_after_rebind");
                }

                using (ProfileDataStore reopened = new ProfileDataStore(databasePath, "profile-a", "terminal-a", "mt5", "Demo", "10001", 9))
                {
                    Assert(reopened.ReadCandles("XAUUSD", "M5", 1788307199000, 1788307201000, 10, null).Items.Count == 1, "profile_reopen_candle_missing");
                    Assert(reopened.ReadHistory("orders", 1788307199000, 1788307201000, 10, null).Items.Count == 5, "profile_reopen_history_missing");
                    Assert(reopened.ReadProfileState().ConnectionEpoch == 9, "profile_reopen_epoch_not_advanced");
                }
                AssertThrows<InvalidDataException>(delegate
                {
                    using (ProfileDataStore wrongIdentity = new ProfileDataStore(databasePath, "profile-other", "terminal-a", "mt5", "Demo", "10001", 7))
                    {
                    }
                }, "profile_wrong_identity_accepted");
                AssertThrows<InvalidDataException>(delegate
                {
                    using (ProfileDataStore wrongEpoch = new ProfileDataStore(databasePath, "profile-a", "terminal-a", "mt5", "Demo", "10001", 8))
                    {
                    }
                }, "profile_wrong_epoch_accepted_on_open");
                using (SQLiteConnection tamper = new SQLiteConnection("Data Source=" + databasePath + ";Version=3;BusyTimeout=5000;"))
                {
                    tamper.Open();
                    using (SQLiteCommand command = tamper.CreateCommand())
                    {
                        command.CommandText = "UPDATE schema_migrations SET checksum = @checksum WHERE version = 1";
                        SQLiteParameter checksum = command.CreateParameter();
                        checksum.ParameterName = "@checksum";
                        checksum.Value = new string('0', 64);
                        command.Parameters.Add(checksum);
                        command.ExecuteNonQuery();
                    }
                }
                AssertThrows<InvalidDataException>(delegate
                {
                    using (ProfileDataStore tampered = new ProfileDataStore(databasePath, "profile-a", "terminal-a", "mt5", "Demo", "10001", 9))
                    {
                    }
                }, "profile_migration_checksum_tamper_accepted");
            }
            finally
            {
                if (Directory.Exists(testRoot))
                {
                    Directory.Delete(testRoot, true);
                }
            }
        }

        private static void TestSqliteMigrationUpgrade()
        {
            string testRoot = Path.Combine(Path.GetTempPath(), "liangjian-bridge-v4-migration-tests", Guid.NewGuid().ToString("N"));
            string checksumSourcePath = Path.Combine(testRoot, "checksum-source.db");
            string databasePath = Path.Combine(testRoot, "v1.db");
            try
            {
                string v1Checksum;
                using (ProfileDataStore source = new ProfileDataStore(checksumSourcePath, "profile-source", "terminal-source", "mt5", "Demo", "10001", 1))
                {
                    v1Checksum = source.ReadSchemaMigrations()[0].Checksum;
                }
                using (SQLiteConnection connection = new SQLiteConnection("Data Source=" + databasePath + ";Version=3;"))
                {
                    connection.Open();
                    using (SQLiteCommand command = connection.CreateCommand())
                    {
                        command.CommandText = "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at_utc_msc INTEGER NOT NULL); CREATE TABLE profile_state (slot INTEGER PRIMARY KEY CHECK (slot = 1), profile_id TEXT NOT NULL UNIQUE, terminal_instance_id TEXT NOT NULL, platform TEXT NOT NULL, broker_server TEXT NOT NULL, login TEXT NOT NULL, connection_epoch INTEGER NOT NULL, terminal_build INTEGER NOT NULL DEFAULT 0, clock_offset_seconds INTEGER NULL, clock_status TEXT NULL, clock_revision TEXT NULL, observed_at_utc_msc INTEGER NOT NULL); CREATE TABLE query_snapshots (profile_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, resource TEXT NOT NULL, scope_key TEXT NOT NULL, query_hash TEXT NOT NULL, frozen_revision TEXT NULL, range_start_utc_msc INTEGER NOT NULL, range_end_utc_msc INTEGER NOT NULL, created_at_utc_msc INTEGER NOT NULL, expires_at_utc_msc INTEGER NOT NULL, PRIMARY KEY (profile_id, snapshot_id)); INSERT INTO schema_migrations (version, name, checksum, applied_at_utc_msc) VALUES (1, 'profile_data_store_v1', @checksum, 1788307200000); INSERT INTO profile_state (slot, profile_id, terminal_instance_id, platform, broker_server, login, connection_epoch, observed_at_utc_msc) VALUES (1, 'profile-upgrade', 'terminal-upgrade', 'mt5', 'Demo', '10001', 1, 1788307200000); INSERT INTO query_snapshots (profile_id, snapshot_id, resource, scope_key, query_hash, frozen_revision, range_start_utc_msc, range_end_utc_msc, created_at_utc_msc, expires_at_utc_msc) VALUES ('profile-upgrade', 'legacy-snapshot', 'market.candles', 'XAUUSD|M5', 'sha256:legacy', 'legacy', 1788307200000, 1788307201000, 1788307200000, 1788307202000)";
                        AddSqlParameter(command, "@checksum", v1Checksum);
                        command.ExecuteNonQuery();
                    }
                }
                using (ProfileDataStore upgraded = new ProfileDataStore(databasePath, "profile-upgrade", "terminal-upgrade", "mt5", "Demo", "10001", 1))
                {
                    IList<SchemaMigrationRecord> migrations = upgraded.ReadSchemaMigrations();
                    Assert(migrations.Count == 2 && migrations[0].Version == 1 && migrations[1].Version == 2, "v1_to_v2_upgrade_missing");
                    Assert(!upgraded.IsRangeProtected("market.candles", "XAUUSD|M5", 1788307200000, 1788307200001, 1788307201000), "legacy_null_epoch_snapshot_protected");
                    upgraded.CreateQuerySnapshot(1, new QuerySnapshotRecord
                    {
                        SnapshotId = "upgraded-snapshot",
                        Resource = "market.candles",
                        ScopeKey = "XAUUSD|M5",
                        QueryHash = "sha256:upgrade",
                        RangeStartUtcMsc = 1788307200000,
                        RangeEndUtcMsc = 1788307201000,
                        CreatedAtUtcMsc = 1788307200000,
                        ExpiresAtUtcMsc = 1788307202000
                    });
                    Assert(upgraded.IsRangeProtected("market.candles", "XAUUSD|M5", 1788307200000, 1788307200001, 1788307201000), "upgraded_snapshot_epoch_missing");
                }
            }
            finally
            {
                if (Directory.Exists(testRoot))
                {
                    Directory.Delete(testRoot, true);
                }
            }
        }

        private static void TestSqliteProfileDataV2()
        {
            string testRoot = Path.Combine(Path.GetTempPath(), "liangjian-bridge-v4-v2-tests", Guid.NewGuid().ToString("N"));
            string databasePath = Path.Combine(testRoot, "profile.db");
            string isolatedDatabasePath = Path.Combine(testRoot, "isolated.db");
            const long now = 2000000000000;
            try
            {
                using (ProfileDataStore store = new ProfileDataStore(databasePath, "profile-v2", "terminal-v2", "mt5", "Demo", "10001", 4))
                {
                    IList<SchemaMigrationRecord> migrations = store.ReadSchemaMigrations();
                    Assert(migrations.Count == 2 && migrations[0].Checksum.Length == 64, "v2_migration_checksum_changed");
                    Assert(migrations[1].Name == "profile_data_store_v2" && migrations[1].Checksum.Length == 64, "v2_migration_record_missing");

                    store.UpsertStreamState(4, new StreamStateRecord
                    {
                        Resource = "quotes",
                        ConnectionEpoch = 4,
                        Revision = "9",
                        PayloadHash = "hash-9",
                        ObservedAtUtcMsc = now,
                        Status = "live"
                    });
                    store.UpsertStreamState(4, new StreamStateRecord
                    {
                        Resource = "quotes",
                        ConnectionEpoch = 4,
                        Revision = "10",
                        PayloadHash = "hash-10",
                        ObservedAtUtcMsc = now,
                        Status = "stale"
                    });
                    Assert(store.ReadStreamState("quotes").Revision == "9", "opaque_stream_revision_compared_lexically");
                    AssertThrows<InvalidDataException>(delegate
                    {
                        store.UpsertStreamState(4, new StreamStateRecord
                        {
                            Resource = "not-a-stream",
                            ConnectionEpoch = 4,
                            Revision = "bad",
                            ObservedAtUtcMsc = now + 1,
                            Status = "live"
                        });
                    }, "arbitrary_stream_resource_accepted");

                    store.UpsertAccountLatest(4, new AccountLatestRecord
                    {
                        ConnectionEpoch = 4,
                        Revision = "9",
                        AccountNumber = "18446744073709551615",
                        Currency = "USD",
                        Balance = 10m,
                        Equity = 11m,
                        FactJson = "{\"account\":1}",
                        ObservedAtUtcMsc = now
                    });
                    store.UpsertAccountLatest(4, new AccountLatestRecord
                    {
                        ConnectionEpoch = 4,
                        Revision = "10",
                        AccountNumber = "18446744073709551615",
                        Currency = "USD",
                        Balance = 99m,
                        Equity = 99m,
                        FactJson = "{\"account\":2}",
                        ObservedAtUtcMsc = now
                    });
                    Assert(store.ReadAccountLatest().Balance == 10m, "opaque_account_revision_compared_lexically");

                    store.UpsertInstrumentCaches(4, new List<InstrumentCacheRecord>
                    {
                        NewInstrument("XAUUSD", now, "9"),
                        NewInstrument("EURUSD", now + 1, "10")
                    });
                    InstrumentCacheRecord olderInstrument = NewInstrument("XAUUSD", now - 1, "old");
                    olderInstrument.FactJson = "{\"old\":true}";
                    store.UpsertInstrumentCache(4, olderInstrument);
                    Assert(store.ReadInstrumentCache("XAUUSD").SpecRevision == "9", "older_instrument_rewrote_fact");
                    InstrumentCachePage instrumentPage = store.ReadInstrumentCachePage(1, null);
                    Assert(instrumentPage.Items.Count == 1 && instrumentPage.HasMore, "instrument_keyset_page_wrong");
                    InstrumentCachePage instrumentPage2 = store.ReadInstrumentCachePage(1, instrumentPage.NextCursor);
                    Assert(instrumentPage2.Items.Count == 1 && instrumentPage2.Items[0].Symbol == "XAUUSD", "instrument_keyset_cursor_wrong");
                    List<InstrumentCacheRecord> tooManyInstruments = new List<InstrumentCacheRecord>();
                    for (int i = 0; i < 501; i++)
                    {
                        tooManyInstruments.Add(NewInstrument("S" + i, now + i, "batch"));
                    }
                    AssertThrows<InvalidDataException>(delegate { store.UpsertInstrumentCaches(4, tooManyInstruments); }, "instrument_batch_over_500_accepted");

                    IList<PositionLatestRecord> positions = new List<PositionLatestRecord>
                    {
                        NewPosition("18446744073709551615", now, "9", "XAUUSD"),
                        NewPosition("2", now, "9", "EURUSD")
                    };
                    Assert(store.ReplacePositionsSnapshot(4, "9", now, positions), "positions_snapshot_not_written");
                    Assert(store.ReadPositionsLatest().Count == 2, "positions_snapshot_rows_missing");
                    Assert(!store.ReplacePositionsSnapshot(4, "10", now, new List<PositionLatestRecord> { NewPosition("3", now, "10", "USDJPY") }), "stale_positions_snapshot_accepted");
                    Assert(store.ReadPositionsLatest().Count == 2, "stale_positions_snapshot_replaced_rows");
                    Assert(store.ReplacePositionsSnapshot(4, "10", now + 1, new List<PositionLatestRecord>()), "new_empty_positions_snapshot_rejected");
                    Assert(store.ReadPositionsLatest().Count == 0, "empty_positions_snapshot_not_atomic");

                    Assert(store.ReplacePendingOrdersSnapshot(4, "11", now, new List<PendingOrderLatestRecord>
                    {
                        NewPendingOrder("3", now, "11")
                    }), "pending_orders_snapshot_not_written");
                    Assert(store.ReadPendingOrdersLatest().Count == 1, "pending_orders_snapshot_missing");

                    QuerySnapshotRecord snapshot = store.CreateQuerySnapshot(4, new QuerySnapshotRecord
                    {
                        SnapshotId = "epoch-snapshot",
                        Resource = "market.candles",
                        ScopeKey = "XAUUSD|M5",
                        QueryHash = "sha256:epoch",
                        FrozenRevision = "9",
                        RangeStartUtcMsc = now,
                        RangeEndUtcMsc = now + 600000,
                        CreatedAtUtcMsc = now,
                        ExpiresAtUtcMsc = now + 600000
                    });
                    Assert(snapshot.ConnectionEpoch == 4, "snapshot_epoch_not_recorded");
                    store.CreateQuerySnapshot(4, snapshot);
                    QuerySnapshotRecord conflictingSnapshot = new QuerySnapshotRecord
                    {
                        SnapshotId = "epoch-snapshot",
                        Resource = "market.candles",
                        ScopeKey = "XAUUSD|M5",
                        QueryHash = "sha256:different",
                        FrozenRevision = "9",
                        RangeStartUtcMsc = now,
                        RangeEndUtcMsc = now + 600000,
                        CreatedAtUtcMsc = now,
                        ExpiresAtUtcMsc = now + 600000
                    };
                    AssertThrows<InvalidDataException>(delegate { store.CreateQuerySnapshot(4, conflictingSnapshot); }, "snapshot_id_conflict_silently_replaced");
                    Assert(store.IsRangeProtected("market.candles", "XAUUSD|M5", now, now + 1, now + 1), "snapshot_epoch_not_active");

                    AssertThrows<InvalidDataException>(delegate
                    {
                        store.RecordServerCoverageAck(4, new ServerCoverageAckRecord
                        {
                            Resource = "account.snapshot",
                            ScopeKey = "account",
                            RangeStartUtcMsc = now,
                            RangeEndUtcMsc = now + 1,
                            SourceRevision = "invalid",
                            AckedAtUtcMsc = now + 1
                        });
                    }, "arbitrary_persisted_ack_resource_accepted");

                    SyncJobRecord job = NewSyncJob("job-1", "market.candles", now, "9");
                    Assert(store.EnqueueSyncJob(4, job), "sync_job_first_enqueue_wrong");
                    Assert(!store.EnqueueSyncJob(4, NewSyncJob("job-1", "market.candles", now, "9")), "sync_job_duplicate_not_idempotent");
                    SyncJobRecord conflictingJob = NewSyncJob("job-1", "history.trades", now, "9");
                    AssertThrows<InvalidDataException>(delegate { store.EnqueueSyncJob(4, conflictingJob); }, "sync_job_conflict_silently_ignored");
                    AssertThrows<InvalidDataException>(delegate { store.EnqueueSyncJob(4, NewSyncJob("job-bad", "history.unknown", now, "bad")); }, "arbitrary_sync_resource_accepted");
                    SyncJobRecord claimed = store.ClaimSyncJob(4, "worker-a", now + 10, 100);
                    Assert(claimed != null && claimed.Attempt == 1 && claimed.LeaseOwner == "worker-a", "sync_job_claim_wrong");
                    Assert(store.ClaimSyncJob(4, "worker-b", now + 50, 100) == null, "sync_job_lease_not_exclusive");
                    SyncJobRecord reclaimed = store.ClaimSyncJob(4, "worker-b", now + 120, 100);
                    Assert(reclaimed != null && reclaimed.Attempt == 2 && reclaimed.LeaseOwner == "worker-b", "expired_sync_job_lease_not_recovered");
                    Assert(!store.CompleteSyncJob(4, "job-1", "worker-a", now + 130), "stale_sync_job_owner_completed");
                    Assert(store.CompleteSyncJob(4, "job-1", "worker-b", now + 130), "sync_job_completion_failed");

                    OutboxMessageRecord outbox = NewOutbox("message-1", 4, "signal", "{\"n\":1}", now);
                    Assert(store.EnqueueOutboxMessage(4, outbox), "outbox_first_enqueue_wrong");
                    Assert(!store.EnqueueOutboxMessage(4, NewOutbox("message-1", 4, "signal", "{\"n\":1}", now)), "outbox_duplicate_not_idempotent");
                    AssertThrows<InvalidDataException>(delegate { store.EnqueueOutboxMessage(4, NewOutbox("message-1", 4, "signal", "{\"n\":2}", now)); }, "outbox_payload_conflict_silently_ignored");
                    AssertThrows<InvalidDataException>(delegate { store.EnqueueOutboxMessage(4, NewOutbox("message-1", 4, "other-kind", "{\"n\":1}", now)); }, "outbox_kind_conflict_silently_ignored");
                    Assert(store.MarkOutboxAttempt(4, "message-1", 0, now + 1, now + 2, "timeout", "temporary"), "outbox_attempt_cas_failed");
                    Assert(store.ReadOutboxMessage("message-1").Attempt == 1, "outbox_attempt_not_persisted");
                    Assert(store.AckOutboxMessage(4, "message-1", now + 3), "outbox_ack_failed");
                    Assert(!store.AckOutboxMessage(4, "message-1", now + 4), "outbox_ack_not_idempotent");
                    Assert(!store.EnqueueOutboxMessage(4, outbox), "acked_outbox_replay_not_idempotent");

                    store.RecordMaintenanceState(4, new MaintenanceStateRecord
                    {
                        CleanupCursor = 6,
                        LastCheckpointAtUtcMsc = now,
                        UpdatedAtUtcMsc = now
                    });
                    Assert(store.ReadMaintenanceState().CleanupCursor == 6, "maintenance_cursor_not_persisted");
                    store.RebindEpoch(5);
                    Assert(!store.IsRangeProtected("market.candles", "XAUUSD|M5", now, now + 1, now + 1), "old_epoch_snapshot_protected_after_rebind");
                    store.UpsertStreamState(5, new StreamStateRecord
                    {
                        Resource = "quotes",
                        ConnectionEpoch = 5,
                        Revision = "1",
                        ObservedAtUtcMsc = now - 1,
                        Status = "live"
                    });
                    store.UpsertAccountLatest(5, new AccountLatestRecord
                    {
                        ConnectionEpoch = 5,
                        Revision = "1",
                        AccountNumber = "10001",
                        Currency = "USD",
                        Balance = 12m,
                        FactJson = "{\"epoch\":5}",
                        ObservedAtUtcMsc = now - 1
                    });
                    Assert(store.ReadStreamState("quotes").ConnectionEpoch == 5 && store.ReadAccountLatest().ConnectionEpoch == 5, "new_epoch_latest_not_reset");
                    AssertThrows<InvalidDataException>(delegate { store.EnqueueOutboxMessage(5, NewOutbox("message-1", 5, "signal", "{\"n\":1}", now)); }, "outbox_epoch_conflict_silently_ignored");
                    AssertThrows<InvalidDataException>(delegate
                    {
                        store.UpsertStreamState(4, new StreamStateRecord
                        {
                            Resource = "quotes",
                            ConnectionEpoch = 4,
                            Revision = "old",
                            ObservedAtUtcMsc = now + 2,
                            Status = "live"
                        });
                    }, "old_epoch_stream_write_accepted");
                    AssertThrows<InvalidDataException>(delegate { store.AckOutboxMessage(4, "message-1", now + 5); }, "old_epoch_outbox_ack_accepted");
                }
                using (ProfileDataStore reopened = new ProfileDataStore(databasePath, "profile-v2", "terminal-v2", "mt5", "Demo", "10001", 5))
                {
                    Assert(reopened.ReadStreamState("quotes").ConnectionEpoch == 5, "v2_reopen_stream_missing");
                    Assert(reopened.ReadAccountLatest().ConnectionEpoch == 5, "v2_reopen_account_missing");
                    Assert(reopened.ReadInstrumentCache("XAUUSD") != null, "v2_reopen_instrument_missing");
                    Assert(reopened.ReadPendingOrdersLatest().Count == 0, "v2_reopen_stale_pending_orders_exposed");
                    Assert(reopened.ReadOutboxMessage("message-1").AckedAtUtcMsc.HasValue, "v2_reopen_outbox_missing");
                    Assert(reopened.ReadMaintenanceState().CleanupCursor == 6, "v2_reopen_maintenance_missing");
                }

                using (ProfileDataStore isolated = new ProfileDataStore(isolatedDatabasePath, "profile-isolated", "terminal-v2", "mt5", "Demo", "10001", 1))
                {
                    isolated.UpsertStreamState(1, new StreamStateRecord
                    {
                        Resource = "quotes",
                        ConnectionEpoch = 1,
                        Revision = "isolated",
                        ObservedAtUtcMsc = now,
                        Status = "live"
                    });
                    Assert(isolated.ReadStreamState("quotes").Revision == "isolated", "isolated_profile_stream_missing");
                }
            }
            finally
            {
                if (Directory.Exists(testRoot))
                {
                    Directory.Delete(testRoot, true);
                }
            }
        }

        private static InstrumentCacheRecord NewInstrument(string symbol, long observedAtUtcMsc, string revision)
        {
            return new InstrumentCacheRecord
            {
                Symbol = symbol,
                TerminalBuild = 100,
                SpecRevision = revision,
                ObservedAtUtcMsc = observedAtUtcMsc,
                LastAccessedUtcMsc = observedAtUtcMsc,
                ExpiresAtUtcMsc = observedAtUtcMsc + 600000,
                FactJson = "{\"symbol\":\"" + symbol + "\"}"
            };
        }

        private static PositionLatestRecord NewPosition(string ticket, long observedAtUtcMsc, string revision, string symbol)
        {
            return NewPositionForEpoch(ticket, observedAtUtcMsc, revision, symbol, 4);
        }

        private static PositionLatestRecord NewPositionForEpoch(string ticket, long observedAtUtcMsc, string revision, string symbol, long epoch)
        {
            return new PositionLatestRecord
            {
                Ticket = ticket,
                ConnectionEpoch = epoch,
                Revision = revision,
                ObservedAtUtcMsc = observedAtUtcMsc,
                Symbol = symbol,
                Direction = "buy",
                Volume = 0.1m,
                OpenPrice = 1.1m,
                StopLoss = 1.0m,
                TakeProfit = 1.2m,
                CurrentPrice = 1.15m,
                Profit = 0.5m,
                FactJson = "{\"ticket\":\"" + ticket + "\"}"
            };
        }

        private static PendingOrderLatestRecord NewPendingOrder(string ticket, long observedAtUtcMsc, string revision)
        {
            return NewPendingOrderForEpoch(ticket, observedAtUtcMsc, revision, 4);
        }

        private static PendingOrderLatestRecord NewPendingOrderForEpoch(string ticket, long observedAtUtcMsc, string revision, long epoch)
        {
            return new PendingOrderLatestRecord
            {
                Ticket = ticket,
                ConnectionEpoch = epoch,
                Revision = revision,
                ObservedAtUtcMsc = observedAtUtcMsc,
                Symbol = "XAUUSD",
                OrderType = "limit",
                Direction = "buy",
                Volume = 0.1m,
                RequestedPrice = 1.1m,
                StopLoss = 1.0m,
                TakeProfit = 1.2m,
                FactJson = "{\"ticket\":\"" + ticket + "\"}"
            };
        }

        private static SyncJobRecord NewSyncJob(string jobId, string resource, long nowUtcMsc, string revision)
        {
            return NewSyncJobForEpoch(jobId, resource, nowUtcMsc, revision, 4);
        }

        private static SyncJobRecord NewSyncJobForEpoch(string jobId, string resource, long nowUtcMsc, string revision, long epoch)
        {
            return new SyncJobRecord
            {
                JobId = jobId,
                ConnectionEpoch = epoch,
                Resource = resource,
                ScopeKey = "XAUUSD|M5",
                RangeStartUtcMsc = nowUtcMsc,
                RangeEndUtcMsc = nowUtcMsc + 600000,
                Cursor = revision,
                State = "queued",
                Attempt = 0,
                NextAttemptAtUtcMsc = nowUtcMsc,
                CreatedAtUtcMsc = nowUtcMsc,
                UpdatedAtUtcMsc = nowUtcMsc
            };
        }

        private static OutboxMessageRecord NewOutbox(string messageId, long epoch, string kind, string payload, long nowUtcMsc)
        {
            return new OutboxMessageRecord
            {
                MessageId = messageId,
                ConnectionEpoch = epoch,
                MessageKind = kind,
                PayloadJson = payload,
                Priority = 5,
                NextAttemptAtUtcMsc = nowUtcMsc,
                Attempt = 0,
                CreatedAtUtcMsc = nowUtcMsc
            };
        }

        private static void TestSqliteProfileDataCleanupV2()
        {
            string testRoot = Path.Combine(Path.GetTempPath(), "liangjian-bridge-v4-cleanup-v2-tests", Guid.NewGuid().ToString("N"));
            string databasePath = Path.Combine(testRoot, "profile.db");
            const long now = 2000000000000;
            long old = now - (400L * 24L * 60L * 60L * 1000L);
            try
            {
                using (ProfileDataStore store = new ProfileDataStore(databasePath, "profile-clean-v2", "terminal-clean-v2", "mt5", "Demo", "20003", 2))
                {
                    store.UpsertInstrumentCache(2, new InstrumentCacheRecord
                    {
                        Symbol = "OLD",
                        TerminalBuild = 100,
                        SpecRevision = "old",
                        ObservedAtUtcMsc = old,
                        LastAccessedUtcMsc = now - (31L * 24L * 60L * 60L * 1000L),
                        ExpiresAtUtcMsc = now - 1,
                        FactJson = "{\"old\":true}"
                    });
                    store.UpsertInstrumentCache(2, NewInstrument("KEEP", now, "keep"));
                    store.UpsertAccountLatest(2, new AccountLatestRecord
                    {
                        ConnectionEpoch = 2,
                        Revision = "old",
                        AccountNumber = "20003",
                        Currency = "USD",
                        Balance = 1m,
                        FactJson = "{\"old\":true}",
                        ObservedAtUtcMsc = old
                    });
                    Assert(store.ReplacePositionsSnapshot(2, "old", old, new List<PositionLatestRecord> { NewPositionForEpoch("1", old, "old", "XAUUSD", 2) }), "cleanup_old_positions_not_written");
                    Assert(store.ReplacePendingOrdersSnapshot(2, "old", old, new List<PendingOrderLatestRecord> { NewPendingOrderForEpoch("2", old, "old", 2) }), "cleanup_old_orders_not_written");

                    SyncJobRecord oldJob = NewSyncJobForEpoch("old-job", "market.candles", old, "old", 2);
                    Assert(store.EnqueueSyncJob(2, oldJob), "cleanup_old_job_not_queued");
                    Assert(store.ClaimSyncJob(2, "cleanup-worker", old + 1, 100) != null, "cleanup_old_job_not_claimed");
                    Assert(store.CompleteSyncJob(2, "old-job", "cleanup-worker", old + 2), "cleanup_old_job_not_completed");

                    OutboxMessageRecord acked = NewOutbox("acked-old", 2, "signal", "{\"old\":true}", old);
                    OutboxMessageRecord unacked = NewOutbox("unacked-old", 2, "signal", "{\"old\":false}", old);
                    Assert(store.EnqueueOutboxMessage(2, acked) && store.EnqueueOutboxMessage(2, unacked), "cleanup_outbox_not_queued");
                    Assert(store.AckOutboxMessage(2, acked.MessageId, old + 2), "cleanup_outbox_not_acked");

                    store.RebindEpoch(3);
                    Assert(store.ReadAccountLatest() == null && store.ReadPositionsLatest().Count == 0 && store.ReadPendingOrdersLatest().Count == 0, "stale_epoch_projection_exposed");
                    CacheCleanupResult result = store.Cleanup(3, now, 500);
                    Assert(result.InstrumentsDeleted == 1, "expired_instrument_not_cleaned");
                    Assert(result.StaleProjectionsDeleted >= 3, "stale_projections_not_cleaned");
                    Assert(result.SyncJobsDeleted == 1, "old_sync_job_not_cleaned");
                    Assert(result.OutboxMessagesDeleted == 1, "acked_outbox_not_cleaned");
                    Assert(result.TotalDeleted <= 500, "v2_cleanup_batch_exceeded_500");
                    Assert(store.ReadInstrumentCache("KEEP") != null && store.ReadInstrumentCache("OLD") == null, "instrument_retention_rule_wrong");
                    Assert(store.ReadOutboxMessage("unacked-old") != null && store.ReadOutboxMessage("acked-old") == null, "outbox_ack_retention_rule_wrong");
                    MaintenanceStateRecord maintenance = store.ReadMaintenanceState();
                    Assert(maintenance != null && maintenance.LastCleanupAtUtcMsc == now && maintenance.CleanupCursor == 1, "cleanup_maintenance_state_missing");
                }
            }
            finally
            {
                if (Directory.Exists(testRoot))
                {
                    Directory.Delete(testRoot, true);
                }
            }
        }

        private static void TestSqliteProfileDataCleanup()
        {
            string testRoot = Path.Combine(Path.GetTempPath(), "liangjian-bridge-v4-cleanup-tests", Guid.NewGuid().ToString("N"));
            string databasePath = Path.Combine(testRoot, "profile.db");
            const long now = 2000000000000;
            long oldCandleTime = now - (181L * 24L * 60L * 60L * 1000L);
            long oldHistoryTime = now - (366L * 24L * 60L * 60L * 1000L);
            try
            {
                using (ProfileDataStore store = new ProfileDataStore(databasePath, "profile-clean", "terminal-clean", "mt4", "Demo", "20002", 1))
                {
                    CandleRecord protectedCandle = NewCandle(oldCandleTime, now - (40L * 24L * 60L * 60L * 1000L), "cleanup-rev");
                    store.UpsertClosedCandle(1, protectedCandle);
                    store.UpsertCoverage(1, new CoverageRangeRecord
                    {
                        Resource = "market.candles",
                        ScopeKey = ProfileDataStore.CandleScopeKey("XAUUSD", "M5"),
                        RangeStartUtcMsc = oldCandleTime,
                        RangeEndUtcMsc = oldCandleTime + 600000,
                        Completeness = "complete",
                        SourceRevision = "cleanup-rev",
                        UpdatedAtUtcMsc = now
                    });
                    store.UpsertCoverage(1, new CoverageRangeRecord
                    {
                        Resource = "market.candles",
                        ScopeKey = ProfileDataStore.CandleScopeKey("EURUSD", "M5"),
                        RangeStartUtcMsc = oldCandleTime,
                        RangeEndUtcMsc = oldCandleTime + 600000,
                        Completeness = "complete",
                        SourceRevision = "unrelated-rev",
                        UpdatedAtUtcMsc = now
                    });
                    store.CreateQuerySnapshot(1, new QuerySnapshotRecord
                    {
                        SnapshotId = "cleanup-snapshot",
                        Resource = "market.candles",
                        ScopeKey = ProfileDataStore.CandleScopeKey("XAUUSD", "M5"),
                        QueryHash = "sha256:cleanup",
                        FrozenRevision = "cleanup-rev",
                        RangeStartUtcMsc = oldCandleTime,
                        RangeEndUtcMsc = oldCandleTime + 600000,
                        CreatedAtUtcMsc = now - 1000,
                        ExpiresAtUtcMsc = now + 1000
                    });
                    store.CreateQuerySnapshot(1, new QuerySnapshotRecord
                    {
                        SnapshotId = "retention-expired-snapshot",
                        Resource = "market.candles",
                        ScopeKey = ProfileDataStore.CandleScopeKey("EURUSD", "M5"),
                        QueryHash = "sha256:retention-expired",
                        FrozenRevision = "old-revision",
                        RangeStartUtcMsc = oldCandleTime,
                        RangeEndUtcMsc = oldCandleTime + 600000,
                        CreatedAtUtcMsc = now - (10L * 24L * 60L * 60L * 1000L),
                        ExpiresAtUtcMsc = now - (8L * 24L * 60L * 60L * 1000L)
                    });
                    HistoryItemRecord unacked = NewHistory("orders", "unacked", oldHistoryTime, "unacked-rev", "unacked");
                    store.UpsertHistoryItem(1, unacked);
                    HistoryItemRecord acked = NewHistory("orders", "acked", oldHistoryTime, "cleanup-rev", "acked");
                    store.UpsertHistoryItem(1, acked);
                    store.RecordServerCoverageAck(1, new ServerCoverageAckRecord
                    {
                        Resource = "history.orders",
                        ScopeKey = "orders",
                        RangeStartUtcMsc = oldHistoryTime - 1,
                        RangeEndUtcMsc = oldHistoryTime + 1,
                        SourceRevision = "cleanup-rev",
                        AckedAtUtcMsc = now
                    });
                    store.UpsertCoverage(1, new CoverageRangeRecord
                    {
                        Resource = "history.deals",
                        ScopeKey = "deals",
                        RangeStartUtcMsc = oldHistoryTime - 1,
                        RangeEndUtcMsc = oldHistoryTime + 1,
                        Completeness = "complete",
                        SourceRevision = "deals-rev",
                        UpdatedAtUtcMsc = now
                    });

                    CacheCleanupResult protectedResult = store.Cleanup(1, now, 800);
                    Assert(protectedResult.QuerySnapshotsDeleted == 1 && protectedResult.CandlesDeleted == 0 && protectedResult.HistoryItemsDeleted == 1, "snapshot_retention_or_active_snapshot_rule_wrong");
                    Assert(store.ReadHistory("orders", oldHistoryTime - 1, oldHistoryTime + 1, 10, null).Items.Count == 1, "unacked_history_missing");

                    store.CreateQuerySnapshot(1, new QuerySnapshotRecord
                    {
                        SnapshotId = "expired-snapshot",
                        Resource = "market.candles",
                        ScopeKey = ProfileDataStore.CandleScopeKey("XAUUSD", "M5"),
                        QueryHash = "sha256:expired",
                        FrozenRevision = "cleanup-rev",
                        RangeStartUtcMsc = oldCandleTime,
                        RangeEndUtcMsc = oldCandleTime + 600000,
                        CreatedAtUtcMsc = now - 3000,
                        ExpiresAtUtcMsc = now - 2000
                    });
                    CacheCleanupResult result = store.Cleanup(1, now + 2000, 800);
                    Assert(result.CandlesDeleted == 1 && result.HistoryItemsDeleted == 0 && result.TotalDeleted <= 500, "cleanup_ack_or_expiry_rule_wrong");
                    Assert(store.ReadHistory("orders", oldHistoryTime - 1, oldHistoryTime + 1, 10, null).Items.Count == 1, "unacked_history_cleaned");
                    IList<CoverageRangeRecord> coverage = store.ReadCoverage("market.candles", ProfileDataStore.CandleScopeKey("XAUUSD", "M5"));
                    Assert(coverage.Count == 1 && coverage[0].Completeness != "complete", "coverage_still_complete_after_delete");
                    IList<CoverageRangeRecord> unrelatedCandleCoverage = store.ReadCoverage("market.candles", ProfileDataStore.CandleScopeKey("EURUSD", "M5"));
                    Assert(unrelatedCandleCoverage.Count == 1 && unrelatedCandleCoverage[0].Completeness == "complete", "unrelated_candle_coverage_invalidated");
                    IList<CoverageRangeRecord> unrelatedHistoryCoverage = store.ReadCoverage("history.deals", "deals");
                    Assert(unrelatedHistoryCoverage.Count == 1 && unrelatedHistoryCoverage[0].Completeness == "complete", "unrelated_history_coverage_invalidated");

                    for (int i = 0; i < 501; i++)
                    {
                        CandleRecord candidate = NewCandle(oldCandleTime - ((i + 1) * 600000L), now - (40L * 24L * 60L * 60L * 1000L), "batch-rev");
                        candidate.Symbol = "XAGUSD";
                        store.UpsertClosedCandle(1, candidate);
                    }
                    CacheCleanupResult batch = store.Cleanup(1, now, 800);
                    Assert(batch.TotalDeleted <= 500, "cleanup_batch_exceeded_500");
                }
            }
            finally
            {
                if (Directory.Exists(testRoot))
                {
                    Directory.Delete(testRoot, true);
                }
            }
        }

        private static void TestSqliteLedgerDataStoreWriteGate()
        {
            string testRoot = Path.Combine(Path.GetTempPath(), "liangjian-bridge-v4-write-gate-tests", Guid.NewGuid().ToString("N"));
            string databasePath = Path.Combine(testRoot, "shared.db");
            string ledgerFirstDatabasePath = Path.Combine(testRoot, "ledger-first.db");
            try
            {
                using (ProfileDataStore store = new ProfileDataStore(databasePath, "profile-gate", "terminal-gate", "mt5", "Demo", "10001", 1))
                using (CommandLedger ledger = new CommandLedger(databasePath))
                {
                    for (int i = 0; i < 20; i++)
                    {
                        CandleRecord candle = NewCandle(1788307200000 + (i * 600000L), 1788307200000 + i, "gate-rev");
                        store.UpsertClosedCandle(1, candle);
                        CommandAcceptance acceptance = ledger.Accept("profile-gate", "command-gate-" + i, "idempotency-gate-" + i, "order.place", "sha256:gate-" + i, 1788307200000 + i);
                        Assert(!acceptance.Duplicate, "write_gate_command_duplicate");
                    }
                    Assert(store.ReadCandles("XAUUSD", "M5", 1788307199000, 1788320000000, 100, null).Items.Count == 20, "write_gate_candles_missing");
                    Assert(ledger.ReadState("profile-gate", "idempotency-gate-19") == "recorded", "write_gate_ledger_missing");
                }
                using (CommandLedger ledgerFirst = new CommandLedger(ledgerFirstDatabasePath))
                using (ProfileDataStore storeSecond = new ProfileDataStore(ledgerFirstDatabasePath, "profile-ledger-first", "terminal-ledger-first", "mt4", "Demo", "10002", 1))
                {
                    CommandAcceptance acceptance = ledgerFirst.Accept("profile-ledger-first", "command-ledger-first", "idempotency-ledger-first", "order.place", "sha256:ledger-first", 1788307200000);
                    Assert(!acceptance.Duplicate && storeSecond.ReadSchemaMigrations().Count == 2, "ledger_first_schema_not_shared");
                    storeSecond.UpsertClosedCandle(1, NewCandle(1788307200000, 1788307200001, "ledger-first"));
                    Assert(storeSecond.ReadCandles("XAUUSD", "M5", 1788307199000, 1788307201000, 10, null).Items.Count == 1, "ledger_first_store_write_failed");
                }
            }
            finally
            {
                if (Directory.Exists(testRoot))
                {
                    Directory.Delete(testRoot, true);
                }
            }
        }

        private static CandleRecord NewCandle(long openTimeUtcMsc, long observedAtUtcMsc, string revision)
        {
            return new CandleRecord
            {
                Symbol = "XAUUSD",
                Timeframe = "M5",
                OpenTimeUtcMsc = openTimeUtcMsc,
                Open = 1.0,
                High = 1.5,
                Low = 0.5,
                Close = 1.2,
                TickVolume = 10,
                RealVolume = 0,
                Spread = 0.2,
                Closed = true,
                SourceRevision = revision,
                ObservedAtUtcMsc = observedAtUtcMsc,
                LastAccessedUtcMsc = observedAtUtcMsc
            };
        }

        private static HistoryItemRecord NewHistory(string kind, string id, long eventTimeUtcMsc, string revision, string marker)
        {
            return new HistoryItemRecord
            {
                ItemKind = kind,
                ItemId = id,
                EventTimeUtcMsc = eventTimeUtcMsc,
                Ticket = "100",
                OrderId = "200",
                PositionId = "300",
                Symbol = "XAUUSD",
                FundsKind = null,
                Amount = 1.25m,
                FactJson = "{\"marker\":\"" + marker + "\"}",
                SourceRevision = revision,
                ObservedAtUtcMsc = eventTimeUtcMsc,
                LastAccessedUtcMsc = eventTimeUtcMsc
            };
        }

        private static void TestVersionPointer()
        {
            string root = Path.Combine(Path.GetTempPath(), "bridge-v4-pointer-test");
            string executable = VersionPointer.ResolveExecutable(root, "4.0.0");
            Assert(executable.EndsWith(Path.Combine("versions", "4.0.0", "LiangjianBridge.exe"), StringComparison.OrdinalIgnoreCase), "version_pointer_wrong");
            AssertThrows<InvalidDataException>(delegate { VersionPointer.ResolveExecutable(root, "..\\escape"); }, "version_pointer_escape_accepted");
        }

        private static void TestVersionActivationRollback()
        {
            string root = Path.Combine(Path.GetTempPath(), "liangjian-bridge-v4-version-tests", Guid.NewGuid().ToString("N"));
            try
            {
                string versions = Path.Combine(root, "versions");
                string oldDirectory = Path.Combine(versions, "4.0.0.0");
                string newDirectory = Path.Combine(versions, "4.0.1.0");
                Directory.CreateDirectory(oldDirectory);
                Directory.CreateDirectory(newDirectory);
                File.WriteAllBytes(Path.Combine(oldDirectory, "LiangjianBridge.exe"), new byte[] { 1 });
                File.WriteAllBytes(Path.Combine(newDirectory, "LiangjianBridge.exe"), new byte[] { 2 });
                File.WriteAllText(Path.Combine(versions, "current.txt"), "4.0.0.0");

                Assert(VersionPointer.Activate(root, "4.0.1.0") == "4.0.0.0", "activation_previous_wrong");
                Assert(VersionPointer.ReadCurrentVersion(root) == "4.0.1.0", "activation_current_wrong");
                Assert(File.ReadAllText(Path.Combine(versions, "previous.txt")) == "4.0.0.0", "activation_previous_pointer_wrong");
                Assert(VersionPointer.ReadPendingActivation(root) == "4.0.1.0", "activation_pending_pointer_missing");
                Assert(VersionPointer.Rollback(root, "4.0.1.0") == "4.0.0.0", "rollback_result_wrong");
                Assert(VersionPointer.ReadCurrentVersion(root) == "4.0.0.0", "rollback_current_wrong");
                Assert(VersionPointer.ReadPendingActivation(root) == null, "rollback_pending_pointer_remained");
                AssertThrows<InvalidDataException>(delegate { VersionPointer.Rollback(root, "4.0.1.0"); }, "rollback_mismatch_accepted");
            }
            finally
            {
                if (Directory.Exists(root))
                {
                    Directory.Delete(root, true);
                }
            }
        }

        private static void TestLauncherHealthFailureRollback()
        {
            string root = Path.Combine(Path.GetTempPath(), "liangjian-bridge-v4-launcher-tests", Guid.NewGuid().ToString("N"));
            try
            {
                string versions = Path.Combine(root, "versions");
                string oldDirectory = Path.Combine(versions, "4.0.0.0");
                string newDirectory = Path.Combine(versions, "4.0.1.0");
                Directory.CreateDirectory(oldDirectory);
                Directory.CreateDirectory(newDirectory);
                string oldExecutable = Path.Combine(oldDirectory, "LiangjianBridge.exe");
                string newExecutable = Path.Combine(newDirectory, "LiangjianBridge.exe");
                File.WriteAllBytes(oldExecutable, new byte[] { 1 });
                File.WriteAllBytes(newExecutable, new byte[] { 2 });
                File.WriteAllText(Path.Combine(versions, "current.txt"), "4.0.0.0");
                string launched = null;

                LauncherActivationResult result = LauncherActivation.ActivateAndLaunch(root, "4.0.1.0",
                    delegate(string executable) { return false; },
                    delegate(string executable) { launched = executable; });

                Assert(result.RolledBack, "launcher_health_failure_not_rolled_back");
                Assert(result.ActiveVersion == "4.0.0.0", "launcher_rollback_version_wrong");
                Assert(launched == oldExecutable, "launcher_previous_version_not_started");
                Assert(VersionPointer.ReadCurrentVersion(root) == "4.0.0.0", "launcher_pointer_not_rolled_back");
            }
            finally
            {
                if (Directory.Exists(root))
                {
                    Directory.Delete(root, true);
                }
            }
        }

        private static void TestLauncherInterruptedActivation()
        {
            string root = Path.Combine(Path.GetTempPath(), "liangjian-bridge-v4-interrupted-tests", Guid.NewGuid().ToString("N"));
            try
            {
                string versions = Path.Combine(root, "versions");
                string oldDirectory = Path.Combine(versions, "4.0.0.0");
                string newDirectory = Path.Combine(versions, "4.0.1.0");
                Directory.CreateDirectory(oldDirectory);
                Directory.CreateDirectory(newDirectory);
                string oldExecutable = Path.Combine(oldDirectory, "LiangjianBridge.exe");
                string newExecutable = Path.Combine(newDirectory, "LiangjianBridge.exe");
                File.WriteAllBytes(oldExecutable, new byte[] { 1 });
                File.WriteAllBytes(newExecutable, new byte[] { 2 });
                File.WriteAllText(Path.Combine(versions, "current.txt"), "4.0.0.0");

                VersionPointer.Activate(root, "4.0.1.0");
                Assert(VersionPointer.ReadCurrentVersion(root) == "4.0.1.0", "interrupted_activation_not_prepared");
                string launched = null;
                LauncherActivationResult result = LauncherActivation.ActivateAndLaunch(root, "4.0.1.0",
                    delegate(string executable) { return false; },
                    delegate(string executable) { launched = executable; });

                Assert(result.RolledBack, "interrupted_activation_not_rolled_back");
                Assert(result.ActiveVersion == "4.0.0.0", "interrupted_activation_rollback_wrong");
                Assert(launched == oldExecutable, "interrupted_activation_previous_not_started");
                Assert(VersionPointer.ReadPendingActivation(root) == null, "interrupted_activation_pending_remained");
            }
            finally
            {
                if (Directory.Exists(root))
                {
                    Directory.Delete(root, true);
                }
            }
        }

        private static void AddSqlParameter(SQLiteCommand command, string name, object value)
        {
            SQLiteParameter parameter = command.CreateParameter();
            parameter.ParameterName = name;
            parameter.Value = value;
            command.Parameters.Add(parameter);
        }

        private static void Run(string name, Action test)
        {
            try
            {
                test();
                Console.WriteLine("PASS " + name);
            }
            catch (Exception error)
            {
                failures++;
                Console.WriteLine("FAIL " + name + " " + error.Message);
            }
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition)
            {
                throw new InvalidOperationException(message);
            }
        }

        private static void AssertThrows<T>(Action action, string message) where T : Exception
        {
            try
            {
                action();
            }
            catch (T)
            {
                return;
            }
            throw new InvalidOperationException(message);
        }
    }
}
