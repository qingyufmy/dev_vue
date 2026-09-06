using System;
using System.Collections.Generic;
using System.IO;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Storage;
using Liangjian.BridgeV4.Terminal;
using Liangjian.BridgeV4.Update;

namespace Liangjian.BridgeV4.Runtime
{
    public sealed class BridgeProfileConnectionSnapshot
    {
        public string ProfileId { get; internal set; }
        public string State { get; internal set; }
        public string ConnectionId { get; internal set; }
        public string TerminalState { get; internal set; }
        public string LastErrorCode { get; internal set; }
    }

    internal sealed class ManagedProfileConnection : IDisposable
    {
        private readonly object gate = new object();
        private readonly object disposeGate = new object();
        private readonly ProfileRuntime runtime;
        private readonly BridgeProfileWorker worker;
        private readonly Mt5WorkerHost mt5Live;
        private readonly Mt5WorkerHost mt5Archive;
        private readonly string terminalInstanceId;
        private readonly IDisposable profileLease;
        private readonly string profileId;
        private string lastErrorCode;
        private bool disposed;
        private bool stopping;
        private bool archiveClosed;
        private bool liveClosed;
        private bool runtimeClosed;

        public ManagedProfileConnection(ProfileRuntime runtimeValue, BridgeProfileWorker workerValue,
            string terminalId, Mt5WorkerHost liveHost, Mt5WorkerHost archiveHost, IDisposable lease)
            : this(runtimeValue, workerValue, terminalId, liveHost, archiveHost, lease, runtimeValue.Configuration.ProfileId)
        {
        }

        public ManagedProfileConnection(ProfileRuntime runtimeValue, BridgeProfileWorker workerValue,
            string terminalId, Mt5WorkerHost liveHost, Mt5WorkerHost archiveHost, IDisposable lease, string profileIdValue)
        {
            runtime = runtimeValue;
            worker = workerValue;
            terminalInstanceId = terminalId;
            mt5Live = liveHost;
            mt5Archive = archiveHost;
            profileLease = lease;
            profileId = profileIdValue;
            stopping = worker == null;
            if (worker != null)
            {
                worker.ConnectionError += OnConnectionError;
                worker.StateChanged += OnStateChanged;
            }
        }

        public event EventHandler StateChanged;

        public void Start()
        {
            if (worker == null) throw new InvalidOperationException("bridge_profile_cleanup_pending");
            worker.Start();
        }

        public UpdateActivitySnapshot ReadUpdateActivity()
        {
            lock (gate)
            {
                if (disposed) return new UpdateActivitySnapshot();
                if (stopping) return new UpdateActivitySnapshot { PendingCriticalWrites = 1 };
                CommandLedgerActivity ledger = runtime.CommandLedger.ReadUpdateActivity(
                    runtime.Configuration.ProfileId);
                return new UpdateActivitySnapshot
                {
                    ActiveCommands = ledger.ActiveCommands,
                    UncertainCommands = ledger.UncertainCommands,
                    PendingCriticalWrites = worker.ActiveOperations
                };
            }
        }

        public bool PauseForUpdate(int timeoutMilliseconds)
        {
            lock (gate) if (stopping || disposed) return false;
            return worker.PauseForUpdate(timeoutMilliseconds);
        }

        public PendingBridgeRelease ReadPendingRelease()
        {
            lock (gate) return stopping || disposed ? null : worker.PendingRelease;
        }

        public void ResumeAfterUpdate()
        {
            lock (gate) if (stopping || disposed) return;
            worker.ResumeAfterUpdate();
        }

        public BridgeProfileConnectionSnapshot Snapshot(string terminalState)
        {
            lock (gate)
            {
                return new BridgeProfileConnectionSnapshot
                {
                    ProfileId = profileId,
                    State = disposed ? "stopped" : stopping ? "stopping" : worker.State,
                    ConnectionId = stopping || disposed ? null : worker.ConnectionId,
                    TerminalState = terminalState,
                    LastErrorCode = lastErrorCode
                };
            }
        }

