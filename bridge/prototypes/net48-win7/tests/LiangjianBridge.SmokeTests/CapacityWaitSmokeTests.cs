using System;
using System.IO;
using System.Threading;
using Liangjian.BridgeV4.Runtime;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static partial class SessionLifecycleSmokeTests
    {
        public static void TestCapacityWait()
        {
            string root = NewRoot("capacity-wait");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                {
                    CapacityDeniedFactory factory = new CapacityDeniedFactory();
                    using (BridgeProfileWorker worker = new BridgeProfileWorker(runtime, Controller(runtime), factory))
                    {
                        worker.Start();
                        WaitUntil(delegate { return worker.State == "capacity_wait"; }, 3000, "capacity_wait_missing");
                        Thread.Sleep(3500);
                        Assert(factory.Attempts == 1, "quota_full_retried_without_capacity");
                        Assert(worker.ResumeForAvailableCapacity(), "capacity_release_did_not_resume");
                        WaitUntil(delegate { return factory.Attempts == 2 && worker.State == "capacity_wait"; }, 4000, "quota_resume_failed");
                        Assert(factory.Attempts == 2, "duplicate_capacity_resume");
                    }
                }
            }
            finally { DeleteRoot(root); }
        }
        private sealed class CapacityDeniedFactory : IBridgeMessageChannelFactory
        {
            public int Attempts;
            public IBridgeMessageChannel Connect()
            {
                Interlocked.Increment(ref Attempts);
                throw new InvalidDataException("bridge_capacity_exceeded");
            }
        }
    }
}
