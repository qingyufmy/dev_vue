[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Encrypt', 'Decrypt')]
    [string]$Mode,

    [Parameter(Mandatory)]
    [string]$CredentialPath,

    [string]$RefreshToken,

    [long]$ExpiresAtUtcMsc,

    [string]$PlaintextOutputPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$entropy = [System.Text.Encoding]::UTF8.GetBytes('AURUM Bridge v3 refresh credential')
$plaintext = $null
try {
    if ($Mode -eq 'Encrypt') {
        if ($RefreshToken.Length -lt 40 -or $RefreshToken -notmatch '^[A-Za-z0-9]+$') {
            throw 'fixture_refresh_token_invalid'
        }
        $json = '{"RefreshToken":"' + $RefreshToken + '","ExpiresAtUtcMsc":' + $ExpiresAtUtcMsc + '}'
        $plaintext = [System.Text.Encoding]::UTF8.GetBytes($json)
        $ciphertext = [System.Security.Cryptography.ProtectedData]::Protect(
            $plaintext,
            $entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($CredentialPath)) | Out-Null
        [System.IO.File]::WriteAllBytes($CredentialPath, $ciphertext)
        return
    }

    if ([string]::IsNullOrWhiteSpace($PlaintextOutputPath)) {
        throw 'fixture_plaintext_output_required'
    }
    $ciphertext = [System.IO.File]::ReadAllBytes($CredentialPath)
    $plaintext = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $ciphertext,
        $entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [System.IO.File]::WriteAllBytes($PlaintextOutputPath, $plaintext)
} finally {
    if ($null -ne $plaintext) {
        [System.Array]::Clear($plaintext, 0, $plaintext.Length)
    }
    [System.Array]::Clear($entropy, 0, $entropy.Length)
}
