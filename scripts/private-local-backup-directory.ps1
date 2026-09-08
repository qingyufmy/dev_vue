param(
  [Parameter(Mandatory=$true)][ValidateSet('Create','Verify')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$Path
)
$ErrorActionPreference = 'Stop'
try {
  Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
  if (-not [System.IO.Path]::IsPathRooted($Path)) { throw 'path' }
  $backupDirectory = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($backupDirectory -eq [System.IO.Path]::GetPathRoot($backupDirectory).TrimEnd('\')) { throw 'root' }
  $ancestor = [System.IO.DirectoryInfo]::new($backupDirectory).Parent
  while ($null -ne $ancestor) {
    if (-not $ancestor.Exists -or ($ancestor.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'ancestor' }
    $ancestor = $ancestor.Parent
  }
  $backupOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemOwner = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  if ($Mode -eq 'Create') {
    if (Test-Path -LiteralPath $backupDirectory) { throw 'exists' }
    New-Item -ItemType Directory -Path $backupDirectory | Out-Null
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetOwner($backupOwner)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($principal in @($backupOwner, $systemOwner)) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl',
        'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $security.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $backupDirectory -AclObject $security
  }
  $item = Get-Item -LiteralPath $backupDirectory -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'directory' }
  $actual = Get-Acl -LiteralPath $backupDirectory
  if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $backupOwner.Value) { throw 'owner' }
  $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 2) { throw 'rules' }
  foreach ($principal in @($backupOwner, $systemOwner)) {
    $matching = @($rules | Where-Object { $_.IdentityReference.Value -eq $principal.Value })
    if ($matching.Count -ne 1 -or $matching[0].IsInherited -or $matching[0].AccessControlType -ne 'Allow' -or
      $matching[0].FileSystemRights -ne 'FullControl' -or [string]$matching[0].InheritanceFlags -ne 'ContainerInherit, ObjectInherit' -or
      $matching[0].PropagationFlags -ne 'None') { throw 'access' }
  }
  @{verified=$true;mode=$Mode;path=$backupDirectory;ownerSid=$backupOwner.Value;allowedPrincipals=@($backupOwner.Value,$systemOwner.Value)} | ConvertTo-Json -Compress
} catch {
  Write-Error 'local_backup_private_directory_failed'
  exit 1
}