        public void Dispose()
        {
            lock (disposeGate)
            {
                lock (gate)
                {
                    if (disposed) return;
                    stopping = true;
                }
                // A timed-out worker still owns the runtime and profile lease.
                // Retain every resource and this connection so Stop can be retried.
                if (worker != null) worker.Dispose();
                List<Exception> errors = new List<Exception>();
                try { if (!archiveClosed && mt5Archive != null) mt5Archive.Disconnect(terminalInstanceId); archiveClosed = true; }
                catch (Exception error) { errors.Add(error); }
                try { if (!liveClosed && mt5Live != null) mt5Live.Disconnect(terminalInstanceId); liveClosed = true; }
                catch (Exception error) { errors.Add(error); }
                try { if (!runtimeClosed && runtime != null) runtime.Dispose(); runtimeClosed = true; }
                catch (Exception error) { errors.Add(error); }
                if (errors.Count != 0) throw new AggregateException("bridge_profile_close_failed", errors);
                profileLease.Dispose();
                if (worker != null)
                {
                    worker.ConnectionError -= OnConnectionError;
                    worker.StateChanged -= OnStateChanged;
                }
                lock (gate) disposed = true;
            }
            RaiseStateChanged();
        }

        private void OnConnectionError(object sender, BridgeWorkerErrorEventArgs eventArgs)
        {
            lock (gate)
            {
                lastErrorCode = SafeError(eventArgs.Error);
            }
            RaiseStateChanged();
        }

        private void OnStateChanged(object sender, EventArgs eventArgs)
        {
            RaiseStateChanged();
        }

        private void RaiseStateChanged()
        {
            EventHandler handler = StateChanged;
            if (handler != null) handler(this, EventArgs.Empty);
        }

        private static string SafeError(Exception error)
        {
            string value = error == null ? null : error.Message;
            if (string.IsNullOrWhiteSpace(value)) return "bridge_connection_failed";
            return value.Length <= 160 ? value : value.Substring(0, 160);
        }
    }

    public sealed class BridgeProfileConnectionManager : IDisposable
    {
        private readonly object gate = new object();
        private readonly object disposeGate = new object();
        private readonly Dictionary<string, ManagedProfileConnection> connections =
            new Dictionary<string, ManagedProfileConnection>(StringComparer.Ordinal);
        private sealed class StartAttempt { public bool Cancelled; }
        private readonly Dictionary<string, StartAttempt> pendingStarts =
            new Dictionary<string, StartAttempt>(StringComparer.Ordinal);
        private readonly TerminalSessionHost mt4Host;
        private readonly Mt5WorkerHost mt5Live = new Mt5WorkerHost("LiangjianBridgeV4.Mt5.Live");
        private readonly Mt5WorkerHost mt5Archive = new Mt5WorkerHost("LiangjianBridgeV4.Mt5.Archive");
        private readonly BridgeProfileStore profileStore;
        private readonly string installationId;
        private readonly string profileDataRoot;
        private readonly ReleaseActivationStatusStore releaseStatus;
        private readonly IBridgeSessionTokenProvider sessionTokens;
        private bool updateQuiescing;
        private int activeCreations;
        private bool disposed;
        private bool stopping;

        public BridgeProfileConnectionManager(TerminalSessionHost terminalHost, BridgeProfileStore store,
            string installationIdValue, string dataRoot, IBridgeSessionTokenProvider sessionTokenProvider)
        {
            if (terminalHost == null || store == null || string.IsNullOrWhiteSpace(installationIdValue)
                || string.IsNullOrWhiteSpace(dataRoot) || sessionTokenProvider == null)
                throw new ArgumentNullException("bridge_profile_connection_manager_configuration");
            mt4Host = terminalHost;
            profileStore = store;
            installationId = installationIdValue;
            profileDataRoot = Path.GetFullPath(dataRoot);
            sessionTokens = sessionTokenProvider;
            releaseStatus = new ReleaseActivationStatusStore(Path.Combine(profileDataRoot,
                "updates", "activation-status.json"));
        }

