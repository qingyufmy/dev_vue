param(
    [ValidateSet('start','status','stop','check')][string]$Action = 'status',
    [ValidateSet('core','full')][string]$Profile = 'full',
    [switch]$Console
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot
if ($Action -eq 'start' -and -not $Console) {
    # Visible, persistent console explicitly requested for local services.
    $shellPath = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
    Start-Process -FilePath $shellPath -WorkingDirectory $repoRoot -WindowStyle Normal `
        -ArgumentList @('-NoProfile','-NoExit','-File',('"' + $PSCommandPath + '"'),'-Action','start','-Profile',$Profile,'-Console') | Out-Null
    Write-Host 'Console launch requested. Run status to verify service readiness.'
    return
}
if ($Console) { $Host.UI.RawUI.WindowTitle = "AURUM V4 local services ($Profile)" }
# Do not merge native stderr into the PowerShell error pipeline.
$ErrorActionPreference = 'Continue'
& node (Join-Path $PSScriptRoot 'local-v4.mjs') $Action $Profile
if (-not $Console) { exit $LASTEXITCODE }
