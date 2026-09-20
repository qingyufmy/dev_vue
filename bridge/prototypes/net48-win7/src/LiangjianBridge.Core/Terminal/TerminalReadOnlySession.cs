using System;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace Liangjian.BridgeV4.Terminal
{
    public sealed class TerminalReadOnlySession : IDisposable
    {
        private static long epochSeed = DateTime.UtcNow.Ticks;
        private readonly TerminalPipeServer pipe;
        private readonly object queryLock = new object();
        private bool disposed;
        private long permissionObservation;
        private int[] permissionFlags;

        public int[] CurrentPermissionFlags
        {
            get
            {
                int[] flags = permissionFlags;
                return CurrentTradePermission.HasValue && flags != null ? (int[])flags.Clone() : null;
            }
        }

        public bool? CurrentTradePermission
        {
            get
            {
                long observation = Interlocked.Read(ref permissionObservation);
                long observedTicks = observation & ~3L;
                if (disposed || observedTicks == 0 || DateTime.UtcNow.Ticks - observedTicks > TimeSpan.FromSeconds(25).Ticks) return null;
                return (observation & 1L) != 0;
            }
        }

        private TerminalReadOnlySession(TerminalPipeServer connectedPipe, TerminalHello hello, string terminalInstanceId, long sessionEpoch)
        {
            pipe = connectedPipe;
            Hello = hello;
            TerminalInstanceId = terminalInstanceId;
            SessionEpoch = sessionEpoch;
        }

        public TerminalHello Hello { get; private set; }
        public string TerminalInstanceId { get; private set; }
        public long SessionEpoch { get; private set; }

        public void CheckHeartbeat()
        {
            // Skip while a query/command owns the pipe; never interleave frames.
            if (!Monitor.TryEnter(queryLock)) return;
            try
            {
                EnsureOpen();
                object deadlineGate = new object();
                bool completed = false;
                using (Timer deadline = new Timer(delegate
                {
                    lock (deadlineGate) if (!completed) pipe.Dispose();
                }, null, 5000, Timeout.Infinite))
                {
                    try
                    {
                        pipe.WritePayload(BitConverter.GetBytes((int)TerminalWireMessageType.Ping));
                        byte[] pong = pipe.ReadPayload();
                        if ((pong.Length != 12 && pong.Length != 20 && pong.Length != 36) || BitConverter.ToInt32(pong, 0) != (int)TerminalWireMessageType.Pong)
                            throw new InvalidDataException("bridge_terminal_heartbeat_invalid");
                        Interlocked.Exchange(ref permissionObservation, 0);
                        permissionFlags = null;
                        if (pong.Length >= 20)
                        {
                            int connected = BitConverter.ToInt32(pong, 12);
                            int allowed = BitConverter.ToInt32(pong, 16);
                            if ((connected != 0 && connected != 1) || (allowed != 0 && allowed != 1))
                                throw new InvalidDataException("bridge_terminal_heartbeat_permissions_invalid");
                            if (pong.Length == 36)
                            {
                                int[] flags = new int[4];
                                for (int i = 0; i < flags.Length; i++)
                                {
                                    flags[i] = BitConverter.ToInt32(pong, 20 + i * 4);
                                    if (flags[i] != 0 && flags[i] != 1) throw new InvalidDataException("bridge_terminal_heartbeat_permissions_invalid");
                                }
                                permissionFlags = flags;
                            }
                            if (connected == 1) Interlocked.Exchange(ref permissionObservation,
                                (DateTime.UtcNow.Ticks & ~3L) | (long)(uint)allowed);
                        }
                    }
                    finally { lock (deadlineGate) completed = true; }
                }
            }
            finally { Monitor.Exit(queryLock); }
        }

        public static TerminalReadOnlySession Accept(TerminalPipeServer server, int timeoutMilliseconds)
        {
            if (server == null)
            {
                throw new ArgumentNullException("server");
            }
            try
            {
                server.WaitForConnection(timeoutMilliseconds);
                TerminalHello hello = TerminalHello.Parse(server.ReadPayload());
                string terminalInstanceId = CreateTerminalInstanceId(hello.Platform, hello.DataPath);
                long sessionEpoch = Interlocked.Increment(ref epochSeed);
                server.WritePayload(TerminalWelcome.Create(terminalInstanceId, sessionEpoch));
                return new TerminalReadOnlySession(server, hello, terminalInstanceId, sessionEpoch);
            }
            catch
            {
                server.Dispose();
                throw;
            }
        }

        public TerminalQueryResult Query(byte[] requestPayload, string expectedRequestId, TerminalResourceCode expectedResource)
        {
            if (requestPayload == null || string.IsNullOrWhiteSpace(expectedRequestId))
            {
                throw new ArgumentException("bridge_terminal_query_arguments_invalid");
            }
            lock (queryLock)
            {
                EnsureOpen();
                try
                {
                    pipe.WritePayload(requestPayload);
                    TerminalQueryResult result = TerminalQueryResult.Parse(pipe.ReadPayload());
                    if (!string.Equals(result.RequestId, expectedRequestId, StringComparison.Ordinal)
                        || result.Resource != expectedResource)
                    {
                        throw new InvalidDataException("bridge_terminal_response_correlation_invalid");
                    }
                    return result;
                }
                catch
                {
                    Dispose();
                    throw;
                }
            }
        }

        // Commands share the same per-terminal serialization gate as queries.
        // The server/Bridge owns the durable ledger; this method only performs
        // one already-translated, route-bound terminal exchange and closes the
        // session on any transport/correlation failure.
        public TerminalCommandResult ExecuteCommand(byte[] requestPayload, string expectedRequestId,
            string expectedCommandId, TerminalCommandActionCode expectedAction)
        {
            if (requestPayload == null || string.IsNullOrWhiteSpace(expectedRequestId)
                || string.IsNullOrWhiteSpace(expectedCommandId))
            {
                throw new ArgumentException("bridge_terminal_command_arguments_invalid");
            }
            lock (queryLock)
            {
                EnsureOpen();
                try
                {
                    pipe.WritePayload(requestPayload);
                    TerminalCommandResult result = TerminalCommandResult.Parse(pipe.ReadPayload());
                    if (!string.Equals(result.RequestId, expectedRequestId, StringComparison.Ordinal)
                        || !string.Equals(result.CommandId, expectedCommandId, StringComparison.Ordinal)
                        || result.Action != expectedAction)
                    {
                        throw new InvalidDataException("bridge_terminal_command_correlation_invalid");
                    }
                    return result;
                }
                catch
                {
                    Dispose();
                    throw;
                }
            }
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            pipe.Dispose();
        }

        private void EnsureOpen()
        {
            if (disposed)
            {
                throw new ObjectDisposedException("TerminalReadOnlySession");
            }
        }

        private static string CreateTerminalInstanceId(string platform, string dataPath)
        {
            byte[] source = Encoding.UTF8.GetBytes(platform + "\n" + Path.GetFullPath(dataPath).TrimEnd(Path.DirectorySeparatorChar).ToUpperInvariant());
            byte[] digest;
            using (SHA256 algorithm = SHA256.Create())
            {
                digest = algorithm.ComputeHash(source);
            }
            StringBuilder text = new StringBuilder(platform.Length + 1 + 32);
            text.Append(platform);
            text.Append('-');
            for (int index = 0; index < 16; index++)
            {
                text.Append(digest[index].ToString("x2", CultureInfo.InvariantCulture));
            }
            return text.ToString();
        }
    }
}