        public event EventHandler StateChanged;

        public void Start(BridgeProfileSettings profile)
        {
            BridgeProfileStore.ValidateProfile(profile, false);
            if (profile.RemovalPending) throw new InvalidOperationException("bridge_profile_removal_pending");
            StartAttempt attempt;
            lock (gate)
            {
                EnsureOpen();
                if (updateQuiescing) throw new InvalidOperationException("bridge_update_quiescing");
                if (connections.ContainsKey(profile.ProfileId) || pendingStarts.ContainsKey(profile.ProfileId)) return;
                attempt = new StartAttempt();
                pendingStarts.Add(profile.ProfileId, attempt);
                activeCreations++;
            }
            try { StartCore(profile, attempt); }
            finally
            {
                lock (gate) { activeCreations--; pendingStarts.Remove(profile.ProfileId); }
            }
        }

        private void StartCore(BridgeProfileSettings profile, StartAttempt attempt)
        {
            BridgeProfileStore.ValidateProfile(profile, false);
            lock (gate)
            {
                EnsureOpen();
                if (attempt.Cancelled) return;
                if (updateQuiescing) throw new InvalidOperationException("bridge_update_quiescing");
                if (connections.ContainsKey(profile.ProfileId)) return;
            }

            ManagedProfileConnection connection = Create(profile);
            connection.StateChanged += OnConnectionStateChanged;
            try
            {
                if (!RegisterAndStart(profile.ProfileId, attempt, connection))
                {
                    connection.Dispose();
                    connection.StateChanged -= OnConnectionStateChanged;
                    return;
                }
            }
            catch
            {
                DisposeAfterStartFailure(profile.ProfileId, connection);
                throw;
            }
            RaiseStateChanged();
        }

        private void DisposeAfterStartFailure(string profileId, ManagedProfileConnection connection)
        {
            // A cancelled/closing creation may never have reached registration.
            // Preserve its cleanup ownership if disposal fails too.
            lock (gate)
            {
                if (!connections.ContainsKey(profileId)) connections.Add(profileId, connection);
            }
            connection.Dispose();
            connection.StateChanged -= OnConnectionStateChanged;
            lock (gate)
            {
                ManagedProfileConnection current;
                if (connections.TryGetValue(profileId, out current) && ReferenceEquals(current, connection))
                    connections.Remove(profileId);
            }
        }

        private bool RegisterAndStart(string profileId, StartAttempt attempt, ManagedProfileConnection connection)
        {
            lock (gate)
            {
                EnsureOpen();
                if (updateQuiescing) throw new InvalidOperationException("bridge_update_quiescing");
                if (attempt.Cancelled || connections.ContainsKey(profileId)) return false;
                connections.Add(profileId, connection);
                connection.Start();
                return true;
            }
        }

        public bool Stop(string profileId)
        {
            ManagedProfileConnection connection = null;
            bool cancelledStart = false;
            lock (gate)
            {
                EnsureNotDisposed();
                if (profileId != null)
                {
                    StartAttempt attempt;
                    if (pendingStarts.TryGetValue(profileId, out attempt))
                    {
                        attempt.Cancelled = true;
                        cancelledStart = true;
                    }
                    connections.TryGetValue(profileId, out connection);
                }
            }
            if (connection == null) return cancelledStart;
            connection.Dispose();
            connection.StateChanged -= OnConnectionStateChanged;
            lock (gate)
            {
                ManagedProfileConnection current;
                if (connections.TryGetValue(profileId, out current) && ReferenceEquals(current, connection))
                    connections.Remove(profileId);
            }
            RaiseStateChanged();
            return true;
        }

        public BridgeProfileConnectionSnapshot Snapshot(BridgeProfileSettings profile)
        {
            if (profile == null) throw new ArgumentNullException("profile");
            ManagedProfileConnection connection;
            lock (gate)
            {
                EnsureNotDisposed();
                if (!connections.TryGetValue(profile.ProfileId, out connection))
                {
                    return new BridgeProfileConnectionSnapshot
                    {
                        ProfileId = profile.ProfileId, State = "stopped", ConnectionId = null,
                        TerminalState = TerminalState(profile), LastErrorCode = null
                    };
                }
            }
            return connection.Snapshot(TerminalState(profile));
        }

