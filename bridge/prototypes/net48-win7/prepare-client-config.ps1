param(
    [Parameter(Mandatory = $true)][string]$ClientConfigPath,
    [string]$OutputRoot = '',
    [switch]$Release
)
$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (!(Test-Path -LiteralPath $ClientConfigPath -PathType Leaf)) { throw 'bridge_client_config_missing' }
if (!(('Liangjian.BridgeV4.App.BridgeClientConfigBuildValidator' -as [type]))) {
    # Compile the actual client origin policy, so build and application cannot drift.
    $policySource = Get-Content -LiteralPath (Join-Path $prototypeRoot 'src\LiangjianBridge\BridgeClientOptions.cs') -Raw
    $validatorSource = @'
namespace Liangjian.BridgeV4.App {
    public static class BridgeClientConfigBuildValidator {
        public static string Validate(string path, bool release) {
            if (new System.IO.FileInfo(path).Length > 16384) throw new System.IO.InvalidDataException("bridge_client_options_invalid");
            var json = new System.Web.Script.Serialization.JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 4 };
            var data = json.DeserializeObject(System.IO.File.ReadAllText(path, System.Text.Encoding.UTF8)) as System.Collections.Generic.IDictionary<string, object>;
            if (data == null || data.Count != 3 || !data.ContainsKey("api_base") || !data.ContainsKey("web_base") || !data.ContainsKey("gateway_base"))
                throw new System.IO.InvalidDataException("bridge_client_options_invalid");
            var options = new BridgeClientOptions(data["api_base"] as string, data["web_base"] as string, data["gateway_base"] as string);
            if (release) {
                foreach (string origin in new[] { options.ApiBase, options.WebBase, options.GatewayBase }) {
                    var uri = new System.Uri(origin);
                    System.Net.IPAddress address;
                    if (uri.Scheme != "https" || uri.IsLoopback ||
                        (System.Net.IPAddress.TryParse(uri.Host, out address) && System.Net.IPAddress.IsLoopback(address)))
                        throw new System.IO.InvalidDataException("bridge_release_client_origin_invalid");
                }
            }
            return json.Serialize(new { api_base = options.ApiBase, web_base = options.WebBase, gateway_base = options.GatewayBase });
        }
    }
}
'@
    Add-Type -TypeDefinition ($policySource + [Environment]::NewLine + $validatorSource) -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Web.Extensions.dll')
}
$resolvedConfig = (Resolve-Path -LiteralPath $ClientConfigPath).ProviderPath
$normalized = [Liangjian.BridgeV4.App.BridgeClientConfigBuildValidator]::Validate($resolvedConfig, [bool]$Release)
if ($OutputRoot) {
    $resolvedOutput = [IO.Path]::GetFullPath($OutputRoot)
    New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $resolvedOutput 'bridge-client.json'), $normalized, (New-Object Text.UTF8Encoding($false)))
}
Write-Output 'bridge_client_config_valid'
