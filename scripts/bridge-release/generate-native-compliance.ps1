param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$CargoManifest,
  [ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$Target = 'x86_64-pc-windows-msvc',
  [string[]]$NativeExecutable = @(),
  [string[]]$StagedDirectory = @(),
  [string]$PythonRuntimeDirectory,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Get-TextSha256([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Value)
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  }
  finally {
    $sha.Dispose()
  }
}

function Get-PeImports([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
    throw 'release_native_pe_invalid'
  }
  $peOffset = [BitConverter]::ToUInt32($bytes, 0x3c)
  if ($peOffset -gt ($bytes.Length - 256) -or
    [BitConverter]::ToUInt32($bytes, [int]$peOffset) -ne 0x00004550) {
    throw 'release_native_pe_invalid'
  }
  $sectionCount = [BitConverter]::ToUInt16($bytes, [int]$peOffset + 6)
  $optionalSize = [BitConverter]::ToUInt16($bytes, [int]$peOffset + 20)
  $optionalOffset = [int]$peOffset + 24
  $magic = [BitConverter]::ToUInt16($bytes, $optionalOffset)
  $dataDirectoryOffset = if ($magic -eq 0x20b) {
    $optionalOffset + 112
  } elseif ($magic -eq 0x10b) {
    $optionalOffset + 96
  } else {
    throw 'release_native_pe_invalid'
  }
  if ($dataDirectoryOffset + 16 -gt $bytes.Length) { throw 'release_native_pe_invalid' }
  $importRva = [BitConverter]::ToUInt32($bytes, $dataDirectoryOffset + 8)
  if ($importRva -eq 0) { return @() }

  $sectionOffset = $optionalOffset + $optionalSize
  $sections = @()
  for ($index = 0; $index -lt $sectionCount; $index++) {
    $offset = $sectionOffset + (40 * $index)
    if ($offset + 40 -gt $bytes.Length) { throw 'release_native_pe_invalid' }
    $virtualSize = [BitConverter]::ToUInt32($bytes, $offset + 8)
    $rawSize = [BitConverter]::ToUInt32($bytes, $offset + 16)
    $sections += [pscustomobject]@{
      virtual_address = [BitConverter]::ToUInt32($bytes, $offset + 12)
      mapped_size = [Math]::Max($virtualSize, $rawSize)
      raw_offset = [BitConverter]::ToUInt32($bytes, $offset + 20)
    }
  }
  $resolveRva = {
    param([uint32]$Rva)
    $section = $sections | Where-Object {
      $Rva -ge $_.virtual_address -and $Rva -lt ($_.virtual_address + $_.mapped_size)
    } | Select-Object -First 1
    if (-not $section) { throw 'release_native_pe_invalid' }
    $fileOffset = [long]$section.raw_offset + ([long]$Rva - [long]$section.virtual_address)
    if ($fileOffset -lt 0 -or $fileOffset -ge $bytes.Length) { throw 'release_native_pe_invalid' }
    return [int]$fileOffset
  }

  $descriptorOffset = & $resolveRva $importRva
  $imports = @()
  while ($descriptorOffset + 20 -le $bytes.Length) {
    $allZero = $true
    for ($index = 0; $index -lt 20; $index++) {
      if ($bytes[$descriptorOffset + $index] -ne 0) { $allZero = $false; break }
    }
    if ($allZero) { break }
    $nameRva = [BitConverter]::ToUInt32($bytes, $descriptorOffset + 12)
    $nameOffset = & $resolveRva $nameRva
    $nameEnd = $nameOffset
    while ($nameEnd -lt $bytes.Length -and $bytes[$nameEnd] -ne 0) { $nameEnd++ }
    if ($nameEnd -eq $bytes.Length -or $nameEnd -eq $nameOffset -or ($nameEnd - $nameOffset) -gt 260) {
      throw 'release_native_pe_invalid'
    }
    $imports += [Text.Encoding]::ASCII.GetString($bytes, $nameOffset, $nameEnd - $nameOffset)
    $descriptorOffset += 20
  }
  return @($imports | Sort-Object -Unique)
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$manifestPath = if ($CargoManifest) {
  (Resolve-Path -LiteralPath $CargoManifest).Path
} else {
  (Resolve-Path -LiteralPath (Join-Path $repo 'bridge\native\Cargo.toml')).Path
}
$nativeRoot = Split-Path $manifestPath -Parent
$lockPath = Join-Path $nativeRoot 'Cargo.lock'
if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { throw 'release_cargo_lock_missing' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'release_compliance_output_exists' }
$cargoCommand = Get-Command cargo.exe -ErrorAction SilentlyContinue
$cargo = if ($null -ne $cargoCommand) { $cargoCommand.Source } else { Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe' }
if (-not (Test-Path -LiteralPath $cargo -PathType Leaf)) { throw 'release_native_cargo_missing' }

$metadataLines = & $cargo metadata --locked --format-version 1 --filter-platform $Target --manifest-path $manifestPath
if ($LASTEXITCODE -ne 0) { throw 'release_cargo_metadata_failed' }
$metadata = (($metadataLines -join [Environment]::NewLine) | ConvertFrom-Json)
$workspaceIds = @{}
foreach ($id in $metadata.workspace_members) { $workspaceIds[[string]$id] = $true }
$externalPackages = @($metadata.packages | Where-Object { -not $workspaceIds.ContainsKey([string]$_.id) } | Sort-Object name,version,source)
if (-not $externalPackages.Count) { throw 'release_dependency_inventory_empty' }
$unsupportedSources = @($externalPackages | Where-Object { -not ([string]$_.source).StartsWith('registry+') })
if ($unsupportedSources.Count) { throw 'release_dependency_source_unsupported' }
$missingLicense = @($externalPackages | Where-Object { [string]::IsNullOrWhiteSpace([string]$_.license) })
if ($missingLicense.Count) { throw 'release_dependency_license_missing' }
$forbiddenCrates = @('openssl','openssl-sys','native-tls','hyper-tls','tokio-native-tls')
$forbiddenDependencies = @($externalPackages | Where-Object { $forbiddenCrates -contains ([string]$_.name).ToLowerInvariant() })
if ($forbiddenDependencies.Count) { throw 'release_forbidden_tls_dependency' }

$cargoToml = Get-Content -LiteralPath $manifestPath -Raw
$releaseProfileChecks = [ordered]@{
  codegen_units_one = [bool]($cargoToml -match '(?m)^codegen-units\s*=\s*1\s*$')
  lto_enabled = [bool]($cargoToml -match '(?m)^lto\s*=\s*true\s*$')
  size_optimized = [bool]($cargoToml -match '(?m)^opt-level\s*=\s*["''](?:s|z)["'']\s*$')
  panic_abort = [bool]($cargoToml -match '(?m)^panic\s*=\s*["'']abort["'']\s*$')
  symbols_stripped = [bool]($cargoToml -match '(?m)^strip\s*=\s*["'']symbols["'']\s*$')
}
if ($releaseProfileChecks.Values -contains $false) { throw 'release_profile_hardening_missing' }

$resolvedExecutables = @()
foreach ($candidate in $NativeExecutable) {
  $path = (Resolve-Path -LiteralPath $candidate).Path
  if ([IO.Path]::GetExtension($path) -ne '.exe') { throw 'release_native_pe_invalid' }
  $imports = @(Get-PeImports $path)
  $forbiddenImports = @($imports | Where-Object {
    $_ -match '^(?i:(?:lib)?ssl|libcrypto|ssleay|openssl|hostfxr|coreclr|clrjit|python\d*)\.dll$'
  })
  if ($forbiddenImports.Count) { throw 'release_forbidden_native_runtime_import' }
  $resolvedExecutables += [ordered]@{
    file_name = Split-Path $path -Leaf
    size_bytes = (Get-Item -LiteralPath $path).Length
    sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    imports = $imports
  }
}

$forbiddenExtensions = @('.pdb','.d','.rlib','.lib','.exp','.obj','.ilk','.map')
$stagedFiles = @()
foreach ($candidate in $StagedDirectory) {
  $directory = (Resolve-Path -LiteralPath $candidate).Path
  $files = @(Get-ChildItem -LiteralPath $directory -Recurse -File -Force)
  $debugFiles = @($files | Where-Object { $forbiddenExtensions -contains $_.Extension.ToLowerInvariant() })
  if ($debugFiles.Count) { throw 'release_debug_artifact_present' }
  $stagedFiles += $files
}

if ($DryRun) {
  [pscustomobject]@{
    ok = $true
    operation = 'generate-native-compliance'
    dry_run = $true
    target = $Target
    package_count = $externalPackages.Count
    executable_count = $resolvedExecutables.Count
    staged_file_count = $stagedFiles.Count
    forbidden_dependencies = @()
    release_profile = $releaseProfileChecks
  } | ConvertTo-Json -Depth 6
  exit 0
}

$licenseDocuments = @{}
$packageRows = @()
function Add-LicenseDocument([string]$Path, [string]$PackageKey) {
  $content = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n").Replace("`r", "`n").Trim() + "`n"
  $contentHash = Get-TextSha256 $content
  $licenseId = "LicenseText-$($contentHash.Substring(0,16))"
  if (-not $licenseDocuments.ContainsKey($licenseId)) {
    $licenseDocuments[$licenseId] = [ordered]@{
      id = $licenseId
      sha256 = $contentHash
      content = $content
      packages = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    }
  }
  $null = $licenseDocuments[$licenseId].packages.Add($PackageKey)
  return $licenseId
}
foreach ($package in $externalPackages) {
  $packageRoot = Split-Path ([string]$package.manifest_path) -Parent
  $licenseFiles = @()
  if (-not [string]::IsNullOrWhiteSpace([string]$package.license_file)) {
    $declaredLicenseFile = Join-Path $packageRoot ([string]$package.license_file)
    if (Test-Path -LiteralPath $declaredLicenseFile -PathType Leaf) {
      $licenseFiles += Get-Item -LiteralPath $declaredLicenseFile
    }
  }
  $licenseFiles += @(Get-ChildItem -LiteralPath $packageRoot -File -Force | Where-Object {
    $_.Name -match '^(?i:LICENSE|LICENCE|COPYING|NOTICE)(?:[._-].*)?$'
  })
  $licenseFiles = @($licenseFiles | Sort-Object FullName -Unique)
  if (-not $licenseFiles.Count) { throw 'release_dependency_license_text_missing' }
  $licenseIds = @()
  foreach ($licenseFile in $licenseFiles) {
    $licenseIds += Add-LicenseDocument $licenseFile.FullName "$($package.name) $($package.version)"
  }
  $declaredLicense = ([string]$package.license).Replace('MIT/Apache-2.0', 'MIT OR Apache-2.0')
  $packageRows += [ordered]@{
    name = [string]$package.name
    version = [string]$package.version
    license = $declaredLicense
    repository = if ([string]::IsNullOrWhiteSpace([string]$package.repository)) { $null } else { [string]$package.repository }
    license_text_ids = @($licenseIds | Sort-Object -Unique)
    package_id = [string]$package.id
    download_location = "https://crates.io/api/v1/crates/$($package.name)/$($package.version)/download"
    purl = "pkg:cargo/$($package.name)@$($package.version)"
  }
}

$pythonComponentCount = 0
if ($PythonRuntimeDirectory) {
  $pythonRoot = (Resolve-Path -LiteralPath $PythonRuntimeDirectory).Path
  $runtimeMetadataPath = Join-Path $pythonRoot 'runtime-metadata.json'
  $pythonLicensePath = Join-Path $pythonRoot 'LICENSE.txt'
  if (-not (Test-Path -LiteralPath (Join-Path $pythonRoot 'python.exe') -PathType Leaf) -or
    -not (Test-Path -LiteralPath $runtimeMetadataPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $pythonLicensePath -PathType Leaf)) {
    throw 'release_python_compliance_invalid'
  }
  $runtimeMetadata = Get-Content -LiteralPath $runtimeMetadataPath -Raw | ConvertFrom-Json
  $pythonVersion = [string]$runtimeMetadata.python_version
  if ($pythonVersion -notmatch '^3\.11\.\d+$') { throw 'release_python_compliance_invalid' }
  $pythonLicenseId = Add-LicenseDocument $pythonLicensePath "CPython $pythonVersion"
  $packageRows += [ordered]@{
    name = 'CPython'
    version = $pythonVersion
    license = 'PSF-2.0'
    repository = 'https://github.com/python/cpython'
    license_text_ids = @($pythonLicenseId)
    package_id = "runtime:cpython@$pythonVersion"
    download_location = "https://www.python.org/ftp/python/$pythonVersion/python-$pythonVersion-amd64.exe"
    purl = "pkg:generic/cpython@$pythonVersion"
  }
  $pythonComponentCount++

  $sitePackages = Join-Path $pythonRoot 'Lib\site-packages'
  $distInfos = @(Get-ChildItem -LiteralPath $sitePackages -Directory -Filter '*.dist-info' | Sort-Object Name)
  if (-not $distInfos.Count) { throw 'release_python_compliance_invalid' }
  foreach ($distInfo in $distInfos) {
    $metadataPath = Join-Path $distInfo.FullName 'METADATA'
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { throw 'release_python_compliance_invalid' }
    $metadataText = Get-Content -LiteralPath $metadataPath -Raw
    $nameMatch = [regex]::Match($metadataText, '(?m)^Name:\s*(.+?)\s*$')
    $versionMatch = [regex]::Match($metadataText, '(?m)^Version:\s*(.+?)\s*$')
    $licenseMatch = [regex]::Match($metadataText, '(?m)^License-Expression:\s*(.+?)\s*$')
    if (-not $licenseMatch.Success) {
      $licenseMatch = [regex]::Match($metadataText, '(?m)^License:\s*(.+?)\s*$')
    }
    if (-not $nameMatch.Success -or -not $versionMatch.Success -or -not $licenseMatch.Success) {
      throw 'release_python_compliance_invalid'
    }
    $name = $nameMatch.Groups[1].Value.Trim()
    $version = $versionMatch.Groups[1].Value.Trim()
    $license = $licenseMatch.Groups[1].Value.Trim()
    $licenseFiles = @(Get-ChildItem -LiteralPath $distInfo.FullName -Recurse -File -Force | Where-Object {
      $_.Name -match '^(?i:LICENSE|LICENCE|COPYING|NOTICE)(?:[._-].*)?$'
    } | Sort-Object FullName -Unique)
    if (-not $licenseFiles.Count) { throw 'release_python_compliance_invalid' }
    $licenseIds = @()
    foreach ($licenseFile in $licenseFiles) {
      $licenseIds += Add-LicenseDocument $licenseFile.FullName "$name $version"
    }
    $homeMatch = [regex]::Match($metadataText, '(?m)^Home-page:\s*(https?://\S+)\s*$')
    if (-not $homeMatch.Success) {
      $homeMatch = [regex]::Match($metadataText, '(?mi)^Project-URL:\s*(?:homepage|source),\s*(https?://\S+)\s*$')
    }
    $repository = if ($homeMatch.Success) { $homeMatch.Groups[1].Value } else { $null }
    $normalizedName = $name.ToLowerInvariant().Replace('_','-')
    $packageRows += [ordered]@{
      name = $name
      version = $version
      license = $license
      repository = $repository
      license_text_ids = @($licenseIds | Sort-Object -Unique)
      package_id = "pypi:$normalizedName@$version"
      download_location = "https://pypi.org/project/$normalizedName/$version/"
      purl = "pkg:pypi/$normalizedName@$version"
    }
    $pythonComponentCount++
  }
}

$commit = (git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[a-f0-9]{40}$') { throw 'release_git_commit_invalid' }
$created = ([DateTimeOffset](git -C $repo show -s --format=%cI $commit)).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
$spdxPackages = @()
$relationships = @()
foreach ($package in $packageRows) {
  $idHash = (Get-TextSha256 $package.package_id).Substring(0,16)
  $spdxId = "SPDXRef-Package-$($package.name -replace '[^A-Za-z0-9.-]', '-')-$idHash"
  $spdxPackages += [ordered]@{
    name = $package.name
    SPDXID = $spdxId
    versionInfo = $package.version
    downloadLocation = $package.download_location
    filesAnalyzed = $false
    licenseConcluded = 'NOASSERTION'
    licenseDeclared = $package.license
    copyrightText = 'NOASSERTION'
    externalRefs = @([ordered]@{
      referenceCategory = 'PACKAGE-MANAGER'
      referenceType = 'purl'
      referenceLocator = $package.purl
    })
  }
  $relationships += [ordered]@{
    spdxElementId = 'SPDXRef-DOCUMENT'
    relationshipType = 'DESCRIBES'
    relatedSpdxElement = $spdxId
  }
}
$sbom = [ordered]@{
  spdxVersion = 'SPDX-2.3'
  dataLicense = 'CC0-1.0'
  SPDXID = 'SPDXRef-DOCUMENT'
  name = 'liangjian-bridge-runtime-third-party'
  documentNamespace = "urn:aurum:spdx:liangjian-bridge-native:$commit"
  creationInfo = [ordered]@{
    created = $created
    creators = @('Tool: generate-native-compliance.ps1')
  }
  packages = $spdxPackages
  relationships = $relationships
}

$licenseOutput = [Text.StringBuilder]::new()
$null = $licenseOutput.Append("量见智桥 Native 第三方软件声明`n")
$null = $licenseOutput.Append("Generated from Cargo.lock and the packaged Python runtime for target $Target.`n`n")
$null = $licenseOutput.Append("PACKAGES`n========`n")
foreach ($package in $packageRows) {
  $repository = if ($package.repository) { " | $($package.repository)" } else { '' }
  $null = $licenseOutput.Append("$($package.name) $($package.version) | $($package.license)$repository`n")
  $null = $licenseOutput.Append("License texts: $($package.license_text_ids -join ', ')`n")
}
$null = $licenseOutput.Append("`nLICENSE TEXTS`n============= `n")
foreach ($entry in @($licenseDocuments.Values | Sort-Object id)) {
  $null = $licenseOutput.Append("`n--- $($entry.id) ---`n")
  $null = $licenseOutput.Append("SHA-256: $($entry.sha256)`n")
  $null = $licenseOutput.Append("Applies to: $(@($entry.packages | Sort-Object) -join ', ')`n`n")
  $null = $licenseOutput.Append($entry.content)
}

New-Item -ItemType Directory -Path $output | Out-Null
$sbomPath = Join-Path $output 'bridge-native.spdx.json'
$licensesPath = Join-Path $output 'THIRD-PARTY-LICENSES.txt'
$auditPath = Join-Path $output 'native-dependency-audit.json'
Write-Utf8NoBom -Path $sbomPath -Content ($sbom | ConvertTo-Json -Depth 10)
Write-Utf8NoBom -Path $licensesPath -Content $licenseOutput.ToString()
$audit = [ordered]@{
  schema_version = 1
  target = $Target
  git_commit = $commit
  cargo_lock_sha256 = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant()
  third_party_package_count = $externalPackages.Count
  python_component_count = $pythonComponentCount
  sbom_package_count = $packageRows.Count
  unique_license_text_count = $licenseDocuments.Count
  forbidden_tls_crates = @()
  release_profile = $releaseProfileChecks
  executables = $resolvedExecutables
  staged_file_count = $stagedFiles.Count
  sbom_sha256 = (Get-FileHash -LiteralPath $sbomPath -Algorithm SHA256).Hash.ToLowerInvariant()
  licenses_sha256 = (Get-FileHash -LiteralPath $licensesPath -Algorithm SHA256).Hash.ToLowerInvariant()
}
Write-Utf8NoBom -Path $auditPath -Content ($audit | ConvertTo-Json -Depth 10)
[pscustomobject]@{
  ok = $true
  operation = 'generate-native-compliance'
  output = $output
  package_count = $packageRows.Count
  rust_package_count = $externalPackages.Count
  python_component_count = $pythonComponentCount
  unique_license_text_count = $licenseDocuments.Count
  sbom = $sbomPath
  licenses = $licensesPath
  audit = $auditPath
} | ConvertTo-Json -Depth 5