        public UpdateActivitySnapshot ReadUpdateActivity()
        {
            List<ManagedProfileConnection> active;
            lock (gate)
            {
                EnsureOpen();
                active = new List<ManagedProfileConnection>(connections.Values);
            }
            return SumActivity(active);
        }

        public IList<PendingBridgeRelease> ReadObservedReleases()
        {
            List<ManagedProfileConnection> active;
            lock (gate)
            {
                EnsureOpen();
                active = new List<ManagedProfileConnection>(connections.Values);
            }
            Dictionary<string, PendingBridgeRelease> unique =
                new Dictionary<string, PendingBridgeRelease>(StringComparer.Ordinal);
            foreach (ManagedProfileConnection connection in active)
            {
                PendingBridgeRelease release = connection.ReadPendingRelease();
                if (release != null) unique[release.ReleaseId] = release;
            }
            return new List<PendingBridgeRelease>(unique.Values);
        }

        public bool TryQuiesceForUpdate(int timeoutMilliseconds, out UpdateActivitySnapshot activity)
        {
            if (timeoutMilliseconds < 1 || timeoutMilliseconds > 60000)
                throw new ArgumentOutOfRangeException("timeoutMilliseconds");
            List<ManagedProfileConnection> active;
            lock (gate)
            {
                EnsureOpen();
                if (updateQuiescing)
                {
                    activity = SumActivity(new List<ManagedProfileConnection>(connections.Values));
                    return false;
                }
                updateQuiescing = true;
                active = new List<ManagedProfileConnection>(connections.Values);
            }

            activity = SumActivity(active);
            if (!IsIdle(activity))
            {
                CancelQuiescence(active);
                return false;
            }

            List<ManagedProfileConnection> paused = new List<ManagedProfileConnection>();
            for (int index = 0; index < active.Count; index++)
            {
                if (!active[index].PauseForUpdate(timeoutMilliseconds))
                {
                    CancelQuiescence(paused);
                    activity = SumActivity(active);
                    return false;
                }
                paused.Add(active[index]);
            }

            activity = SumActivity(active);
            if (!IsIdle(activity))
            {
                CancelQuiescence(paused);
                return false;
            }
            return true;
        }

        public void ResumeAfterUpdate()
        {
            List<ManagedProfileConnection> active;
            lock (gate)
            {
                EnsureOpen();
                active = new List<ManagedProfileConnection>(connections.Values);
                updateQuiescing = false;
            }
            foreach (ManagedProfileConnection connection in active) connection.ResumeAfterUpdate();
            RaiseStateChanged();
        }

        public void Dispose()
        {
            lock (disposeGate) DisposeCore();
        }

        private void DisposeCore()
        {
            List<ManagedProfileConnection> active;
            lock (gate)
            {
                if (disposed) return;
                stopping = true;
                updateQuiescing = false;
                active = new List<ManagedProfileConnection>(connections.Values);
            }
            List<Exception> errors = new List<Exception>();
            foreach (ManagedProfileConnection connection in active)
            {
                try
                {
                    connection.Dispose();
                    connection.StateChanged -= OnConnectionStateChanged;
                    lock (gate)
                    {
                        string key = null;
                        foreach (KeyValuePair<string, ManagedProfileConnection> item in connections)
                            if (ReferenceEquals(item.Value, connection)) { key = item.Key; break; }
                        if (key != null) connections.Remove(key);
                    }
                }
                catch (Exception error) { errors.Add(error); }
            }
            lock (gate)
            {
                if (activeCreations != 0) errors.Add(new InvalidOperationException("bridge_profile_creation_stop_pending"));
            }
            if (errors.Count != 0) throw new AggregateException("bridge_connections_stop_pending", errors);
            try { mt5Archive.Dispose(); } catch (Exception error) { errors.Add(error); }
            try { mt5Live.Dispose(); } catch (Exception error) { errors.Add(error); }
            if (errors.Count != 0) throw new AggregateException("bridge_hosts_close_failed", errors);
            lock (gate) disposed = true;
        }

