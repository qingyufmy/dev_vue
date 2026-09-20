using System;
using System.IO;
using System.Threading;
using Liangjian.BridgeV4.Configuration;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class ApplicationInstanceSmokeTests
    {
        public static void RunAll()
        {
            string root = Path.Combine(Path.GetTempPath(), "bridge-instance-" + Guid.NewGuid().ToString("N"));
            Assert(BridgeApplicationInstance.InstanceKey(root, "user-a") ==
                BridgeApplicationInstance.InstanceKey(root.ToUpperInvariant() + "\\", "user-a"), "instance_path_normalization_failed");
            Assert(BridgeApplicationInstance.InstanceKey(root, "user-a") !=
                BridgeApplicationInstance.InstanceKey(root, "user-b"), "instance_user_isolation_failed");
            Assert(BridgeApplicationInstance.InstanceKey(root, "user-a") !=
                BridgeApplicationInstance.InstanceKey(root + "-other", "user-a"), "instance_directory_isolation_failed");
            using (ManualResetEvent activated = new ManualResetEvent(false))
            using (BridgeApplicationInstance primary = new BridgeApplicationInstance(root, "smoke-user"))
            {
                Assert(primary.IsPrimary, "initial_instance_not_primary");
                primary.Listen(delegate { activated.Set(); });
                Exception failure = null;
                Thread second = new Thread(delegate()
                {
                    try
                    {
                        using (BridgeApplicationInstance duplicate = new BridgeApplicationInstance(root, "smoke-user"))
                        {
                            Assert(!duplicate.IsPrimary, "duplicate_instance_acquired_catalog");
                            duplicate.NotifyPrimary();
                        }
                    }
                    catch (Exception error) { failure = error; }
                });
                second.Start();
                Assert(second.Join(5000), "duplicate_instance_blocked");
                if (failure != null) throw failure;
                Assert(activated.WaitOne(5000), "duplicate_activation_not_delivered");
            }
            using (BridgeApplicationInstance next = new BridgeApplicationInstance(root, "smoke-user"))
                Assert(next.IsPrimary, "closed_instance_retained_lock");
            Mutex abandonedMutex = null;
            Thread abandoned = new Thread(delegate()
            {
                // Simulate a crashed owner thread; the next launch must recover.
                abandonedMutex = new Mutex(false, "Global\\LiangjianBridgeV4.Instance." +
                    BridgeApplicationInstance.InstanceKey(root, "abandoned-smoke-user"));
                abandonedMutex.WaitOne();
            });
            abandoned.Start();
            Assert(abandoned.Join(5000), "abandoned_fixture_blocked");
            using (BridgeApplicationInstance recovered = new BridgeApplicationInstance(root, "abandoned-smoke-user"))
                Assert(recovered.IsPrimary, "abandoned_instance_not_recovered");
            abandonedMutex.Dispose();
        }

        private static void Assert(bool value, string code) { if (!value) throw new InvalidOperationException(code); }
    }
}
