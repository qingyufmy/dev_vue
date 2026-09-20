using System;
using System.IO.Pipes;
using System.Threading;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class TerminalHeartbeatSmokeTests
    {
        public static void RunAll()
        {
            Exercise(true);
            Exercise(true, 1);
            Exercise(true, 0);
            Exercise(true, 1, true);
            Exercise(false);
        }

        private static void Exercise(bool respond, int permission = -1, bool detailed = false)
        {
            string name = "BridgeHeartbeatTest-" + Guid.NewGuid().ToString("N");
            Exception clientError = null;
            using (ManualResetEvent release = new ManualResetEvent(false))
            using (TerminalPipeServer server = new TerminalPipeServer(name))
            {
                Thread clientThread = new Thread(delegate()
                {
                    try
                    {
                        using (NamedPipeClientStream client = new NamedPipeClientStream(".", name, PipeDirection.InOut))
                        {
                            client.Connect(3000);
                            TerminalWireWriter hello = new TerminalWireWriter();
                            hello.WriteInt32(1); hello.WriteInt32(1);
                            foreach (string value in new[] { "4.0.0", "mt4", "C:\\HeartbeatTest", "C:\\MT4", "Demo", "10001" }) hello.WriteString(value);
                            hello.WriteInt32(1475); hello.WriteInt32(1); hello.WriteInt32(0); hello.WriteInt32(180);
                            hello.WriteString("calibrated"); hello.WriteInt64(1788307200000);
                            PipeFrameCodec.WritePayload(client, hello.ToArray());
                            PipeFrameCodec.ReadPayload(client);
                            byte[] ping = PipeFrameCodec.ReadPayload(client);
                            if (ping.Length != 4 || BitConverter.ToInt32(ping, 0) != 90) throw new Exception("ping_invalid");
                            if (respond)
                            {
                                TerminalWireWriter pong = new TerminalWireWriter();
                                pong.WriteInt32(91); pong.WriteInt64(1788307200000);
                                if (permission >= 0) { pong.WriteInt32(1); pong.WriteInt32(permission); }
                                if (detailed) { pong.WriteInt32(1); pong.WriteInt32(0); pong.WriteInt32(1); pong.WriteInt32(1); }
                                PipeFrameCodec.WritePayload(client, pong.ToArray());
                            }
                            release.WaitOne(8000);
                        }
                    }
                    catch (Exception error) { clientError = error; }
                });
                clientThread.IsBackground = true;
                clientThread.Start();
                try
                {
                    using (TerminalReadOnlySession session = TerminalReadOnlySession.Accept(server, 3000))
                    {
                        Exception failure = null;
                        DateTime started = DateTime.UtcNow;
                        try { session.CheckHeartbeat(); } catch (Exception error) { failure = error; }
                        if (respond && failure != null) throw failure;
                        if (detailed && (session.CurrentPermissionFlags == null || session.CurrentPermissionFlags[1] != 0))
                            throw new Exception("heartbeat_detailed_permissions_invalid");
                        if (respond && session.CurrentTradePermission != (permission < 0 ? (bool?)null : permission == 1))
                            throw new Exception("heartbeat_permission_invalid");
                        if (!respond && (failure == null || (DateTime.UtcNow - started).TotalSeconds > 7))
                            throw new Exception("silent_adapter_not_closed_within_deadline");
                    }
                }
                finally { release.Set(); clientThread.Join(3000); }
                if (clientError != null) throw clientError;
            }
        }
    }
}
