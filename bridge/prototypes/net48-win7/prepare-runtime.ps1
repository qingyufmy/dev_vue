param([string]$OutputRoot = '', [switch]$Offline)

$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $prototypeRoot 'runtime-win7.lock.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$cacheRoot = Join-Path $prototypeRoot '.packages'
if (!$OutputRoot) { $OutputRoot = Join-Path $cacheRoot ('runtime-v4-' + [guid]::NewGuid().ToString('N')) }
$resolvedOutput = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $resolvedOutput) { throw 'bridge_runtime_output_must_be_new' }
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Only fixed upstream binary archives are accepted. No system Python, pip,
# user site-packages, installed V3 runtime, or executable test fixture is used.
foreach ($package in $manifest.packages) {
    $archive = Join-Path $cacheRoot $package.file
    if (!(Test-Path -LiteralPath $archive)) {
        if ($Offline) { throw "bridge_runtime_archive_missing: $($package.file)" }
        Invoke-WebRequest -Uri $package.url -OutFile $archive
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash -ne $package.sha256) {
        throw "bridge_runtime_archive_hash_invalid: $($package.file)"
    }
}
New-Item -ItemType Directory -Path $resolvedOutput | Out-Null
foreach ($package in $manifest.packages) {
    $archive = Join-Path $cacheRoot $package.file
    $destination = [IO.Path]::GetFullPath((Join-Path $resolvedOutput $package.destination))
    if ($destination -ne $resolvedOutput -and !$destination.StartsWith($resolvedOutput + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'bridge_runtime_destination_invalid'
    }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $destination)
}
Set-Content -LiteralPath (Join-Path $resolvedOutput 'python38._pth') -Encoding ASCII -Value @('python38.zip', '.', 'Lib/site-packages')
$python = Join-Path $resolvedOutput 'python.exe'
$signature = Get-AuthenticodeSignature -LiteralPath $python
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Python Software Foundation') {
    throw 'bridge_runtime_python_signature_invalid'
}
$verificationScript = Join-Path $resolvedOutput 'verify_runtime.py'
@'
import json
import struct
import sys
import numpy
import MetaTrader5
assert sys.version_info[:3] == (3, 8, 10)
assert struct.calcsize("P") == 8
assert numpy.__version__ == "1.24.4"
assert MetaTrader5.__version__ == "5.0.5735"
print(json.dumps({"python": sys.version.split()[0], "numpy": numpy.__version__, "mt5": MetaTrader5.__version__}))
'@ | Set-Content -LiteralPath $verificationScript -Encoding ASCII
$verification = & $python -I $verificationScript
if ($LASTEXITCODE -ne 0) { throw 'bridge_runtime_import_verification_failed' }
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $resolvedOutput 'runtime.lock.json')
[pscustomobject]@{ RuntimeRoot = $resolvedOutput; PythonPath = $python; Verification = $verification }
