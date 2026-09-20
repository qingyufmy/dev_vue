using System;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace Liangjian.BridgeV4.Configuration
{
    // Own this lease on the application thread for the entire UI lifetime.
    public sealed class BridgeApplicationInstance : IDisposable
    {
        private readonly Mutex mutex;
        private readonly EventWaitHandle activation;
        private RegisteredWaitHandle listener;
        private bool owns;

        public BridgeApplicationInstance(string dataRoot)
            : this(dataRoot, WindowsIdentity.GetCurrent().User.Value) { }

        public BridgeApplicationInstance(string dataRoot, string userIdentity)
        {
            string key = InstanceKey(dataRoot, userIdentity);
            activation = new EventWaitHandle(false, EventResetMode.AutoReset, "Global\\LiangjianBridgeV4.Activate." + key);
            try
            {
                mutex = new Mutex(false, "Global\\LiangjianBridgeV4.Instance." + key);
                try { owns = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { owns = true; }
            }
            catch { activation.Dispose(); throw; }
        }

        public bool IsPrimary { get { return owns; } }

        public static string InstanceKey(string dataRoot, string userIdentity)
        {
            if (string.IsNullOrWhiteSpace(userIdentity)) throw new ArgumentException("bridge_instance_user_invalid");
            string root = Path.GetFullPath(dataRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).ToUpperInvariant();
            using (SHA256 hash = SHA256.Create())
                return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(userIdentity + "\n" + root))).Replace("-", string.Empty);
        }

        public void NotifyPrimary() { activation.Set(); }

        public void Listen(Action activate)
        {
            if (!owns || listener != null || activate == null) throw new InvalidOperationException("bridge_instance_listener_invalid");
            listener = ThreadPool.RegisterWaitForSingleObject(activation,
                delegate(object state, bool timedOut) { activate(); }, null, Timeout.Infinite, false);
        }

        public void Dispose()
        {
            if (listener != null) { listener.Unregister(null); listener = null; }
            if (owns) { mutex.ReleaseMutex(); owns = false; }
            mutex.Dispose();
            activation.Dispose();
        }
    }
}
