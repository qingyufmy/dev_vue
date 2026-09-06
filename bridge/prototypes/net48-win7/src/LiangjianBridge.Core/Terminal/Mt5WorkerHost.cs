using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.Terminal
{
    /// <summary>
    /// Explicit configuration for one already-running MT5 terminal.
    /// No executable or script is discovered through PATH by this class.
    /// </summary>
    public sealed class Mt5WorkerConfiguration
    {
        private static long epochSeed = DateTime.UtcNow.Ticks;

        public Mt5WorkerConfiguration(
            string pythonExecutablePath,
            string workerScriptPath,
            string terminalPath,
            string terminalInstanceId,
            string brokerServer,
            string login)
            : this(pythonExecutablePath, workerScriptPath, terminalPath, terminalInstanceId,
                brokerServer, login, 0, "live", null)
        {
        }

        public Mt5WorkerConfiguration(
            string pythonExecutablePath,
            string workerScriptPath,
            string terminalPath,
            string terminalInstanceId,
            string brokerServer,
            string login,
            long connectionEpoch,
            string role,
            string diagnosticPath)
        {
            PythonExecutablePath = RequirePath(pythonExecutablePath, "pythonExecutablePath");
            WorkerScriptPath = RequirePath(workerScriptPath, "workerScriptPath");
            TerminalPath = RequirePath(terminalPath, "terminalPath");
            TerminalInstanceId = RequireText(terminalInstanceId, 191, "terminalInstanceId");
            BrokerServer = RequireText(brokerServer, 128, "brokerServer");
            Login = RequireText(login, 64, "login");
            Role = string.IsNullOrEmpty(role) ? "live" : RequireText(role, 16, "role").ToLowerInvariant();
            if (Role != "live" && Role != "archive")
            {
                throw new ArgumentException("bridge_mt5_worker_role_invalid", "role");
            }
            ConnectionEpoch = connectionEpoch > 0
                ? connectionEpoch
                : Interlocked.Increment(ref epochSeed);
            if (ConnectionEpoch < 1)
            {
                throw new ArgumentException("bridge_mt5_worker_epoch_invalid", "connectionEpoch");
            }
            DiagnosticPath = string.IsNullOrWhiteSpace(diagnosticPath)
                ? string.Empty
                : RequirePath(diagnosticPath, "diagnosticPath");
        }

        public string PythonExecutablePath { get; private set; }
        public string WorkerScriptPath { get; private set; }
        public string TerminalPath { get; private set; }
        public string TerminalInstanceId { get; private set; }
        public string BrokerServer { get; private set; }
        public string Login { get; private set; }
        public long ConnectionEpoch { get; private set; }
        public string Role { get; private set; }
        public string DiagnosticPath { get; private set; }

        internal IDictionary<string, object> RoutePayload()
        {
            return new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "terminal_instance_id", TerminalInstanceId },
                { "platform", "mt5" },
                { "account_ref", new Dictionary<string, object>(StringComparer.Ordinal)
                    {
                        { "broker_server", BrokerServer },
                        { "login", Login }
                    }
                },
                { "connection_epoch", ConnectionEpoch }
            };
        }

        private static string RequirePath(string value, string name)
        {
            if (string.IsNullOrWhiteSpace(value) || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            {
                throw new ArgumentException("bridge_mt5_worker_path_invalid", name);
            }
            return Path.GetFullPath(value);
        }

        private static string RequireText(string value, int maximumLength, string name)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > maximumLength
                || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            {
                throw new ArgumentException("bridge_mt5_worker_value_invalid", name);
            }
            return value;
        }
    }

    public interface IMt5WorkerRequestHost
    {
        Mt5WorkerResponse Request(string terminalInstanceId, string brokerServer, string login,
            string expectedRole, string operation, IDictionary<string, object> payload);
    }

    public sealed class Mt5WorkerHost : IDisposable, IMt5WorkerRequestHost
    {
        public const int DefaultStartTimeoutMilliseconds = 30000;
        public const int DefaultRequestTimeoutMilliseconds = 15000;

        private readonly object stateLock = new object();
        private readonly Dictionary<string, Mt5WorkerSession> sessions =
            new Dictionary<string, Mt5WorkerSession>(StringComparer.Ordinal);
        private readonly string pipePrefix;
        private readonly int startTimeoutMilliseconds;
        private readonly int requestTimeoutMilliseconds;
        private bool disposed;

        public Mt5WorkerHost()
            : this("LiangjianBridgeV4.Mt5", DefaultStartTimeoutMilliseconds,
                DefaultRequestTimeoutMilliseconds)
        {
        }

        public Mt5WorkerHost(string pipePrefix)
            : this(pipePrefix, DefaultStartTimeoutMilliseconds, DefaultRequestTimeoutMilliseconds)
        {
        }

        // The timeout overload keeps offline lifecycle tests deterministic.
        public Mt5WorkerHost(string pipePrefix, int startTimeoutMilliseconds,
            int requestTimeoutMilliseconds)
        {
            if (string.IsNullOrWhiteSpace(pipePrefix) || pipePrefix.Length > 80)
            {
                throw new ArgumentException("bridge_mt5_worker_pipe_prefix_invalid", "pipePrefix");
            }
            ValidateTimeout(startTimeoutMilliseconds, "startTimeoutMilliseconds");
            ValidateTimeout(requestTimeoutMilliseconds, "requestTimeoutMilliseconds");
            for (int index = 0; index < pipePrefix.Length; index++)
            {
                char value = pipePrefix[index];
                if (!char.IsLetterOrDigit(value) && value != '-' && value != '_' && value != '.')
                {
                    throw new ArgumentException("bridge_mt5_worker_pipe_prefix_invalid", "pipePrefix");
                }
            }
            this.pipePrefix = pipePrefix;
            this.startTimeoutMilliseconds = startTimeoutMilliseconds;
            this.requestTimeoutMilliseconds = requestTimeoutMilliseconds;
        }

        public event EventHandler< Mt5WorkerSessionEventArgs > SessionDisconnected;

        public IList<Mt5WorkerSessionSnapshot> Snapshot()
        {
            lock (stateLock)
            {
                List<Mt5WorkerSessionSnapshot> result = new List<Mt5WorkerSessionSnapshot>(sessions.Count);
                foreach (Mt5WorkerSession session in sessions.Values)
                {
                    result.Add(session.Snapshot());
                }
                result.Sort(delegate(Mt5WorkerSessionSnapshot left, Mt5WorkerSessionSnapshot right)
                {
                    return string.Compare(left.TerminalInstanceId, right.TerminalInstanceId, StringComparison.Ordinal);
                });
                return result;
            }
        }

        public Mt5WorkerSession Connect(Mt5WorkerConfiguration configuration)
        {
            if (configuration == null)
            {
                throw new ArgumentNullException("configuration");
            }
            lock (stateLock)
            {
                EnsureOpen();
                if (sessions.ContainsKey(configuration.TerminalInstanceId))
                {
                    throw new InvalidOperationException("bridge_mt5_worker_session_exists");
                }
            }

            string pipeName = pipePrefix + "." + Guid.NewGuid().ToString("N");
            Mt5WorkerSession session = new Mt5WorkerSession(configuration, pipeName,
                startTimeoutMilliseconds, requestTimeoutMilliseconds);
            session.Disconnected += OnSessionDisconnected;
            try
            {
                session.Start();
                lock (stateLock)
                {
                    EnsureOpen();
                    if (!session.IsConnected)
                    {
                        throw new InvalidOperationException("bridge_mt5_worker_process_exited");
                    }
                    if (sessions.ContainsKey(configuration.TerminalInstanceId))
                    {
                        throw new InvalidOperationException("bridge_mt5_worker_session_exists");
                    }
                    sessions.Add(configuration.TerminalInstanceId, session);
                }
                return session;
            }
            catch
            {
                session.Dispose();
                throw;
            }
        }

        public Mt5WorkerResponse Request(
            string terminalInstanceId,
            string brokerServer,
            string login,
            string expectedRole,
            string operation,
            IDictionary<string, object> payload)
        {
            Mt5WorkerSession session;
            lock (stateLock)
            {
                EnsureOpen();
                if (string.IsNullOrEmpty(terminalInstanceId)
                    || !sessions.TryGetValue(terminalInstanceId, out session))
                {
                    throw new InvalidOperationException("bridge_mt5_worker_session_not_found");
                }
                if (session.BrokerServer != brokerServer || session.Login != login
                    || session.Role != expectedRole)
                {
                    throw new InvalidOperationException("bridge_mt5_worker_session_route_mismatch");
                }
            }
            return session.Request(operation, payload);
        }

        public void Disconnect(string terminalInstanceId)
        {
            Mt5WorkerSession session = null;
            lock (stateLock)
            {
                if (terminalInstanceId != null)
                {
                    sessions.TryGetValue(terminalInstanceId, out session);
                }
            }
            if (session != null)
            {
                session.Dispose();
                lock (stateLock)
                {
                    Mt5WorkerSession current;
                    if (sessions.TryGetValue(terminalInstanceId, out current) && ReferenceEquals(current, session))
                        sessions.Remove(terminalInstanceId);
                }
            }
        }

        public void Dispose()
        {
            List<Mt5WorkerSession> active;
            lock (stateLock)
            {
                if (disposed && sessions.Count == 0)
                {
                    return;
                }
                disposed = true;
                active = new List<Mt5WorkerSession>(sessions.Values);
            }
            List<Exception> errors = new List<Exception>();
            foreach (Mt5WorkerSession session in active)
            {
                try { Disconnect(session.TerminalInstanceId); }
                catch (Exception error) { errors.Add(error); }
            }
            if (errors.Count != 0) throw new AggregateException("bridge_mt5_host_close_failed", errors);
        }

        private void OnSessionDisconnected(object sender, Mt5WorkerSessionEventArgs eventArgs)
        {
            Mt5WorkerSession session = sender as Mt5WorkerSession;
            if (session == null)
            {
                return;
            }
            lock (stateLock)
            {
                Mt5WorkerSession current;
                if (sessions.TryGetValue(session.TerminalInstanceId, out current)
                    && object.ReferenceEquals(current, session))
                {
                    sessions.Remove(session.TerminalInstanceId);
                }
            }
            EventHandler<Mt5WorkerSessionEventArgs> handler = SessionDisconnected;
            if (handler != null)
            {
                handler(this, eventArgs);
            }
        }

        private void EnsureOpen()
        {
            if (disposed)
            {
                throw new ObjectDisposedException("Mt5WorkerHost");
            }
        }

        private static void ValidateTimeout(int value, string name)
        {
            if (value < 100 || value > 600000)
            {
                throw new ArgumentOutOfRangeException(name);
            }
        }
    }

    public sealed class Mt5WorkerSession : IDisposable
    {
        private static readonly HashSet<string> LiveCapabilities = new HashSet<string>(StringComparer.Ordinal)
        {
            "snapshot", "quote", "data", "execute_command", "query_execution"
        };

        private static readonly HashSet<string> ArchiveCapabilities = new HashSet<string>(StringComparer.Ordinal)
        {
            "history_range_sync"
        };

        private static readonly HashSet<string> KnownOperations = new HashSet<string>(StringComparer.Ordinal)
        {
            "collect_snapshot", "quote", "history_sync", "history_range_sync", "data",
            "execute_command", "query_execution"
        };

        private readonly Mt5WorkerConfiguration configuration;
        private readonly string pipeName;
        private readonly int startTimeoutMilliseconds;
        private readonly int requestTimeoutMilliseconds;
        private readonly object requestLock = new object();
        private NamedPipeServerStream pipe;
        private Process process;
        private bool connected;
        private bool disposed;
        private string lastErrorCode;
        private string sessionNonce;

        internal Mt5WorkerSession(Mt5WorkerConfiguration value, string name,
            int startTimeout, int requestTimeout)
        {
            configuration = value;
            pipeName = name;
            startTimeoutMilliseconds = startTimeout;
            requestTimeoutMilliseconds = requestTimeout;
        }

        public event EventHandler<Mt5WorkerSessionEventArgs> Disconnected;

        public string TerminalInstanceId { get { return configuration.TerminalInstanceId; } }
        public string BrokerServer { get { return configuration.BrokerServer; } }
        public string Login { get { return configuration.Login; } }
        public long ConnectionEpoch { get { return configuration.ConnectionEpoch; } }
        public string Role { get { return configuration.Role; } }
        public bool IsConnected
        {
            get
            {
                lock (requestLock)
                {
                    return connected && !disposed;
                }
            }
        }
        public string LastErrorCode { get { return lastErrorCode; } }

        internal void Start()
        {
            if (!File.Exists(configuration.PythonExecutablePath)
                || !File.Exists(configuration.WorkerScriptPath)
                || !File.Exists(configuration.TerminalPath))
            {
                throw new FileNotFoundException("bridge_mt5_worker_explicit_path_missing");
            }
            pipe = CreatePipe(pipeName);
            sessionNonce = CreateNonce();
            try
            {
                StartWorkerProcess();
                WaitForConnection(pipe, startTimeoutMilliseconds);
                ValidateHello(Mt5WorkerFrameCodec.ReadJson(pipe, startTimeoutMilliseconds));
                lock (requestLock)
                {
                    if (disposed || process == null || process.HasExited)
                    {
                        throw new InvalidOperationException("bridge_mt5_worker_process_exited");
                    }
                    connected = true;
                }
            }
            catch
            {
                FailClosed("bridge_mt5_worker_start_failed", true);
                throw;
            }
        }

        public Mt5WorkerResponse Request(string operation, IDictionary<string, object> requestPayload)
        {
            return Request(operation, requestPayload, requestTimeoutMilliseconds);
        }

        public Mt5WorkerResponse Request(string operation, IDictionary<string, object> requestPayload,
            int timeoutMilliseconds)
        {
            if (string.IsNullOrWhiteSpace(operation) || !KnownOperations.Contains(operation))
            {
                throw new ArgumentException("bridge_mt5_worker_operation_invalid", "operation");
            }
            if (requestPayload == null)
            {
                throw new ArgumentNullException("requestPayload");
            }
            if (timeoutMilliseconds < 100 || timeoutMilliseconds > 600000)
            {
                throw new ArgumentOutOfRangeException("timeoutMilliseconds");
            }

            string requestId = RequestIdFor(operation, requestPayload);
            IDictionary<string, object> body = new Dictionary<string, object>(StringComparer.Ordinal);
            body.Add(operation == "execute_command" || operation == "query_execution" ? "command" : "request", requestPayload);
            IDictionary<string, object> envelope = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "ipc_v", 2 },
                { "type", "worker_request" },
                { "request_id", requestId },
                { "route", configuration.RoutePayload() },
                { "operation", operation },
                { "payload", body }
            };
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = Mt5WorkerFrameCodec.MaximumFrameBytes;
            serializer.RecursionLimit = 128;
            string json = serializer.Serialize(envelope);

            lock (requestLock)
            {
                EnsureConnected();
                try
                {
                    Mt5WorkerFrameCodec.WriteJson(pipe, json, timeoutMilliseconds);
                    Mt5WorkerResponse response = Mt5WorkerResponse.Parse(
                        Mt5WorkerFrameCodec.ReadJson(pipe, timeoutMilliseconds), configuration, requestId);
                    if (process != null && process.HasExited)
                    {
                        FailClosed("bridge_mt5_worker_process_exited", false);
                    }
                    return response;
                }
                catch
                {
                    FailClosed("bridge_mt5_worker_transport_failed", true);
                    throw;
                }
            }
        }

        public Mt5WorkerSessionSnapshot Snapshot()
        {
            return new Mt5WorkerSessionSnapshot
            {
                TerminalInstanceId = configuration.TerminalInstanceId,
                BrokerServer = configuration.BrokerServer,
                Login = configuration.Login,
                ConnectionEpoch = configuration.ConnectionEpoch,
                Role = configuration.Role,
                Connected = IsConnected,
                LastErrorCode = lastErrorCode
            };
        }

        public void Dispose()
        {
            FailClosed("bridge_mt5_worker_stopped", true, false);
        }

        private static string RequestIdFor(string operation, IDictionary<string, object> payload)
        {
            if (operation == "execute_command" || operation == "query_execution")
            {
                object raw;
                string commandId;
                if (!payload.TryGetValue("command_id", out raw)
                    || (commandId = raw as string) == null
                    || string.IsNullOrWhiteSpace(commandId)
                    || commandId.Length > 128)
                {
                    throw new InvalidDataException("bridge_mt5_worker_command_id_required");
                }
                return commandId;
            }
            return "request-" + Guid.NewGuid().ToString("N");
        }

        private void ValidateHello(string json)
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = Mt5WorkerFrameCodec.MaximumFrameBytes;
            serializer.RecursionLimit = 128;
            IDictionary<string, object> root;
            try
            {
                root = serializer.DeserializeObject(json) as IDictionary<string, object>;
            }
            catch (ArgumentException)
            {
                throw new InvalidDataException("bridge_mt5_worker_hello_invalid");
            }
            catch (InvalidOperationException)
            {
                throw new InvalidDataException("bridge_mt5_worker_hello_invalid");
            }
            RequireExactFields(root, new[]
            {
                "ipc_v", "type", "session_nonce", "worker_version", "route", "role", "capabilities"
            }, "bridge_mt5_worker_hello_fields_invalid");
            if (!ReadInt(root, "ipc_v", 2)
                || ReadText(root, "type", 32) != "worker_hello"
                || !SecureEquals(ReadText(root, "session_nonce", 128), sessionNonce)
                || ReadText(root, "worker_version", 64).Length == 0
                || ReadText(root, "role", 16) != configuration.Role)
            {
                throw new InvalidDataException("bridge_mt5_worker_hello_invalid");
            }
            ValidateRoute(ReadObject(root, "route"));
            ValidateCapabilities(ReadArray(root, "capabilities"));
        }

        private void ValidateRoute(IDictionary<string, object> route)
        {
            RequireExactFields(route, new[]
            {
                "terminal_instance_id", "platform", "account_ref", "connection_epoch"
            }, "bridge_mt5_worker_hello_route_invalid");
            if (ReadText(route, "terminal_instance_id", 191) != configuration.TerminalInstanceId
                || ReadText(route, "platform", 8) != "mt5"
                || ReadLong(route, "connection_epoch") != configuration.ConnectionEpoch)
            {
                throw new InvalidDataException("bridge_mt5_worker_hello_route_mismatch");
            }
            IDictionary<string, object> account = ReadObject(route, "account_ref");
            RequireExactFields(account, new[] { "broker_server", "login" },
                "bridge_mt5_worker_hello_account_invalid");
            if (ReadText(account, "broker_server", 128) != configuration.BrokerServer
                || ReadText(account, "login", 64) != configuration.Login)
            {
                throw new InvalidDataException("bridge_mt5_worker_hello_route_mismatch");
            }
        }

        private void ValidateCapabilities(object[] values)
        {
            if (values == null || values.Length == 0)
            {
                throw new InvalidDataException("bridge_mt5_worker_capabilities_invalid");
            }
            HashSet<string> expected = configuration.Role == "archive" ? ArchiveCapabilities : LiveCapabilities;
            HashSet<string> actual = new HashSet<string>(StringComparer.Ordinal);
            foreach (object value in values)
            {
                string capability = value as string;
                if (string.IsNullOrWhiteSpace(capability) || !actual.Add(capability))
                {
                    throw new InvalidDataException("bridge_mt5_worker_capabilities_invalid");
                }
            }
            if (!actual.SetEquals(expected))
            {
                throw new InvalidDataException("bridge_mt5_worker_capabilities_mismatch");
            }
        }

        private static NamedPipeServerStream CreatePipe(string name)
        {
            PipeSecurity security = new PipeSecurity();
            SecurityIdentifier currentUser = WindowsIdentity.GetCurrent().User;
            if (currentUser == null)
            {
                throw new InvalidOperationException("bridge_mt5_worker_user_identity_missing");
            }
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new PipeAccessRule(currentUser, PipeAccessRights.FullControl,
                AccessControlType.Allow));
            return new NamedPipeServerStream(name, PipeDirection.InOut, 1,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security);
        }

        private Process StartWorkerProcess()
        {
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = configuration.PythonExecutablePath,
                Arguments = QuoteArgument(configuration.WorkerScriptPath),
                WorkingDirectory = Path.GetDirectoryName(configuration.WorkerScriptPath),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            startInfo.EnvironmentVariables["AURUM_BRIDGE_WORKER_IPC_VERSION"] = "2";
            startInfo.EnvironmentVariables["AURUM_BRIDGE_WORKER_ROLE"] = configuration.Role;
            startInfo.EnvironmentVariables["AURUM_BRIDGE_WORKER_TERMINAL_ID"] = configuration.TerminalInstanceId;
            startInfo.EnvironmentVariables["AURUM_BRIDGE_WORKER_PLATFORM"] = "mt5";
            startInfo.EnvironmentVariables["AURUM_BRIDGE_WORKER_BROKER_SERVER"] = configuration.BrokerServer;
            startInfo.EnvironmentVariables["AURUM_BRIDGE_WORKER_LOGIN"] = configuration.Login;
            startInfo.EnvironmentVariables["AURUM_BRIDGE_WORKER_CONNECTION_EPOCH"] = configuration.ConnectionEpoch.ToString();
            startInfo.EnvironmentVariables["AURUM_BRIDGE_WORKER_TERMINAL_PATH"] = configuration.TerminalPath;
            startInfo.EnvironmentVariables["AURUM_BRIDGE_WORKER_PIPE"] = pipeName;
            startInfo.EnvironmentVariables["AURUM_BRIDGE_WORKER_NONCE"] = sessionNonce;
            if (!string.IsNullOrEmpty(configuration.DiagnosticPath))
            {
                startInfo.EnvironmentVariables["AURUM_BRIDGE_DIAGNOSTIC_PATH"] = configuration.DiagnosticPath;
            }
            Process value = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            value.Exited += OnWorkerExited;
            value.OutputDataReceived += DiscardProcessOutput;
            value.ErrorDataReceived += DiscardProcessOutput;
            // Publish the owned process before starting it.  A very short-lived
            // worker can raise Exited immediately after Start returns.
            process = value;
            if (!value.Start())
            {
                value.Dispose();
                process = null;
                throw new InvalidOperationException("bridge_mt5_worker_process_start_failed");
            }
            value.BeginOutputReadLine();
            value.BeginErrorReadLine();
            return value;
        }

        private void OnWorkerExited(object sender, EventArgs eventArgs)
        {
            // FailClosed takes the same lock as requests and Dispose.  The
            // disposed guard makes an intentional stop/Kill idempotent and
            // prevents a second Disconnected event from the Exited callback.
            FailClosed("bridge_mt5_worker_process_exited", false);
        }

        private void FailClosed(string errorCode, bool terminateWorker)
        {
            FailClosed(errorCode, terminateWorker, true);
        }

        private void FailClosed(string errorCode, bool terminateWorker, bool notify)
        {
            Process ownedProcess;
            NamedPipeServerStream ownedPipe;
            bool raise;
            lock (requestLock)
            {
                raise = notify && !disposed && connected;
                disposed = true;
                connected = false;
                lastErrorCode = errorCode;
                ownedPipe = pipe;
                ownedProcess = process;
                pipe = null;
                process = null;
            }
            if (ownedPipe != null)
            {
                try { ownedPipe.Dispose(); } catch (Exception) { }
            }
            if (ownedProcess != null)
            {
                try
                {
                    if (terminateWorker && !ownedProcess.HasExited)
                    {
                        ownedProcess.Kill();
                    }
                    ownedProcess.WaitForExit(2000);
                }
                catch (Exception) { }
                finally
                {
                    try { ownedProcess.Dispose(); }
                    catch
                    {
                        lock (requestLock) if (process == null) process = ownedProcess;
                        throw;
                    }
                }
            }
            if (raise)
            {
                EventHandler<Mt5WorkerSessionEventArgs> handler = Disconnected;
                if (handler != null)
                {
                    handler(this, new Mt5WorkerSessionEventArgs(this, errorCode));
                }
            }
        }

        private void EnsureConnected()
        {
            if (disposed || !connected || pipe == null)
            {
                throw new InvalidOperationException(lastErrorCode ?? "bridge_mt5_worker_not_connected");
            }
            if (process != null && process.HasExited)
            {
                FailClosed("bridge_mt5_worker_process_exited", false);
                throw new IOException("bridge_mt5_worker_process_exited");
            }
        }

        private static void WaitForConnection(NamedPipeServerStream server, int timeoutMilliseconds)
        {
            IAsyncResult wait = server.BeginWaitForConnection(null, null);
            WaitHandle handle = wait.AsyncWaitHandle;
            try
            {
                if (!handle.WaitOne(timeoutMilliseconds))
                {
                    // EndWaitForConnection can block indefinitely when no client
                    // ever connected. Close the server first to cancel the
                    // overlapped wait, then observe completion only briefly.
                    try { server.Dispose(); } catch (Exception) { }
                    try
                    {
                        if (handle.WaitOne(500))
                        {
                            try { server.EndWaitForConnection(wait); } catch (Exception) { }
                        }
                    }
                    catch (ObjectDisposedException) { }
                    throw new TimeoutException("bridge_mt5_worker_connect_timeout");
                }
                server.EndWaitForConnection(wait);
            }
            finally
            {
                handle.Close();
            }
        }

        private static string CreateNonce()
        {
            byte[] bytes = new byte[24];
            using (RandomNumberGenerator random = RandomNumberGenerator.Create())
            {
                random.GetBytes(bytes);
            }
            StringBuilder result = new StringBuilder(bytes.Length * 2);
            foreach (byte value in bytes)
            {
                result.Append(value.ToString("x2"));
            }
            return result.ToString();
        }

        private static string QuoteArgument(string value)
        {
            StringBuilder result = new StringBuilder(value.Length + 2);
            result.Append('"');
            int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\')
                {
                    slashes++;
                    continue;
                }
                if (character == '"')
                {
                    result.Append(new string('\\', slashes * 2 + 1));
                    result.Append('"');
                    slashes = 0;
                    continue;
                }
                if (slashes > 0)
                {
                    result.Append(new string('\\', slashes));
                    slashes = 0;
                }
                result.Append(character);
            }
            result.Append(new string('\\', slashes * 2));
            result.Append('"');
            return result.ToString();
        }

        private static void DiscardProcessOutput(object sender, DataReceivedEventArgs eventArgs)
        {
            // Never copy worker stdout/stderr to Bridge logs; it may contain account data.
        }

        private static void RequireExactFields(IDictionary<string, object> values, string[] fields, string errorCode)
        {
            if (values == null || values.Count != fields.Length)
            {
                throw new InvalidDataException(errorCode);
            }
            HashSet<string> expected = new HashSet<string>(fields, StringComparer.Ordinal);
            foreach (string field in values.Keys)
            {
                if (!expected.Contains(field))
                {
                    throw new InvalidDataException(errorCode);
                }
            }
        }

        private static IDictionary<string, object> ReadObject(IDictionary<string, object> values, string field)
        {
            object value;
            IDictionary<string, object> result;
            if (!values.TryGetValue(field, out value)
                || (result = value as IDictionary<string, object>) == null)
            {
                throw new InvalidDataException("bridge_mt5_worker_object_invalid");
            }
            return result;
        }

        private static object[] ReadArray(IDictionary<string, object> values, string field)
        {
            object value;
            object[] result;
            if (!values.TryGetValue(field, out value)
                || (result = value as object[]) == null)
            {
                throw new InvalidDataException("bridge_mt5_worker_array_invalid");
            }
            return result;
        }

        private static string ReadText(IDictionary<string, object> values, string field, int maximumLength)
        {
            object value;
            string result;
            if (!values.TryGetValue(field, out value)
                || (result = value as string) == null
                || result.Length == 0 || result.Length > maximumLength
                || result.IndexOf('\r') >= 0 || result.IndexOf('\n') >= 0)
            {
                throw new InvalidDataException("bridge_mt5_worker_text_invalid");
            }
            return result;
        }

        private static long ReadLong(IDictionary<string, object> values, string field)
        {
            object value;
            if (!values.TryGetValue(field, out value))
            {
                throw new InvalidDataException("bridge_mt5_worker_number_invalid");
            }
            if (value is int) return (int)value;
            if (value is long) return (long)value;
            throw new InvalidDataException("bridge_mt5_worker_number_invalid");
        }

        private static bool ReadInt(IDictionary<string, object> values, string field, int expected)
        {
            return ReadLong(values, field) == expected;
        }

        private static bool SecureEquals(string left, string right)
        {
            if (left == null || right == null || left.Length != right.Length)
            {
                return false;
            }
            int difference = 0;
            for (int index = 0; index < left.Length; index++)
            {
                difference |= left[index] ^ right[index];
            }
            return difference == 0;
        }
    }

    public sealed class Mt5WorkerResponse
    {
        private Mt5WorkerResponse()
        {
        }

        public string RequestId { get; private set; }
        public string Outcome { get; private set; }
        public IDictionary<string, object> Payload { get; private set; }

        public bool IsError { get { return Outcome == "error"; } }

        internal static Mt5WorkerResponse FromAdapter(string requestId, string outcome,
            IDictionary<string, object> payload)
        {
            return new Mt5WorkerResponse { RequestId = requestId, Outcome = outcome, Payload = payload };
        }

        internal static Mt5WorkerResponse Parse(string json, Mt5WorkerConfiguration configuration,
            string expectedRequestId)
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = Mt5WorkerFrameCodec.MaximumFrameBytes;
            serializer.RecursionLimit = 128;
            IDictionary<string, object> root;
            try
            {
                root = serializer.DeserializeObject(json) as IDictionary<string, object>;
            }
            catch (ArgumentException)
            {
                throw new InvalidDataException("bridge_mt5_worker_response_invalid");
            }
            catch (InvalidOperationException)
            {
                throw new InvalidDataException("bridge_mt5_worker_response_invalid");
            }
            RequireExactFields(root, new[] { "ipc_v", "type", "request_id", "route", "outcome", "payload" },
                "bridge_mt5_worker_response_fields_invalid");
            if (!ReadInt(root, "ipc_v", 2)
                || ReadText(root, "type", 32) != "worker_response"
                || ReadText(root, "request_id", 128) != expectedRequestId)
            {
                throw new InvalidDataException("bridge_mt5_worker_response_correlation_invalid");
            }
            ValidateRoute(ReadObject(root, "route"), configuration);
            string outcome = ReadText(root, "outcome", 32);
            if (outcome != "snapshot" && outcome != "quote" && outcome != "history_batch"
                && outcome != "data" && outcome != "command_result" && outcome != "error")
            {
                throw new InvalidDataException("bridge_mt5_worker_response_outcome_invalid");
            }
            IDictionary<string, object> payload = ReadObject(root, "payload");
            return new Mt5WorkerResponse
            {
                RequestId = expectedRequestId,
                Outcome = outcome,
                Payload = payload
            };
        }

        private static void ValidateRoute(IDictionary<string, object> route, Mt5WorkerConfiguration configuration)
        {
            RequireExactFields(route, new[] { "terminal_instance_id", "platform", "account_ref", "connection_epoch" },
                "bridge_mt5_worker_response_route_invalid");
            if (ReadText(route, "terminal_instance_id", 191) != configuration.TerminalInstanceId
                || ReadText(route, "platform", 8) != "mt5"
                || ReadLong(route, "connection_epoch") != configuration.ConnectionEpoch)
            {
                throw new InvalidDataException("bridge_mt5_worker_response_route_mismatch");
            }
            IDictionary<string, object> account = ReadObject(route, "account_ref");
            RequireExactFields(account, new[] { "broker_server", "login" },
                "bridge_mt5_worker_response_account_invalid");
            if (ReadText(account, "broker_server", 128) != configuration.BrokerServer
                || ReadText(account, "login", 64) != configuration.Login)
            {
                throw new InvalidDataException("bridge_mt5_worker_response_route_mismatch");
            }
        }

        private static void RequireExactFields(IDictionary<string, object> values, string[] fields, string errorCode)
        {
            if (values == null || values.Count != fields.Length)
            {
                throw new InvalidDataException(errorCode);
            }
            HashSet<string> expected = new HashSet<string>(fields, StringComparer.Ordinal);
            foreach (string field in values.Keys)
            {
                if (!expected.Contains(field))
                {
                    throw new InvalidDataException(errorCode);
                }
            }
        }

        private static IDictionary<string, object> ReadObject(IDictionary<string, object> values, string field)
        {
            object value;
            IDictionary<string, object> result;
            if (!values.TryGetValue(field, out value)
                || (result = value as IDictionary<string, object>) == null)
            {
                throw new InvalidDataException("bridge_mt5_worker_object_invalid");
            }
            return result;
        }

        private static string ReadText(IDictionary<string, object> values, string field, int maximumLength)
        {
            object value;
            string result;
            if (!values.TryGetValue(field, out value)
                || (result = value as string) == null
                || result.Length == 0 || result.Length > maximumLength
                || result.IndexOf('\r') >= 0 || result.IndexOf('\n') >= 0)
            {
                throw new InvalidDataException("bridge_mt5_worker_text_invalid");
            }
            return result;
        }

        private static long ReadLong(IDictionary<string, object> values, string field)
        {
            object value;
            if (!values.TryGetValue(field, out value))
            {
                throw new InvalidDataException("bridge_mt5_worker_number_invalid");
            }
            if (value is int) return (int)value;
            if (value is long) return (long)value;
            throw new InvalidDataException("bridge_mt5_worker_number_invalid");
        }

        private static bool ReadInt(IDictionary<string, object> values, string field, int expected)
        {
            return ReadLong(values, field) == expected;
        }
    }

    public sealed class Mt5WorkerSessionSnapshot
    {
        public string TerminalInstanceId { get; internal set; }
        public string BrokerServer { get; internal set; }
        public string Login { get; internal set; }
        public long ConnectionEpoch { get; internal set; }
        public string Role { get; internal set; }
        public bool Connected { get; internal set; }
        public string LastErrorCode { get; internal set; }
    }

    public sealed class Mt5WorkerSessionEventArgs : EventArgs
    {
        internal Mt5WorkerSessionEventArgs(Mt5WorkerSession session, string errorCode)
        {
            Session = session;
            ErrorCode = errorCode;
        }

        public Mt5WorkerSession Session { get; private set; }
        public string ErrorCode { get; private set; }
    }
}
