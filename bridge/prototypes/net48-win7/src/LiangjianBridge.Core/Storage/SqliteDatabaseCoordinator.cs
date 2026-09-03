using System;
using System.Collections.Generic;
using System.IO;

namespace Liangjian.BridgeV4.Storage
{
    /// <summary>
    /// Coordinates writes made by the command ledger and the profile data store
    /// when they share one SQLite file. SQLite still provides the cross-process
    /// lock; this gate avoids avoidable SQLITE_BUSY races inside Bridge Core.
    /// </summary>
    internal static class SqliteDatabaseCoordinator
    {
        private static readonly object registryLock = new object();
        private static readonly Dictionary<string, object> writeGates =
            new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);

        public static object GetWriteGate(string databasePath)
        {
            string fullPath = Path.GetFullPath(databasePath);
            lock (registryLock)
            {
                object gate;
                if (!writeGates.TryGetValue(fullPath, out gate))
                {
                    gate = new object();
                    writeGates.Add(fullPath, gate);
                }
                return gate;
            }
        }
    }
}
