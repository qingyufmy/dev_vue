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
        private readonly ProfileRuntime runtime;
        private readonly BridgeProfileWorker worker;
        private readonly Mt5WorkerHost mt5Live;
        private readonly Mt5WorkerHost mt5Archive;
        private readonly string terminalInstanceId;
        private readonly IDisposable profileLease;
        private string lastErrorCode;
        private bool disposed;

        public ManagedProfileConnection(ProfileRuntime runtimeValue, BridgeProfileWorker workerValue,
            string terminalId, Mt5WorkerHost liveHost, Mt5WorkerHost archiveHost, IDisposable lease)
        {
            runtime = runtimeValue;
            worker = workerValue;
            terminalInstanceId = terminalId;
            mt5Live = liveHost;
            mt5Archive = archiveHost;
            profileLease = lease;
            worker.ConnectionError += OnConnectionError;
            worker.StateChanged += OnStateChanged;
        }

        public event EventHandler StateChanged;

        public void Start()
        {
            worker.Start();
        }

        public UpdateActivitySnapshot ReadUpdateActivity()
        {
            lock (gate)
            {
                if (disposed) return new UpdateActivitySnapshot();
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
            lock (gate) if (disposed) return false;
            return worker.PauseForUpdate(timeoutMilliseconds);
        }

        public PendingBridgeRelease ReadPendingRelease()
        {
            lock (gate) return disposed ? null : worker.PendingRelease;
        }

        public void ResumeAfterUpdate()
        {
            lock (gate) if (disposed) return;
            worker.ResumeAfterUpdate();
        }

        public BridgeProfileConnectionSnapshot Snapshot(string terminalState)
        {
            lock (gate)
            {
                return new BridgeProfileConnectionSnapshot
                {
                    ProfileId = runtime.Configuration.ProfileId,
                    State = disposed ? "stopped" : worker.State,
                    ConnectionId = disposed ? null : worker.ConnectionId,
                    TerminalState = terminalState,
                    LastErrorCode = lastErrorCode
                };
            }
        }

        public void Dispose()
        {
            lock (gate)
            {
                if (disposed) return;
                disposed = true;
            }
            worker.ConnectionError -= OnConnectionError;
            worker.StateChanged -= OnStateChanged;
            worker.Dispose();
            if (mt5Archive != null) mt5Archive.Disconnect(terminalInstanceId);
            if (mt5Live != null) mt5Live.Disconnect(terminalInstanceId);
            try { runtime.Dispose(); }
            finally { profileLease.Dispose(); }
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
        private readonly Dictionary<string, ManagedProfileConnection> connections =
            new Dictionary<string, ManagedProfileConnection>(StringComparer.Ordinal);
        private readonly TerminalSessionHost mt4Host;
        private readonly Mt5WorkerHost mt5Live = new Mt5WorkerHost("LiangjianBridgeV4.Mt5.Live");
        private readonly Mt5WorkerHost mt5Archive = new Mt5WorkerHost("LiangjianBridgeV4.Mt5.Archive");
        private readonly BridgeProfileStore profileStore;
        private readonly string installationId;
        private readonly string profileDataRoot;
        private readonly ReleaseActivationStatusStore releaseStatus;
        private readonly IBridgeSessionTokenProvider sessionTokens;
        private bool updateQuiescing;
        private bool disposed;

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
            lock (gate)
            {
                EnsureOpen();
                if (updateQuiescing) throw new InvalidOperationException("bridge_update_quiescing");
                if (connections.ContainsKey(profile.ProfileId)) return;
            }

            ManagedProfileConnection connection = Create(profile);
            connection.StateChanged += OnConnectionStateChanged;
            try
            {
                lock (gate)
                {
                    EnsureOpen();
                    if (connections.ContainsKey(profile.ProfileId))
                    {
                        connection.Dispose();
                        return;
                    }
                    connections.Add(profile.ProfileId, connection);
                }
            }
            catch
            {
                connection.StateChanged -= OnConnectionStateChanged;
                connection.Dispose();
                throw;
            }
            try
            {
                connection.Start();
            }
            catch
            {
                Stop(profile.ProfileId);
                throw;
            }
            RaiseStateChanged();
        }

        public bool Stop(string profileId)
        {
            ManagedProfileConnection connection = null;
            lock (gate)
            {
                EnsureOpen();
                if (profileId != null && connections.TryGetValue(profileId, out connection))
                    connections.Remove(profileId);
            }
            if (connection == null) return false;
            connection.StateChanged -= OnConnectionStateChanged;
            connection.Dispose();
            RaiseStateChanged();
            return true;
        }

        public BridgeProfileConnectionSnapshot Snapshot(BridgeProfileSettings profile)
        {
            if (profile == null) throw new ArgumentNullException("profile");
            ManagedProfileConnection connection;
            lock (gate)
            {
                EnsureOpen();
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
            List<ManagedProfileConnection> active;
            lock (gate)
            {
                if (disposed) return;
                disposed = true;
                updateQuiescing = false;
                active = new List<ManagedProfileConnection>(connections.Values);
                connections.Clear();
            }
            foreach (ManagedProfileConnection connection in active)
            {
                connection.StateChanged -= OnConnectionStateChanged;
                connection.Dispose();
            }
            mt5Archive.Dispose();
            mt5Live.Dispose();
        }

        private ManagedProfileConnection Create(BridgeProfileSettings profile)
        {
            IDisposable lease = ProfileAccountDataLocation.AcquireLease(profileDataRoot, profile);
            try { return Create(profile, lease); }
            catch { lease.Dispose(); throw; }
        }

        private ManagedProfileConnection Create(BridgeProfileSettings profile, IDisposable lease)
        {
            ProfileAccountDataLocation location = ProfileAccountDataLocation.Resolve(profileDataRoot, profile);
            string directory = location.DirectoryPath;
            string databasePath = location.DatabasePath;
            long epoch = location.ConnectionEpoch;
            ProfileRuntime runtime = new ProfileRuntime(new ProfileRuntimeConfiguration(databasePath,
                profile.ProfileId, profile.TerminalInstanceId, profile.Platform, profile.BrokerServer,
                profile.Login, epoch));
            bool liveConnected = false;
            bool archiveConnected = false;
            try
            {
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
                BridgeSessionController controller = new BridgeSessionController(runtime, session,
                    SessionConfiguration(profile));
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
                        acquireSessionToken, 15000), releaseStatus);
                return new ManagedProfileConnection(runtime, worker, profile.TerminalInstanceId, live, archive, lease);
            }
            catch
            {
                if (archiveConnected) mt5Archive.Disconnect(profile.TerminalInstanceId);
                if (liveConnected) mt5Live.Disconnect(profile.TerminalInstanceId);
                runtime.Dispose();
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
        private void EnsureOpen() { if (disposed) throw new ObjectDisposedException("BridgeProfileConnectionManager"); }
        private static string NormalizeClock(string value)
        {
            return value == "calibrated" || value == "observer_bootstrap" || value == "stale" ? value : "unavailable";
        }
    }
}
