using System;
using System.IO;
using System.Threading;
using Liangjian.BridgeV4.Transport;
using Liangjian.BridgeV4.Update;

namespace Liangjian.BridgeV4.Runtime
{
    public interface IBridgeMessageChannelFactory
    {
        IBridgeMessageChannel Connect();
    }

    public sealed class Rfc6455MessageChannelFactory : IBridgeMessageChannelFactory
    {
        private readonly Uri uri;
        private readonly Func<string> sessionTokenProvider;
        private readonly int timeoutMilliseconds;
        private readonly Func<Uri, string, int, IBridgeMessageChannel> connector;

        public Rfc6455MessageChannelFactory(Uri uriValue, Func<string> sessionTokenProviderValue,
            int timeoutMillisecondsValue)
            : this(uriValue, sessionTokenProviderValue, timeoutMillisecondsValue,
                delegate(Uri target, string accessToken, int timeout)
                {
                    return Rfc6455MessageChannel.Connect(target, accessToken, timeout);
                })
        {
        }

        public Rfc6455MessageChannelFactory(Uri uriValue, Func<string> sessionTokenProviderValue,
            int timeoutMillisecondsValue,
            Func<Uri, string, int, IBridgeMessageChannel> connectorValue)
        {
            if (!WebSocketEndpointPolicy.IsAllowed(uriValue) || sessionTokenProviderValue == null
                || connectorValue == null)
            {
                throw new InvalidDataException("bridge_channel_configuration_invalid");
            }
            uri = uriValue;
            sessionTokenProvider = sessionTokenProviderValue;
            timeoutMilliseconds = timeoutMillisecondsValue;
            connector = connectorValue;
        }

        public IBridgeMessageChannel Connect()
        {
            string accessToken = sessionTokenProvider();
            try
            {
                if (string.IsNullOrWhiteSpace(accessToken))
                    throw new InvalidDataException("bridge_session_token_invalid");
                return connector(uri, accessToken, timeoutMilliseconds);
            }
            finally
            {
                accessToken = null;
            }
        }
    }

    public sealed class BridgeProfileWorker : IDisposable
    {
        private readonly object gate = new object();
        private readonly object controllerGate = new object();
        private readonly object disposeGate = new object();
        private readonly object releaseStatusGate = new object();
        private readonly ProfileRuntime runtime;
        private readonly BridgeSessionController controller;
        private readonly IBridgeMessageChannelFactory factory;
        private readonly ProfileOutboxCoordinator outbox = new ProfileOutboxCoordinator();
        private readonly ReleaseActivationStatusStore releaseStatus;
        private readonly BridgeTerminalIdentityMonitor identityMonitor;
        private readonly ITerminalProjectionSource projectionSource;
        private readonly ManualResetEvent stop = new ManualResetEvent(false);
        private Thread thread;
        private IBridgeMessageChannel activeChannel;
        private int activeOperations;
        private bool pausedForUpdate;
        private bool capacityWaiting;
        private bool disposed;
        private bool stopping;
        private bool routeInvalidated;
        private string lastReleaseStatusFingerprint;
        private long nextReleaseStatusCheckUtcMsc;

        public BridgeProfileWorker(ProfileRuntime runtimeValue, BridgeSessionController controllerValue,
            IBridgeMessageChannelFactory factoryValue)
            : this(runtimeValue, controllerValue, factoryValue, null)
        {
        }

        public BridgeProfileWorker(ProfileRuntime runtimeValue, BridgeSessionController controllerValue,
            IBridgeMessageChannelFactory factoryValue, ReleaseActivationStatusStore statusStore)
            : this(runtimeValue, controllerValue, factoryValue, statusStore, null)
        {
        }

        public BridgeProfileWorker(ProfileRuntime runtimeValue, BridgeSessionController controllerValue,
            IBridgeMessageChannelFactory factoryValue, ReleaseActivationStatusStore statusStore,
            BridgeTerminalIdentityMonitor identityMonitorValue)
            : this(runtimeValue, controllerValue, factoryValue, statusStore, identityMonitorValue, null) { }

        public BridgeProfileWorker(ProfileRuntime runtimeValue, BridgeSessionController controllerValue,
            IBridgeMessageChannelFactory factoryValue, ReleaseActivationStatusStore statusStore,
            BridgeTerminalIdentityMonitor identityMonitorValue, ITerminalProjectionSource projectionSourceValue)
        {
            if (runtimeValue == null || controllerValue == null || factoryValue == null)
            {
                throw new ArgumentNullException("runtimeValue");
            }
            runtime = runtimeValue;
            controller = controllerValue;
            factory = factoryValue;
            releaseStatus = statusStore;
            identityMonitor = identityMonitorValue;
            projectionSource = projectionSourceValue;
        }

