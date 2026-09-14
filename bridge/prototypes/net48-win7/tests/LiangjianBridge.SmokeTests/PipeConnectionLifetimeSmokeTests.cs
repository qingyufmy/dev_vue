using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Threading;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class PipeConnectionLifetimeSmokeTests
    {
        public static void RunAll()
        {
            List<Exception> errors = new List<Exception>();
            Thread[] threads = new Thread[8];
            for (int index = 0; index < threads.Length; index++)
            {
                int worker = index;
                threads[index] = new Thread(delegate()
                {
                    try
                    {
                        for (int round = 0; round < 32; round++)
                        {
                            bool mt5 = (worker % 2) == 0;
                            Exercise(mt5, "timeout");
                            Exercise(mt5, "cancel");
                            Exercise(mt5, "connect");
                        }
                    }
                    catch (Exception error) { lock (errors) { errors.Add(error); } }
                });
                threads[index].IsBackground = true;
                threads[index].Start();
            }
            foreach (Thread thread in threads)
            {
                if (!thread.Join(30000)) throw new Exception("pipe_lifetime_stress_did_not_finish");
            }
            // Allow late native completion callbacks to run before reporting success.
            Thread.Sleep(250);
            if (errors.Count != 0) throw new AggregateException(errors);
        }

        private static void Exercise(bool mt5, string mode)
        {
            string name = "Liangjian.PipeLifetime." + Guid.NewGuid().ToString("N");
            IDisposable owner;
            Action<int> wait;
            if (mt5)
            {
                NamedPipeServerStream pipe = new NamedPipeServerStream(name, PipeDirection.InOut,
                    1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                owner = pipe;
                Type session = typeof(Mt5WorkerHost).Assembly.GetType("Liangjian.BridgeV4.Terminal.Mt5WorkerSession", true);
                MethodInfo method = session.GetMethod("WaitForConnection", BindingFlags.NonPublic | BindingFlags.Static);
                wait = delegate(int timeout)
                {
                    try { method.Invoke(null, new object[] { pipe, timeout }); }
                    catch (TargetInvocationException error) { throw error.InnerException; }
                };
            }
            else
            {
                TerminalPipeServer pipe = new TerminalPipeServer(name);
                owner = pipe;
                wait = pipe.WaitForConnection;
            }
            using (owner)
            {
                if (mode == "timeout")
                {
                    try { wait(100); }
                    catch (TimeoutException error)
                    {
                        string expected = mt5 ? "bridge_mt5_worker_connect_timeout" : "bridge_pipe_connect_timeout";
                        if (error.Message != expected) throw new Exception("pipe_timeout_code_changed", error);
                        return;
                    }
                    throw new Exception("pipe_without_client_did_not_timeout");
                }
                Exception failure = null;
                using (ManualResetEvent started = new ManualResetEvent(false))
                {
                    Thread waiter = new Thread(delegate()
                    {
                        started.Set();
                        try { wait(2000); } catch (Exception error) { failure = error; }
                    });
                    waiter.IsBackground = true;
                    waiter.Start();
                    started.WaitOne();
                    if (mode == "cancel")
                    {
                        Thread.Sleep(1);
                        owner.Dispose();
                    }
                    else
                    {
                        using (NamedPipeClientStream client = new NamedPipeClientStream(".", name, PipeDirection.InOut))
                        {
                            client.Connect(2000);
                            if (!waiter.Join(3000)) throw new Exception("connected_pipe_wait_did_not_finish");
                        }
                    }
                    if (!waiter.Join(3000)) throw new Exception("cancelled_pipe_wait_did_not_finish");
                    if (mode == "connect" && failure != null) throw new Exception("pipe_connection_failed", failure);
                    if (mode == "cancel" && !(failure is ObjectDisposedException) && !(failure is IOException))
                        throw new Exception("pipe_cancel_exception_changed", failure);
                }
            }
        }
    }
}
