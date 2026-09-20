using System;
using System.Net;

namespace Liangjian.BridgeV4.Transport
{
    public static class WebSocketEndpointPolicy
    {
        public static bool IsAllowed(Uri uri)
        {
            if (uri == null || !uri.IsAbsoluteUri || string.IsNullOrEmpty(uri.Host)
                || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Fragment)) return false;
            if (uri.Scheme == "wss") return true;
            if (uri.Scheme != "ws") return false;
            IPAddress address;
            return string.Equals(uri.DnsSafeHost, "localhost", StringComparison.OrdinalIgnoreCase)
                || (IPAddress.TryParse(uri.DnsSafeHost, out address) && IPAddress.IsLoopback(address));
        }
    }
}