        private ManagedProfileConnection Create(BridgeProfileSettings profile)
        {
            IDisposable lease = ProfileAccountDataLocation.AcquireLease(profileDataRoot, profile);
            return Create(profile, lease);
        }

        private ManagedProfileConnection Create(BridgeProfileSettings profile, IDisposable lease)
        {
            ProfileRuntime runtime = null;
            bool liveConnected = false;
            bool archiveConnected = false;
            try
            {
                ProfileAccountDataLocation location = ProfileAccountDataLocation.Resolve(profileDataRoot, profile);
                string directory = location.DirectoryPath;
                string databasePath = location.DatabasePath;
                long epoch = location.ConnectionEpoch;
                runtime = new ProfileRuntime(new ProfileRuntimeConfiguration(databasePath,
                    profile.ProfileId, profile.TerminalInstanceId, profile.Platform, profile.BrokerServer,
                    profile.Login, epoch));
                ITerminalQuerySource terminal;
                ITerminalCommandSource commands;
                Mt5WorkerHost live = null;
                Mt5WorkerHost archive = null;
                if (profile.Platform == "mt5")
                {
                    long workerEpoch = checked(epoch + 1);
                    string liveDiagnostics = Path.Combine(directory, "worker-live-diagnostics.json");
                    string archiveDiagnostics = Path.Combine(directory, "worker-archive-diagnostics.json");
                    mt5Live.Connect(new Mt5WorkerConfiguration(profile.PythonExecutablePath,
                        profile.WorkerScriptPath, profile.TerminalPath, profile.TerminalInstanceId,
                        profile.BrokerServer, profile.Login, workerEpoch, "live", liveDiagnostics));
                    liveConnected = true;
                    live = mt5Live;
                    mt5Archive.Connect(new Mt5WorkerConfiguration(profile.PythonExecutablePath,
                        profile.WorkerScriptPath, profile.TerminalPath, profile.TerminalInstanceId,
                        profile.BrokerServer, profile.Login, workerEpoch, "archive", archiveDiagnostics));
                    archiveConnected = true;
                    archive = mt5Archive;
                    terminal = new Mt5WorkerQuerySource(mt5Live);
                    commands = new Mt5TerminalCommandSource(mt5Live);
                }
                else
                {
                    terminal = new TerminalPipeQuerySource(mt4Host);
                    commands = new Mt4TerminalCommandSource(mt4Host);
                }
                BridgeProfileSession session = new BridgeProfileSession(runtime, terminal, commands);
                BridgeSessionConfiguration configuration = SessionConfiguration(profile);
                BridgeTerminalIdentityMonitor identityMonitor = new BridgeTerminalIdentityMonitor(delegate(long nowUtcMsc)
                {
                    return BridgeAccountFacts.Read(runtime, terminal, nowUtcMsc);
                });
                configuration.AccountFactsProvider = identityMonitor.Read;
                BridgeSessionController controller = new BridgeSessionController(runtime, session, configuration);
                Func<string> acquireSessionToken = delegate
                {
                    string refreshToken = profileStore.ReadRefreshToken(profile);
                    try
                    {
                        BridgeSessionToken sessionToken = sessionTokens.Acquire(profile, refreshToken);
                        if (sessionToken == null || string.IsNullOrWhiteSpace(sessionToken.AccessToken))
                            throw new InvalidDataException("bridge_session_token_invalid");
                        return sessionToken.AccessToken;
                    }
                    finally
                    {
                        refreshToken = null;
                    }
                };
                BridgeProfileWorker worker = new BridgeProfileWorker(runtime, controller,
                    new Rfc6455MessageChannelFactory(new Uri(profile.ServerUri),
                        acquireSessionToken, 15000), releaseStatus, identityMonitor);
                return new ManagedProfileConnection(runtime, worker, profile.TerminalInstanceId, live, archive, lease);
            }
            catch
            {
                ManagedProfileConnection cleanup = new ManagedProfileConnection(runtime, null,
                    profile.TerminalInstanceId, liveConnected ? mt5Live : null,
                    archiveConnected ? mt5Archive : null, lease, profile.ProfileId);
                cleanup.StateChanged += OnConnectionStateChanged;
                DisposeAfterStartFailure(profile.ProfileId, cleanup);
                throw;
            }
        }

