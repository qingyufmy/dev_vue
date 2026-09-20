using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.App
{
    internal sealed class BridgeClientOptions
    {
        public string ApiBase { get; private set; }
        public string WebBase { get; private set; }
        public string GatewayBase { get; private set; }
        public string RealtimeUri
        {
            get { Uri gateway = new Uri(GatewayBase); return (gateway.Scheme == "https" ? "wss://" : "ws://") + gateway.Authority + "/bridge/v4/ws"; }
        }

        public BridgeClientOptions(string apiBase, string webBase, string gatewayBase)
        {
            Uri api = Origin(apiBase), web = Origin(webBase), gateway = Origin(gatewayBase);
            if (!string.Equals(api.Host, gateway.Host, StringComparison.OrdinalIgnoreCase)
                || api.Scheme != web.Scheme || api.Scheme != gateway.Scheme) throw Invalid();
            ApiBase = api.GetLeftPart(UriPartial.Authority);
            WebBase = web.GetLeftPart(UriPartial.Authority);
            GatewayBase = gateway.GetLeftPart(UriPartial.Authority);
        }

        public static BridgeClientOptions Load(string programDirectory)
        {
            try
            {
                string path = Path.Combine(Path.GetFullPath(programDirectory), "bridge-client.json");
                if (!File.Exists(path) || new FileInfo(path).Length > 16384) throw Invalid();
                JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 4 };
                IDictionary<string, object> data = json.DeserializeObject(File.ReadAllText(path, Encoding.UTF8)) as IDictionary<string, object>;
                if (data == null || data.Count != 3 || !data.ContainsKey("api_base") || !data.ContainsKey("web_base") || !data.ContainsKey("gateway_base")) throw Invalid();
                return new BridgeClientOptions(data["api_base"] as string, data["web_base"] as string, data["gateway_base"] as string);
            }
            catch (Exception) { throw Invalid(); }
        }

        public Uri ConfirmationUri(string confirmationPath)
        {
            const string prefix = "/bridge/authorize?request=";
            if (confirmationPath == null || !confirmationPath.StartsWith(prefix, StringComparison.Ordinal)) throw Invalid();
            string id = confirmationPath.Substring(prefix.Length);
            if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\z")) throw Invalid();
            return new Uri(WebBase + prefix + id);
        }

        private static Uri Origin(string value)
        {
            Uri uri;
            if (string.IsNullOrWhiteSpace(value) || value.IndexOf('\\') >= 0
                || !Uri.TryCreate(value, UriKind.Absolute, out uri) || uri.UserInfo.Length != 0
                || uri.AbsolutePath != "/" || uri.Query.Length != 0 || uri.Fragment.Length != 0
                || (uri.Scheme != "https" && uri.Scheme != "http")) throw Invalid();
            IPAddress address;
            bool loopback = string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase)
                || (IPAddress.TryParse(uri.Host, out address) && IPAddress.IsLoopback(address));
            if (uri.Scheme == "http" && !loopback) throw Invalid();
            return uri;
        }
        private static InvalidDataException Invalid() { return new InvalidDataException("bridge_client_options_invalid"); }
    }
}
