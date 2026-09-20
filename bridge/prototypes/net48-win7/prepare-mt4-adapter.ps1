param(
    [string]$OutputRoot = '',
    [string]$MetaEditor = 'C:\Program Files (x86)\MetaTrader 4\metaeditor.exe',
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (!$OutputRoot) { $OutputRoot = Join-Path $prototypeRoot 'artifacts\adapters\mt4' }
$resolvedOutput = [IO.Path]::GetFullPath($OutputRoot)
$sourceFiles = @('mt4\BridgeV4MT4.mq4', 'common\BridgeV4Pipe.mqh')
$sources = @{}
foreach ($relative in $sourceFiles) {
    $sources[$relative] = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $prototypeRoot "adapters\$relative")).Hash
}
$binary = Join-Path $resolvedOutput 'BridgeV4MT4.ex4'
$manifestPath = Join-Path $resolvedOutput 'build-manifest.json'
if ($VerifyOnly) {
    if (!(Test-Path -LiteralPath $manifestPath) -or !(Test-Path -LiteralPath $binary)) { throw 'bridge_mt4_current_build_missing' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($relative in $sourceFiles) {
        if ($manifest.sources.$relative -ne $sources[$relative]) { throw 'bridge_mt4_source_changed_rebuild_required' }
    }
    if ($manifest.binarySha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash) { throw 'bridge_mt4_binary_hash_invalid' }
    Write-Output $binary
    return
}
if (!(Test-Path -LiteralPath $MetaEditor) -or (Get-Item -LiteralPath $MetaEditor).Length -lt 1048576) { throw 'bridge_mt4_compiler_missing' }
$signature = Get-AuthenticodeSignature -LiteralPath $MetaEditor
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'MetaQuotes') { throw 'bridge_mt4_compiler_untrusted' }
$staging = Join-Path $prototypeRoot ('.packages\mt4-build-' + [guid]::NewGuid().ToString('N'))
foreach ($relative in $sourceFiles) {
    $target = Join-Path $staging $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $prototypeRoot "adapters\$relative") -Destination $target
}
$source = Join-Path $staging 'mt4\BridgeV4MT4.mq4'
$process = Start-Process -FilePath $MetaEditor -ArgumentList @('/compile:"' + $source + '"', '/log') -WindowStyle Hidden -Wait -PassThru
$log = [IO.Path]::ChangeExtension($source, '.log')
$compiled = [IO.Path]::ChangeExtension($source, '.ex4')
if (!(Test-Path -LiteralPath $log) -or !(Test-Path -LiteralPath $compiled)) { throw 'bridge_mt4_compile_output_missing' }
if ((Get-Content -LiteralPath $log -Raw) -notmatch 'Result:\s*0 errors,\s*0 warnings') { throw 'bridge_mt4_compile_failed' }
foreach ($relative in $sourceFiles) {
    if ($sources[$relative] -ne (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $prototypeRoot "adapters\$relative")).Hash) { throw 'bridge_mt4_source_changed_during_build' }
}
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null
Copy-Item -LiteralPath $compiled -Destination $binary
Copy-Item -LiteralPath $log -Destination (Join-Path $resolvedOutput 'compile.log')
@{ schemaVersion = 1; sources = $sources; binarySha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash;
   compilerSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $MetaEditor).Hash;
   compilerVersion = (Get-Item -LiteralPath $MetaEditor).VersionInfo.FileVersion } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Write-Output $binary
