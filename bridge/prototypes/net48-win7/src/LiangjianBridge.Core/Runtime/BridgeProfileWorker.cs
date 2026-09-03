using System;
using System.IO;
using System.Threading;
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
            if (uriValue == null || uriValue.Scheme != "wss" || sessionTokenProviderValue == null
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
        private readonly object releaseStatusGate = new object();
        private readonly ProfileRuntime runtime;
        private readonly BridgeSessionController controller;
        private readonly IBridgeMessageChannelFactory factory;
        private readonly ProfileOutboxCoordinator outbox = new ProfileOutboxCoordinator();
        private readonly ReleaseActivationStatusStore releaseStatus;
        private readonly ManualResetEvent stop = new ManualResetEvent(false);
        private Thread thread;
        private IBridgeMessageChannel activeChannel;
        private int activeOperations;
        private bool pausedForUpdate;
        private bool disposed;
        private string lastReleaseStatusFingerprint;
        private long nextReleaseStatusCheckUtcMsc;

        public BridgeProfileWorker(ProfileRuntime runtimeValue, BridgeSessionController controllerValue,
            IBridgeMessageChannelFactory factoryValue)
            : this(runtimeValue, controllerValue, factoryValue, null)
        {
        }

        public BridgeProfileWorker(ProfileRuntime runtimeValue, BridgeSessionController controllerValue,
            IBridgeMessageChannelFactory factoryValue, ReleaseActivationStatusStore statusStore)
        {
            if (runtimeValue == null || controllerValue == null || factoryValue == null)
            {
                throw new ArgumentNullException("runtimeValue");
            }
            runtime = runtimeValue;
            controller = controllerValue;
            factory = factoryValue;
            releaseStatus = statusStore;
        }

        public event EventHandler<BridgeWorkerErrorEventArgs> ConnectionError;
        public event EventHandler StateChanged;

        public string State
        {
            get { lock (gate) return disposed ? "stopped" : pausedForUpdate ? "update_wait" : controller.State; }
        }

        public string ConnectionId
        {
            get { lock (gate) return controller.ConnectionId; }
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
                if (disposed) throw new ObjectDisposedException("BridgeProfileWorker");
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
                if (disposed) return false;
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
                if (disposed) return;
                pausedForUpdate = false;
            }
            RaiseStateChanged();
        }

        public void Dispose()
        {
            Thread current;
            IBridgeMessageChannel channel;
            lock (gate)
            {
                if (disposed) return;
                disposed = true;
                stop.Set();
                current = thread;
                thread = null;
                channel = activeChannel;
                activeChannel = null;
            }
            if (channel != null) channel.Dispose();
            if (current != null && current != Thread.CurrentThread) current.Join(5000);
            stop.Dispose();
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
                long now = UtcNowMsc();
                if (!controller.CanConnect(now))
                {
                    int delay = (int)Math.Min(1000L, Math.Max(1L, controller.NextConnectAtUtcMsc - now));
                    stop.WaitOne(delay);
                    continue;
                }
                IBridgeMessageChannel channel = null;
                ManualResetEvent connectionStop = new ManualResetEvent(false);
                Thread heartbeat = null;
                try
                {
                    channel = factory.Connect();
                    SetActiveChannel(channel);
                    channel.Send(controller.Begin(UtcNowMsc()));
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
                    while (!stop.WaitOne(0) && !connectionStop.WaitOne(0))
                    {
                        string incoming = channel.Receive();
                        if (incoming == null) break;
                        if (!TryBeginOperation()) break;
                        try
                        {
                            string response;
                            lock (gate)
                            {
                                response = controller.Handle(incoming, UtcNowMsc());
                            }
                            RaiseStateChanged();
                            if (response != null)
                            {
                                channel.Send(response);
                                lock (gate) controller.AfterResponseSent(UtcNowMsc());
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
                    if (!stop.WaitOne(0) && !IsPausedForUpdate()) RaiseConnectionError(error);
                }
                finally
                {
                    connectionStop.Set();
                    if (channel != null) channel.Dispose();
                    SetActiveChannel(null);
                    if (heartbeat != null && heartbeat != Thread.CurrentThread) heartbeat.Join(2000);
                    connectionStop.Dispose();
                }
                if (!stop.WaitOne(0))
                {
                    lock (gate) controller.MarkDisconnected(UtcNowMsc());
                    RaiseStateChanged();
                }
            }
        }

        private void HeartbeatLoop(IBridgeMessageChannel channel, WaitHandle connectionStop)
        {
            try
            {
                while (!stop.WaitOne(0) && !connectionStop.WaitOne(250))
                {
                    string heartbeat;
                    bool active;
                    lock (gate)
                    {
                        active = controller.State == "active";
                        if (controller.HeartbeatExpired(UtcNowMsc()))
                        {
                            throw new TimeoutException("bridge_session_heartbeat_timeout");
                        }
                        heartbeat = controller.CreateHeartbeat(UtcNowMsc());
                    }
                    if (active)
                    {
                        if (!TryBeginOperation()) return;
                        try
                        {
                            if (heartbeat != null) channel.Send(heartbeat);
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

        private bool TryBeginOperation()
        {
            lock (gate)
            {
                if (disposed || pausedForUpdate) return false;
                activeOperations++;
                return true;
            }
        }

        private void TrySendReleaseStatus(IBridgeMessageChannel channel, long nowUtcMsc)
        {
            lock (releaseStatusGate)
            {
                if (releaseStatus == null || nowUtcMsc < nextReleaseStatusCheckUtcMsc) return;
                nextReleaseStatusCheckUtcMsc = checked(nowUtcMsc + 1000L);
                ReleaseActivationStatus status;
                try { status = releaseStatus.Read(); }
                catch (IOException) { nextReleaseStatusCheckUtcMsc = checked(nowUtcMsc + 30000L); return; }
                catch (UnauthorizedAccessException) { nextReleaseStatusCheckUtcMsc = checked(nowUtcMsc + 30000L); return; }
                catch (InvalidDataException) { nextReleaseStatusCheckUtcMsc = checked(nowUtcMsc + 30000L); return; }
                if (status == null || status.Fingerprint == lastReleaseStatusFingerprint) return;
                string envelope;
                lock (gate) envelope = controller.CreateReleaseStatus(status, nowUtcMsc);
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