        public event EventHandler<BridgeWorkerErrorEventArgs> ConnectionError;
        public event EventHandler StateChanged;

        public string State
        {
            get { lock (gate) return disposed ? "stopped" : stopping ? "stopping" : pausedForUpdate ? "update_wait" : capacityWaiting ? "capacity_wait" : routeInvalidated ? "disconnected" : controller.State; }
        }

        public bool ResumeForAvailableCapacity()
        {
            lock (gate)
            {
                if (disposed || stopping || !capacityWaiting) return false;
                capacityWaiting = false;
            }
            RaiseStateChanged();
            return true;
        }

        public string ConnectionId
        {
            get { lock (gate) return stopping || routeInvalidated ? null : controller.ConnectionId; }
        }

        public int ActiveOperations
        {
            get { lock (gate) return activeOperations; }
        }

        public PendingBridgeRelease PendingRelease
        {
            get { return controller.Updates.Pending; }
        }

        public void Start()
        {
            lock (gate)
            {
                if (stopping || disposed) throw new ObjectDisposedException("BridgeProfileWorker");
                if (thread != null) return;
                thread = new Thread(Run);
                thread.Name = "LiangjianBridgeV4.Profile." + runtime.Configuration.ProfileId;
                thread.IsBackground = true;
                thread.Start();
            }
            RaiseStateChanged();
        }

        public bool PauseForUpdate(int timeoutMilliseconds)
        {
            if (timeoutMilliseconds < 1 || timeoutMilliseconds > 60000)
            {
                throw new ArgumentOutOfRangeException("timeoutMilliseconds");
            }
            IBridgeMessageChannel channel;
            lock (gate)
            {
                if (stopping || disposed) return false;
                pausedForUpdate = true;
                channel = activeChannel;
            }
            if (channel != null)
            {
                try { channel.Dispose(); }
                catch (Exception) { }
            }
            int started = Environment.TickCount;
            while (true)
            {
                lock (gate)
                {
                    if (activeOperations == 0)
                    {
                        RaiseStateChanged();
                        return true;
                    }
                }
                if (unchecked(Environment.TickCount - started) >= timeoutMilliseconds)
                {
                    ResumeAfterUpdate();
                    return false;
                }
                Thread.Sleep(25);
            }
        }

        public void ResumeAfterUpdate()
        {
            lock (gate)
            {
                if (stopping || disposed) return;
                pausedForUpdate = false;
            }
            RaiseStateChanged();
        }

        public void Dispose()
        {
            lock (disposeGate) DisposeCore();
        }

        private void DisposeCore()
        {
            Thread current;
            IBridgeMessageChannel channel;
            lock (gate)
            {
                if (disposed) return;
                stopping = true;
                stop.Set();
                current = thread;
                channel = activeChannel;
            }
            Exception closeError = null;
            if (channel != null)
            {
                try { channel.Dispose(); }
                catch (Exception error) { closeError = error; }
            }
            if (current != null && (current == Thread.CurrentThread || !current.Join(5000)))
                throw new TimeoutException("bridge_worker_stop_pending", closeError);
            // Run may have received a late connection after the first close attempt.
            lock (gate) channel = activeChannel;
            if (channel != null)
            {
                channel.Dispose();
                SetActiveChannel(null);
            }
            lock (gate)
            {
                disposed = true;
                thread = null;
                stop.Dispose();
            }
        }

