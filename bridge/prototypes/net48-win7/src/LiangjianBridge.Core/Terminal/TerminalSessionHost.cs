using System;
using System.Collections.Generic;
using System.Threading;

namespace Liangjian.BridgeV4.Terminal
{
    public sealed class TerminalSessionHost : IDisposable
    {
        public const string DefaultPipeName = "LiangjianBridgeV4";

        private readonly object stateLock = new object();
        private readonly Dictionary<string, TerminalReadOnlySession> sessions = new Dictionary<string, TerminalReadOnlySession>(StringComparer.Ordinal);
        private readonly string pipeName;
        private Thread acceptThread;
        private Timer heartbeatTimer;
        private int heartbeatRunning;
        private volatile bool stopping;
        private bool disposed;

        public TerminalSessionHost(string name)
        {
            pipeName = string.IsNullOrWhiteSpace(name) ? DefaultPipeName : name;
        }

        public event EventHandler SessionsChanged;
        public event EventHandler<TerminalHostErrorEventArgs> HostError;

        public void Start()
        {
            lock (stateLock)
            {
                if (disposed)
                {
                    throw new ObjectDisposedException("TerminalSessionHost");
                }
                if (acceptThread != null)
                {
                    return;
                }
                stopping = false;
                acceptThread = new Thread(AcceptLoop);
                acceptThread.Name = "LiangjianBridgeV4.TerminalAccept";
                acceptThread.IsBackground = true;
                acceptThread.Start();
                heartbeatTimer = new Timer(CheckHeartbeats, null, 3000, 3000);
            }
        }

        public IList<TerminalSessionSnapshot> Snapshot()
        {
            lock (stateLock)
            {
                List<TerminalSessionSnapshot> result = new List<TerminalSessionSnapshot>(sessions.Count);
                foreach (TerminalReadOnlySession session in sessions.Values)
                {
                    result.Add(TerminalSessionSnapshot.From(session));
                }
                result.Sort(delegate(TerminalSessionSnapshot left, TerminalSessionSnapshot right)
                {
                    return string.Compare(left.TerminalInstanceId, right.TerminalInstanceId, StringComparison.Ordinal);
                });
                return result;
            }
        }

        public TerminalQueryResult Query(string terminalInstanceId, byte[] requestPayload, string requestId, TerminalResourceCode resource)
        {
            TerminalReadOnlySession session;
            lock (stateLock)
            {
                if (!sessions.TryGetValue(terminalInstanceId, out session))
                {
                    throw new InvalidOperationException("bridge_terminal_session_not_found");
                }
            }
            try
            {
                return session.Query(requestPayload, requestId, resource);
            }
            catch
            {
                RemoveIfCurrent(terminalInstanceId, session);
                throw;
            }
        }

        public TerminalQueryResult Query(TerminalRequest request)
        {
            if (request == null)
            {
                throw new ArgumentNullException("request");
            }
            TerminalReadOnlySession session;
            lock (stateLock)
            {
                if (!sessions.TryGetValue(request.TerminalInstanceId, out session))
                {
                    throw new InvalidOperationException("bridge_terminal_session_not_found");
                }
            }
            try
            {
                TerminalTranslatedQuery translated = TerminalQueryTranslator.Translate(request, session);
                return session.Query(translated.Payload, translated.RequestId, translated.Resource);
            }
            catch
            {
                RemoveIfCurrent(request.TerminalInstanceId, session);
                throw;
            }
        }

        public TerminalCommandResult ExecuteCommand(string terminalInstanceId, byte[] requestPayload,
            string requestId, string commandId, TerminalCommandActionCode action)
        {
            TerminalReadOnlySession session;
            lock (stateLock)
            {
                if (!sessions.TryGetValue(terminalInstanceId, out session))
                {
                    throw new InvalidOperationException("bridge_terminal_session_not_found");
                }
            }
            try
            {
                return session.ExecuteCommand(requestPayload, requestId, commandId, action);
            }
            catch
            {
                RemoveIfCurrent(terminalInstanceId, session);
                throw;
            }
        }

        public void Dispose()
        {
            Thread thread;
            List<TerminalReadOnlySession> active;
            lock (stateLock)
            {
                if (disposed)
                {
                    return;
                }
                disposed = true;
                stopping = true;
                if (heartbeatTimer != null) { heartbeatTimer.Dispose(); heartbeatTimer = null; }
                thread = acceptThread;
                acceptThread = null;
                active = new List<TerminalReadOnlySession>(sessions.Values);
                sessions.Clear();
            }
            foreach (TerminalReadOnlySession session in active)
            {
                session.Dispose();
            }
            if (thread != null && thread != Thread.CurrentThread)
            {
                thread.Join(2500);
            }
            RaiseSessionsChanged();
        }

