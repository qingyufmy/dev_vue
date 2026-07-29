[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('HoldForActivation', 'ProbeDuplicate')]
    [string]$Mode,

    [Parameter(Mandatory)]
    [string]$InstanceId,

    [Parameter(Mandatory)]
    [string]$LockDirectory,

    [Parameter(Mandatory)]
    [string]$ResultFile,

    [string]$ReadyFile,

    [int]$TimeoutMilliseconds = 5000
)

$ErrorActionPreference = 'Stop'
[System.IO.Directory]::CreateDirectory($LockDirectory) | Out-Null
$activation = [System.Threading.EventWaitHandle]::new(
    $false,
    [System.Threading.EventResetMode]::AutoReset,
    "Local\$InstanceId.activate")
$shutdown = [System.Threading.EventWaitHandle]::new(
    $false,
    [System.Threading.EventResetMode]::AutoReset,
    "Local\$InstanceId.shutdown")
$lockStream = $null
try {
    $lockPath = [System.IO.Path]::Combine($LockDirectory, "$InstanceId.lock")
    if ($Mode -eq 'ProbeDuplicate') {
        try {
            $lockStream = [System.IO.FileStream]::new(
                $lockPath,
                [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None,
                1,
                [System.IO.FileOptions]::WriteThrough)
            [System.IO.File]::WriteAllText($ResultFile, 'acquired')
        } catch [System.IO.IOException] {
            $activation.Set() | Out-Null
            [System.IO.File]::WriteAllText($ResultFile, 'duplicate')
        }
        return
    }

    if ([string]::IsNullOrWhiteSpace($ReadyFile)) {
        throw 'fixture_ready_file_required'
    }
    $lockStream = [System.IO.FileStream]::new(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None,
        1,
        [System.IO.FileOptions]::WriteThrough)
    [System.IO.File]::WriteAllText($ReadyFile, 'ready')
    $activated = $activation.WaitOne($TimeoutMilliseconds)
    [System.IO.File]::WriteAllText(
        $ResultFile,
        $(if ($activated) { 'activated' } else { 'timeout' }))
    if (-not $activated) {
        exit 2
    }
} finally {
    if ($null -ne $lockStream) {
        $lockStream.Dispose()
    }
    $activation.Dispose()
    $shutdown.Dispose()
}