        private void Run()
        {
            while (!stop.WaitOne(0))
            {
                if (IsPausedForUpdate())
                {
                    stop.WaitOne(100);
                    continue;
                }
                bool waiting;
                lock (gate) waiting = capacityWaiting;
                if (waiting) { stop.WaitOne(250); continue; }
                long now = UtcNowMsc();
                if (!controller.CanConnect(now))
                {
                    int delay = (int)Math.Min(1000L, Math.Max(1L, controller.NextConnectAtUtcMsc - now));
                    stop.WaitOne(delay);
                    continue;
                }
                IBridgeMessageChannel channel = null;
                ManualResetEvent connectionStop = new ManualResetEvent(false);
                Thread projectionSync = null;
                Thread heartbeat = null;
                Thread identity = null;
                Thread tradeStreams = null;
                Thread marketStreams = null;
                Thread marketQuotes = null;
                try
                {
                    lock (gate) routeInvalidated = false;
                    string hello;
                    if (!TryBeginOperation()) continue;
                    try
                    {
                        lock (controllerGate) hello = controller.Begin(UtcNowMsc());
                        if (IsStoppingOrPaused()) continue;
                        channel = factory.Connect();
                        SetActiveChannel(channel);
                        if (IsStoppingOrPaused()) continue;
                        if (identityMonitor != null && identityMonitor.IsExpired())
                            throw new InvalidDataException("bridge_terminal_identity_observation_stale");
                        channel.Send(hello);
                    }
                    finally { EndOperation(); }
                    lock (releaseStatusGate)
                    {
                        lastReleaseStatusFingerprint = null;
                        nextReleaseStatusCheckUtcMsc = 0;
                    }
                    RaiseStateChanged();
                    heartbeat = new Thread(new ThreadStart(delegate { HeartbeatLoop(channel, connectionStop); }));
                    heartbeat.Name = "LiangjianBridgeV4.Heartbeat." + runtime.Configuration.ProfileId;
                    heartbeat.IsBackground = true;
                    heartbeat.Start();
                    if (identityMonitor != null)
                    {
                        identity = new Thread(new ThreadStart(delegate { IdentityLoop(channel, connectionStop); }));
                        identity.Name = "LiangjianBridgeV4.Identity." + runtime.Configuration.ProfileId;
                        identity.IsBackground = true;
                        identity.Start();
                    }
                    tradeStreams = new Thread(new ThreadStart(delegate { TradeStreamsLoop(channel, connectionStop); }));
                    tradeStreams.Name = "LiangjianBridgeV4.Trades." + runtime.Configuration.ProfileId;
                    tradeStreams.IsBackground = true;
                    tradeStreams.Start();
                    marketStreams = new Thread(new ThreadStart(delegate { MarketStreamsLoop(channel, connectionStop, false); }));
                    marketStreams.Name = "LiangjianBridgeV4.Market." + runtime.Configuration.ProfileId;
                    marketStreams.IsBackground = true;
                    marketStreams.Start();
                    marketQuotes = new Thread(new ThreadStart(delegate { MarketStreamsLoop(channel, connectionStop, true); }));
                    marketQuotes.IsBackground = true;
                    marketQuotes.Name = "LiangjianBridgeV4.Quotes." + runtime.Configuration.ProfileId;
                    marketQuotes.Start();
                    if (projectionSource != null)
                    {
                        projectionSync = new Thread(new ThreadStart(delegate { ProjectionSyncLoop(connectionStop); }));
                        projectionSync.Name = "LiangjianBridgeV4.History." + runtime.Configuration.ProfileId;
                        projectionSync.IsBackground = true;
                        projectionSync.Start();
                    }
                    while (!stop.WaitOne(0) && !connectionStop.WaitOne(0))
                    {
                        string incoming = channel.Receive();
                        if (incoming == null) break;
                        if (!TryBeginOperation()) break;
                        try
                        {
                            string response;
                            lock (controllerGate)
                            {
                                response = controller.Handle(incoming, UtcNowMsc());
                            }
                            RaiseStateChanged();
                            if (response != null && !IsStoppingOrPaused())
                            {
                                channel.Send(response);
                                lock (controllerGate)
                                {
                                    if (!IsStoppingOrPaused()) controller.AfterResponseSent(UtcNowMsc());
                                }
                            }
                            TrySendReleaseStatus(channel, UtcNowMsc());
                        }
                        finally
                        {
                            EndOperation();
                        }
                    }
                }
                catch (Exception error)
                {
                    if (error.Message == "bridge_capacity_exceeded")
                    {
                        lock (gate) capacityWaiting = true;
                    }
                    if (!stop.WaitOne(0) && !IsPausedForUpdate()) RaiseConnectionError(error);
                }
                finally
                {
                    connectionStop.Set();
                    bool closed = true;
                    if (channel != null)
                    {
                        try { channel.Dispose(); }
                        catch (Exception error)
                        {
                            closed = false;
                            lock (gate) { stopping = true; stop.Set(); }
                            RaiseConnectionError(error);
                        }
                    }
                    if (closed) SetActiveChannel(null);
                    // Keep both wait handles and runtime alive until heartbeat work has exited.
                    if (heartbeat != null && heartbeat != Thread.CurrentThread) heartbeat.Join();
                    if (identity != null && identity != Thread.CurrentThread) identity.Join();
                    if (tradeStreams != null && tradeStreams != Thread.CurrentThread) tradeStreams.Join();
                    if (marketStreams != null && marketStreams != Thread.CurrentThread) marketStreams.Join();
                    if (marketQuotes != null && marketQuotes != Thread.CurrentThread) marketQuotes.Join();
                    if (projectionSync != null && projectionSync != Thread.CurrentThread) projectionSync.Join();
                    connectionStop.Dispose();
                    if (!stop.WaitOne(0))
                    {
                        lock (controllerGate) controller.MarkDisconnected(UtcNowMsc());
                        RaiseStateChanged();
                    }
                }
            }
        }

