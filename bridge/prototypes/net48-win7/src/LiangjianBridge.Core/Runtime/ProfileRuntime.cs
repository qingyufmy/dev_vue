using System;
using System.Collections.Generic;
using System.IO;
using Liangjian.BridgeV4.Storage;

namespace Liangjian.BridgeV4.Runtime
{
    public sealed class ProfileRuntimeConfiguration
    {
        public ProfileRuntimeConfiguration(
            string databasePath,
            string profileId,
            string terminalInstanceId,
            string platform,
            string brokerServer,
            string login,
            long connectionEpoch)
        {
            DatabasePath = databasePath;
            ProfileId = profileId;
            TerminalInstanceId = terminalInstanceId;
            Platform = platform;
            BrokerServer = brokerServer;
            Login = login;
            ConnectionEpoch = connectionEpoch;
        }

        public string DatabasePath { get; private set; }
        public string ProfileId { get; private set; }
        public string TerminalInstanceId { get; private set; }
        public string Platform { get; private set; }
        public string BrokerServer { get; private set; }
        public string Login { get; private set; }
        public long ConnectionEpoch { get; private set; }
    }

    public sealed class ProfileRuntime : IDisposable
    {
        private readonly ProfileRuntimeConfiguration configuration;
        private bool disposed;
        private bool ledgerClosed;
        private bool dataClosed;

        public ProfileRuntime(ProfileRuntimeConfiguration configuration)
        {
            if (configuration == null)
            {
                throw new ArgumentNullException("configuration");
            }
            this.configuration = configuration;
            DataStore = new ProfileDataStore(
                configuration.DatabasePath,
                configuration.ProfileId,
                configuration.TerminalInstanceId,
                configuration.Platform,
                configuration.BrokerServer,
                configuration.Login,
                configuration.ConnectionEpoch);
            try
            {
                CommandLedger = new CommandLedger(configuration.DatabasePath);
            }
            catch
            {
                DataStore.Dispose();
                throw;
            }
        }

        public ProfileRuntimeConfiguration Configuration
        {
            get { return configuration; }
        }

        public ProfileDataStore DataStore { get; private set; }
        public CommandLedger CommandLedger { get; private set; }

        public long ConnectionEpoch
        {
            get { return DataStore.ConnectionEpoch; }
        }

        public void RebindEpoch(long connectionEpoch)
        {
            EnsureNotDisposed();
            DataStore.RebindEpoch(connectionEpoch);
        }

        public void ValidateRoute(
            string terminalInstanceId,
            string brokerServer,
            string login,
            long connectionEpoch)
        {
            EnsureNotDisposed();
            DataStore.ValidateRoute(
                configuration.ProfileId,
                terminalInstanceId,
                configuration.Platform,
                brokerServer,
                login,
                connectionEpoch);
        }

        public bool MatchesIdentity(ProfileRuntimeConfiguration candidate)
        {
            return candidate != null
                && string.Equals(Path.GetFullPath(configuration.DatabasePath), Path.GetFullPath(candidate.DatabasePath), StringComparison.OrdinalIgnoreCase)
                && string.Equals(configuration.ProfileId, candidate.ProfileId, StringComparison.Ordinal)
                && string.Equals(configuration.TerminalInstanceId, candidate.TerminalInstanceId, StringComparison.Ordinal)
                && string.Equals(configuration.Platform, candidate.Platform, StringComparison.OrdinalIgnoreCase)
                && string.Equals(configuration.BrokerServer, candidate.BrokerServer, StringComparison.Ordinal)
                && string.Equals(configuration.Login, candidate.Login, StringComparison.Ordinal);
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            List<Exception> errors = new List<Exception>();
            try { if (!ledgerClosed) CommandLedger.Dispose(); ledgerClosed = true; }
            catch (Exception error) { errors.Add(error); }
            try { if (!dataClosed) DataStore.Dispose(); dataClosed = true; }
            catch (Exception error) { errors.Add(error); }
            if (errors.Count != 0) throw new AggregateException("bridge_runtime_close_failed", errors);
            disposed = true;
        }

        private void EnsureNotDisposed()
        {
            if (disposed)
            {
                throw new ObjectDisposedException("ProfileRuntime");
            }
        }
    }

    public sealed class ProfileRuntimeRegistry : IDisposable
    {
        private readonly object gate = new object();
        private readonly Dictionary<string, ProfileRuntime> runtimes =
            new Dictionary<string, ProfileRuntime>(StringComparer.Ordinal);
        private bool disposed;

        public int Count
        {
            get
            {
                lock (gate)
                {
                    return runtimes.Count;
                }
            }
        }

        public ProfileRuntime Open(ProfileRuntimeConfiguration configuration)
        {
            if (configuration == null || string.IsNullOrWhiteSpace(configuration.ProfileId))
            {
                throw new InvalidDataException("bridge_runtime_profile_invalid");
            }
            lock (gate)
            {
                EnsureNotDisposed();
                ProfileRuntime existing;
                if (runtimes.TryGetValue(configuration.ProfileId, out existing))
                {
                    if (!existing.MatchesIdentity(configuration))
                    {
                        throw new InvalidDataException("bridge_runtime_profile_rebind_required");
                    }
                    existing.RebindEpoch(configuration.ConnectionEpoch);
                    return existing;
                }
                ProfileRuntime runtime = new ProfileRuntime(configuration);
                runtimes.Add(configuration.ProfileId, runtime);
                return runtime;
            }
        }

        public ProfileRuntime Replace(ProfileRuntimeConfiguration configuration)
        {
            if (configuration == null || string.IsNullOrWhiteSpace(configuration.ProfileId))
            {
                throw new InvalidDataException("bridge_runtime_profile_invalid");
            }
            lock (gate)
            {
                EnsureNotDisposed();
                ProfileRuntime existing;
                if (runtimes.TryGetValue(configuration.ProfileId, out existing))
                {
                    runtimes.Remove(configuration.ProfileId);
                    existing.Dispose();
                }
                ProfileRuntime runtime = new ProfileRuntime(configuration);
                runtimes.Add(configuration.ProfileId, runtime);
                return runtime;
            }
        }

        public ProfileRuntime Get(string profileId)
        {
            lock (gate)
            {
                EnsureNotDisposed();
                ProfileRuntime runtime;
                return runtimes.TryGetValue(profileId, out runtime) ? runtime : null;
            }
        }

        public bool Remove(string profileId)
        {
            lock (gate)
            {
                EnsureNotDisposed();
                ProfileRuntime runtime;
                if (!runtimes.TryGetValue(profileId, out runtime))
                {
                    return false;
                }
                runtimes.Remove(profileId);
                runtime.Dispose();
                return true;
            }
        }

        public void Dispose()
        {
            lock (gate)
            {
                if (disposed)
                {
                    return;
                }
                disposed = true;
                foreach (ProfileRuntime runtime in runtimes.Values)
                {
                    runtime.Dispose();
                }
                runtimes.Clear();
            }
        }

        private void EnsureNotDisposed()
        {
            if (disposed)
            {
                throw new ObjectDisposedException("ProfileRuntimeRegistry");
            }
        }
    }
}
