using System;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;

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
            IAsyncResult wait = pipe.BeginWaitForConnection(null, null);
            WaitHandle waitHandle = wait.AsyncWaitHandle;
            if (!waitHandle.WaitOne(timeoutMilliseconds))
            {
                Dispose();
                try
                {
                    pipe.EndWaitForConnection(wait);
                }
                catch (ObjectDisposedException)
                {
                }
                catch (IOException)
                {
                }
                finally
                {
                    waitHandle.Close();
                }
                throw new TimeoutException("bridge_pipe_connect_timeout");
            }
            try
            {
                pipe.EndWaitForConnection(wait);
            }
            finally
            {
                waitHandle.Close();
            }
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
}