        private void HeartbeatLoop(IBridgeMessageChannel channel, ManualResetEvent connectionStop)
        {
            try
            {
                while (!stop.WaitOne(0) && !connectionStop.WaitOne(250))
                {
                    if (identityMonitor != null && identityMonitor.IsExpired())
                    {
                        InvalidateRoute(channel, connectionStop,
                            new TimeoutException("bridge_terminal_identity_observation_stale"));
                        return;
                    }
                    string heartbeat;
                    bool active;
                    if (!Monitor.TryEnter(controllerGate, 50)) continue;
                    try
                    {
                        active = controller.State == "active";
                        if (controller.HeartbeatExpired(UtcNowMsc()))
                        {
                            throw new TimeoutException("bridge_session_heartbeat_timeout");
                        }
                        heartbeat = controller.CreateHeartbeat(UtcNowMsc());
                    }
                    finally { Monitor.Exit(controllerGate); }
                    if (active)
                    {
                        if (!TryBeginOperation()) return;
                        try
                        {
                            if (heartbeat != null) channel.Send(heartbeat);
                            string accountStream;
                            lock (controllerGate) accountStream = controller.CreateAccountStream(UtcNowMsc());
                            if (accountStream != null) channel.Send(accountStream);
                            TrySendReleaseStatus(channel, UtcNowMsc());
                            outbox.FlushOne(runtime, channel, UtcNowMsc());
                        }
                        finally
                        {
                            EndOperation();
                        }
                    }
                }
            }
            catch (Exception error)
            {
                if (!stop.WaitOne(0) && !connectionStop.WaitOne(0) && !IsPausedForUpdate()) RaiseConnectionError(error);
                try { channel.Dispose(); } catch (Exception) { }
            }
        }

        private void TradeStreamsLoop(IBridgeMessageChannel channel, ManualResetEvent connectionStop)
        {
            while (!stop.WaitOne(0) && !connectionStop.WaitOne(0))
            {
                long cycleStarted = UtcNowMsc();
                bool active;
                lock (controllerGate) active = controller.State == "active";
                if (!active) { connectionStop.WaitOne(250); continue; }
                if (!TryBeginOperation()) return;
                try
                {
                    string[] messages = controller.ReadTradeStreams(UtcNowMsc());
                    if (stop.WaitOne(0) || connectionStop.WaitOne(0)) return;
                    foreach (string message in messages) channel.Send(message);
                }
                catch (Exception error)
                {
                    // A failed/incomplete read never becomes an empty authoritative collection.
                    if (!stop.WaitOne(0) && !connectionStop.WaitOne(0)) RaiseConnectionError(error);
                }
                finally { EndOperation(); }
                connectionStop.WaitOne((int)Math.Max(25, 1000 - (UtcNowMsc() - cycleStarted)));
            }
        }

        private void MarketStreamsLoop(IBridgeMessageChannel channel, ManualResetEvent connectionStop, bool quotes)
        {
            while (!stop.WaitOne(0) && !connectionStop.WaitOne(0))
            {
                long cycleStarted = UtcNowMsc();
                bool active;
                lock (controllerGate) active = controller.State == "active";
                if (!active) { connectionStop.WaitOne(250); continue; }
                if (!TryBeginOperation()) return;
                try
                {
                    string[] messages = quotes ? controller.ReadMarketQuotes(UtcNowMsc()) : controller.ReadMarketStreams(UtcNowMsc());
                    if (stop.WaitOne(0) || connectionStop.WaitOne(0)) return;
                    foreach (string message in messages) channel.Send(message);
                }
                catch (Exception error)
                {
                    // Failed market reads never produce fabricated prices.
                    if (!stop.WaitOne(0) && !connectionStop.WaitOne(0)) RaiseConnectionError(error);
                }
                finally { EndOperation(); }
                connectionStop.WaitOne((int)Math.Max(25, (quotes ? 1000 : 5000) - (UtcNowMsc() - cycleStarted)));
            }
        }

