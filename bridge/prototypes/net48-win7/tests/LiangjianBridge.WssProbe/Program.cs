using System;
using Liangjian.BridgeV4.Transport;

namespace Liangjian.BridgeV4.WssProbe
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            if (args.Length != 1)
            {
                Console.Error.WriteLine("usage: LiangjianBridge.WssProbe.exe wss://host/path");
                return 2;
            }

            try
            {
                Uri uri = new Uri(args[0], UriKind.Absolute);
                const string message = "bridge-v4-net48-wss-probe";
                using (Rfc6455Transport transport = new Rfc6455Transport())
                {
                    transport.Connect(uri, "prototype-non-secret-token", 15000);
                    transport.SendText(message);
                    string response = transport.ReceiveText();
                    if (!string.Equals(message, response, StringComparison.Ordinal))
                    {
                        Console.Error.WriteLine("FAIL bridge_wss_echo_mismatch");
                        return 1;
                    }
                }
                Console.WriteLine("PASS bridge_wss_tls12_echo");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("FAIL bridge_wss_tls12_echo " + error.GetType().Name + " " + error.Message);
                return 1;
            }
        }
    }
}