        private BridgeSessionConfiguration SessionConfiguration(BridgeProfileSettings profile)
        {
            string version = "unknown";
            string permission = "unknown";
            int? offset = null;
            string clock = "unavailable";
            if (profile.Platform == "mt4")
            {
                foreach (TerminalSessionSnapshot session in mt4Host.Snapshot())
                {
                    if (session.TerminalInstanceId == profile.TerminalInstanceId
                        && session.BrokerServer == profile.BrokerServer && session.Login == profile.Login)
                    {
                        version = session.TerminalBuild.ToString();
                        permission = session.TradeAllowed ? "full" : "read_only";
                        offset = session.ServerOffsetMinutes;
                        clock = session.ClockStatus;
                        break;
                    }
                }
            }
            return new BridgeSessionConfiguration
            {
                InstallationId = installationId,
                BridgeVersion = "4.0.0",
                TerminalVersion = version,
                TradePermission = permission,
                TimezoneOffsetMinutes = offset,
                ClockStatus = NormalizeClock(clock)
            };
        }

        private string TerminalState(BridgeProfileSettings profile)
        {
            if (profile.Platform == "mt5")
            {
                foreach (Mt5WorkerSessionSnapshot session in mt5Live.Snapshot())
                    if (session.TerminalInstanceId == profile.TerminalInstanceId) return session.Connected ? "connected" : "disconnected";
                return "disconnected";
            }
            foreach (TerminalSessionSnapshot session in mt4Host.Snapshot())
                if (session.TerminalInstanceId == profile.TerminalInstanceId
                    && session.BrokerServer == profile.BrokerServer && session.Login == profile.Login)
                    return session.Connected ? "connected" : "disconnected";
            return "disconnected";
        }

        private void OnConnectionStateChanged(object sender, EventArgs eventArgs) { RaiseStateChanged(); }
        private void CancelQuiescence(IList<ManagedProfileConnection> paused)
        {
            foreach (ManagedProfileConnection connection in paused) connection.ResumeAfterUpdate();
            lock (gate) if (!disposed) updateQuiescing = false;
            RaiseStateChanged();
        }
        private static UpdateActivitySnapshot SumActivity(IList<ManagedProfileConnection> active)
        {
            UpdateActivitySnapshot total = new UpdateActivitySnapshot();
            foreach (ManagedProfileConnection connection in active)
            {
                UpdateActivitySnapshot item = connection.ReadUpdateActivity();
                total.ActiveCommands = checked(total.ActiveCommands + item.ActiveCommands);
                total.UncertainCommands = checked(total.UncertainCommands + item.UncertainCommands);
                total.PendingCriticalWrites = checked(total.PendingCriticalWrites + item.PendingCriticalWrites);
            }
            return total;
        }
        private static bool IsIdle(UpdateActivitySnapshot activity)
        {
            return activity.ActiveCommands == 0 && activity.UncertainCommands == 0
                && activity.PendingCriticalWrites == 0;
        }
        private void RaiseStateChanged() { EventHandler handler = StateChanged; if (handler != null) handler(this, EventArgs.Empty); }
        private void EnsureOpen() { if (stopping || disposed) throw new ObjectDisposedException("BridgeProfileConnectionManager"); }
        private void EnsureNotDisposed() { if (disposed) throw new ObjectDisposedException("BridgeProfileConnectionManager"); }
        private static string NormalizeClock(string value)
        {
            return value == "calibrated" || value == "observer_bootstrap" || value == "stale" ? value : "unavailable";
        }
    }
}