        private void ProjectionSyncLoop(ManualResetEvent connectionStop)
        {
            var coordinator = new ProjectionSyncCoordinator();
            string leaseOwner = "projection-" + Guid.NewGuid().ToString("N");
            int delay = 250;
            while (!stop.WaitOne(0) && !connectionStop.WaitOne(delay))
            {
                bool active;
                lock (controllerGate) active = controller.State == "active";
                if (!active) continue;
                if (!TryBeginOperation()) return;
                try
                {
                    ProjectionSyncRunResult result = coordinator.RunOne(runtime, projectionSource, leaseOwner, UtcNowMsc());
                    delay = result.Status == "idle" || result.Status == "retry_wait" ? 1000 : 100;
                }
                catch (Exception error)
                {
                    delay = 1000;
                    if (!stop.WaitOne(0) && !connectionStop.WaitOne(0)) RaiseConnectionError(error);
                }
                finally { EndOperation(); }
            }
        }

        private void IdentityLoop(IBridgeMessageChannel channel, ManualResetEvent connectionStop)
        {
            try
            {
                while (!stop.WaitOne(0) && !connectionStop.WaitOne(250))
                {
                    if (!identityMonitor.ProbeDue()) continue;
                    if (!TryBeginOperation()) return;
                    try { identityMonitor.Read(UtcNowMsc()); }
                    finally { EndOperation(); }
                }
            }
            catch (Exception error)
            {
                if (!stop.WaitOne(0) && !connectionStop.WaitOne(0) && !IsPausedForUpdate())
                    InvalidateRoute(channel, connectionStop, error);
            }
        }

        private void InvalidateRoute(IBridgeMessageChannel channel, ManualResetEvent connectionStop, Exception error)
        {
            lock (gate) routeInvalidated = true;
            connectionStop.Set();
            try { channel.Dispose(); } catch (Exception) { }
            RaiseConnectionError(error);
            RaiseStateChanged();
        }

        private bool TryBeginOperation()
        {
            lock (gate)
            {
                if (stopping || disposed || pausedForUpdate || routeInvalidated) return false;
                activeOperations++;
                return true;
            }
        }

        private void TrySendReleaseStatus(IBridgeMessageChannel channel, long nowUtcMsc)
        {
            lock (releaseStatusGate)
            {
                if (IsStoppingOrPaused()) return;
                if (releaseStatus == null || nowUtcMsc < nextReleaseStatusCheckUtcMsc) return;
                nextReleaseStatusCheckUtcMsc = checked(nowUtcMsc + 1000L);
                ReleaseActivationStatus status;
                try { status = releaseStatus.Read(); }
                catch (IOException) { nextReleaseStatusCheckUtcMsc = checked(nowUtcMsc + 30000L); return; }
                catch (UnauthorizedAccessException) { nextReleaseStatusCheckUtcMsc = checked(nowUtcMsc + 30000L); return; }
                catch (InvalidDataException) { nextReleaseStatusCheckUtcMsc = checked(nowUtcMsc + 30000L); return; }
                if (status == null || status.Fingerprint == lastReleaseStatusFingerprint) return;
                string envelope;
                lock (controllerGate) envelope = controller.CreateReleaseStatus(status, nowUtcMsc);
                if (IsStoppingOrPaused()) return;
                channel.Send(envelope);
                lastReleaseStatusFingerprint = status.Fingerprint;
            }
        }

        private void EndOperation()
        {
            lock (gate)
            {
                if (activeOperations < 1) throw new InvalidOperationException("bridge_worker_activity_invalid");
                activeOperations--;
            }
        }

        private bool IsPausedForUpdate()
        {
            lock (gate) return pausedForUpdate;
        }

        private bool IsStoppingOrPaused()
        {
            lock (gate) return stopping || pausedForUpdate || routeInvalidated;
        }

        private void SetActiveChannel(IBridgeMessageChannel channel)
        {
            lock (gate) activeChannel = channel;
        }

        private void RaiseConnectionError(Exception error)
        {
            EventHandler<BridgeWorkerErrorEventArgs> handler = ConnectionError;
            if (handler != null) handler(this, new BridgeWorkerErrorEventArgs(error));
        }

        private void RaiseStateChanged()
        {
            EventHandler handler = StateChanged;
            if (handler != null) handler(this, EventArgs.Empty);
        }

        private static long UtcNowMsc()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }
    }

    public sealed class BridgeWorkerErrorEventArgs : EventArgs
    {
        public BridgeWorkerErrorEventArgs(Exception errorValue) { Error = errorValue; }
        public Exception Error { get; private set; }
    }
}