        private void CheckHeartbeats(object ignored)
        {
            if (Interlocked.Exchange(ref heartbeatRunning, 1) != 0) return;
            try
            {
                List<TerminalReadOnlySession> active;
                lock (stateLock)
                {
                    if (disposed || stopping) return;
                    active = new List<TerminalReadOnlySession>(sessions.Values);
                }
                foreach (TerminalReadOnlySession session in active)
                {
                    if (stopping) return;
                    TerminalReadOnlySession target = session;
                    ThreadPool.QueueUserWorkItem(delegate
                    {
                        if (stopping) return;
                        try { target.CheckHeartbeat(); }
                        catch (Exception) { RemoveIfCurrent(target.TerminalInstanceId, target); }
                    });
                }
            }
            finally { Interlocked.Exchange(ref heartbeatRunning, 0); }
        }

        private void AcceptLoop()
        {
            while (!stopping)
            {
                TerminalPipeServer server = null;
                try
                {
                    server = new TerminalPipeServer(pipeName);
                    TerminalReadOnlySession session = TerminalReadOnlySession.Accept(server, 1000);
                    server = null;
                    AddOrReplace(session);
                }
                catch (TimeoutException)
                {
                }
                catch (Exception error)
                {
                    if (!stopping)
                    {
                        RaiseHostError(error);
                        Thread.Sleep(250);
                    }
                }
                finally
                {
                    if (server != null)
                    {
                        server.Dispose();
                    }
                }
            }
        }

        private void AddOrReplace(TerminalReadOnlySession session)
        {
            TerminalReadOnlySession previous = null;
            lock (stateLock)
            {
                if (disposed)
                {
                    session.Dispose();
                    return;
                }
                sessions.TryGetValue(session.TerminalInstanceId, out previous);
                sessions[session.TerminalInstanceId] = session;
            }
            if (previous != null)
            {
                previous.Dispose();
            }
            RaiseSessionsChanged();
        }

        private void RemoveIfCurrent(string terminalInstanceId, TerminalReadOnlySession expected)
        {
            bool removed = false;
            lock (stateLock)
            {
                TerminalReadOnlySession current;
                if (sessions.TryGetValue(terminalInstanceId, out current) && object.ReferenceEquals(current, expected))
                {
                    sessions.Remove(terminalInstanceId);
                    removed = true;
                }
            }
            expected.Dispose();
            if (removed)
            {
                RaiseSessionsChanged();
            }
        }

        private void RaiseSessionsChanged()
        {
            EventHandler handler = SessionsChanged;
            if (handler != null)
            {
                handler(this, EventArgs.Empty);
            }
        }

        private void RaiseHostError(Exception error)
        {
            EventHandler<TerminalHostErrorEventArgs> handler = HostError;
            if (handler != null)
            {
                handler(this, new TerminalHostErrorEventArgs(error));
            }
        }
    }

    public sealed class TerminalSessionSnapshot
    {
        private TerminalSessionSnapshot()
        {
        }

        public string TerminalInstanceId { get; private set; }
        public string Platform { get; private set; }
        public string BrokerServer { get; private set; }
        public string Login { get; private set; }
        public long SessionEpoch { get; private set; }
        public int TerminalBuild { get; private set; }
        public bool Connected { get; private set; }
        public bool TradeAllowed { get; private set; }
        public bool? CurrentTradePermission { get; private set; }
        public int[] CurrentPermissionFlags { get; private set; }
        public int ServerOffsetMinutes { get; private set; }
        public string ClockStatus { get; private set; }

        internal static TerminalSessionSnapshot From(TerminalReadOnlySession session)
        {
            return new TerminalSessionSnapshot
            {
                TerminalInstanceId = session.TerminalInstanceId,
                Platform = session.Hello.Platform,
                BrokerServer = session.Hello.BrokerServer,
                Login = session.Hello.Login,
                SessionEpoch = session.SessionEpoch,
                TerminalBuild = session.Hello.TerminalBuild,
                Connected = session.Hello.Connected,
                TradeAllowed = session.Hello.TradeAllowed,
                CurrentTradePermission = session.CurrentTradePermission,
                CurrentPermissionFlags = session.CurrentPermissionFlags,
                ServerOffsetMinutes = session.Hello.ServerOffsetMinutes,
                ClockStatus = session.Hello.ClockStatus
            };
        }
    }

    public sealed class TerminalHostErrorEventArgs : EventArgs
    {
        public TerminalHostErrorEventArgs(Exception errorValue)
        {
            Error = errorValue;
        }

        public Exception Error { get; private set; }
    }
}
