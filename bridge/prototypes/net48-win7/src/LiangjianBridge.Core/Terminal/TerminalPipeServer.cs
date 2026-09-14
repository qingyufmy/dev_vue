using System;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;

namespace Liangjian.BridgeV4.Terminal
{
    public sealed class TerminalPipeServer : IDisposable
    {
        private readonly NamedPipeServerStream pipe;
        private bool disposed;

        public TerminalPipeServer(string pipeName)
        {
            ValidatePipeName(pipeName);
            PipeSecurity security = new PipeSecurity();
            SecurityIdentifier currentUser = WindowsIdentity.GetCurrent().User;
            if (currentUser == null)
            {
                throw new InvalidOperationException("bridge_pipe_user_identity_missing");
            }
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new PipeAccessRule(currentUser, PipeAccessRights.FullControl, AccessControlType.Allow));

            pipe = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                16,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous,
                4096,
                4096,
                security);
        }

        public void WaitForConnection(int timeoutMilliseconds)
        {
            if (timeoutMilliseconds < 100 || timeoutMilliseconds > 60000)
            {
                throw new ArgumentOutOfRangeException("timeoutMilliseconds");
            }
            PipeConnectionWait.Wait(pipe, timeoutMilliseconds, "bridge_pipe_connect_timeout");
        }

        public string ReadJson()
        {
            EnsureConnected();
            return PipeFrameCodec.ReadJson(pipe);
        }

        public void WriteJson(string json)
        {
            EnsureConnected();
            PipeFrameCodec.WriteJson(pipe, json);
        }

        public byte[] ReadPayload()
        {
            EnsureConnected();
            return PipeFrameCodec.ReadPayload(pipe);
        }

        public void WritePayload(byte[] payload)
        {
            EnsureConnected();
            PipeFrameCodec.WritePayload(pipe, payload);
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            pipe.Dispose();
        }

        private void EnsureConnected()
        {
            if (disposed || !pipe.IsConnected)
            {
                throw new InvalidOperationException("bridge_pipe_not_connected");
            }
        }

        private static void ValidatePipeName(string pipeName)
        {
            if (string.IsNullOrWhiteSpace(pipeName) || pipeName.Length > 128)
            {
                throw new ArgumentException("bridge_pipe_name_invalid", "pipeName");
            }
            for (int index = 0; index < pipeName.Length; index++)
            {
                char value = pipeName[index];
                if (!char.IsLetterOrDigit(value) && value != '-' && value != '_' && value != '.')
                {
                    throw new ArgumentException("bridge_pipe_name_invalid", "pipeName");
                }
            }
        }
    }

    internal static class PipeConnectionWait
    {
        internal static void Wait(NamedPipeServerStream server, int timeoutMilliseconds, string timeoutCode)
        {
            // FromAsync owns the APM completion lifetime. Never close AsyncWaitHandle:
            // on .NET 4.8 Dispose can return before the IO callback signals that handle.
            Task connection = Task.Factory.FromAsync(server.BeginWaitForConnection,
                server.EndWaitForConnection, null);
            connection.ContinueWith(delegate(Task completed) { GC.KeepAlive(completed.Exception); },
                CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted
                    | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            bool completedInTime;
            try
            {
                completedInTime = connection.Wait(timeoutMilliseconds);
            }
            catch (AggregateException)
            {
                connection.GetAwaiter().GetResult();
                throw;
            }
            if (!completedInTime)
            {
                server.Dispose();
                throw new TimeoutException(timeoutCode);
            }
            connection.GetAwaiter().GetResult();
        }
    }

}
