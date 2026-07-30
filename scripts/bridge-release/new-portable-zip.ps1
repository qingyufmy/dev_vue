param(
  [Parameter(Mandatory=$true)][string]$SourceDirectory,
  [Parameter(Mandatory=$true)][string]$Destination
)
$ErrorActionPreference = 'Stop'

$source = (Resolve-Path -LiteralPath $SourceDirectory).Path
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
  throw 'release_archive_source_invalid'
}
$destination = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destination) {
  throw 'release_archive_destination_exists'
}
$destinationParent = Split-Path $destination -Parent
if (-not $destinationParent -or -not (Test-Path -LiteralPath $destinationParent -PathType Container)) {
  throw 'release_archive_destination_invalid'
}
$sourcePrefix = $source.TrimEnd(
  [IO.Path]::DirectorySeparatorChar,
  [IO.Path]::AltDirectorySeparatorChar
) + [IO.Path]::DirectorySeparatorChar
if ($destination.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'release_archive_destination_invalid'
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$items = @(Get-ChildItem -LiteralPath $source -Force -Recurse | Sort-Object FullName)
if (-not ($items | Where-Object { -not $_.PSIsContainer })) {
  throw 'release_archive_source_empty'
}
$identities = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$stream = $null
$archive = $null
$succeeded = $false
$fileCount = 0
try {
  $stream = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $archive = [IO.Compression.ZipArchive]::new(
    $stream,
    [IO.Compression.ZipArchiveMode]::Create,
    $false
  )
  foreach ($item in $items) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      -not $item.FullName.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'release_archive_source_invalid'
    }
    $entryName = $item.FullName.Substring($sourcePrefix.Length).Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($entryName) -or $entryName.StartsWith('/') -or
      $entryName.Contains('\') -or $entryName.Split('/') -contains '..') {
      throw 'release_archive_entry_invalid'
    }
    $identity = $entryName.TrimEnd('/')
    if (-not $identities.Add($identity)) {
      throw 'release_archive_entry_duplicate'
    }
    if ($item.PSIsContainer) {
      $null = $archive.CreateEntry("$entryName/")
      continue
    }
    $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive,
      $item.FullName,
      $entryName,
      [IO.Compression.CompressionLevel]::Optimal
    )
    $fileCount += 1
  }
  $archive.Dispose()
  $archive = $null
  $stream = $null
  $succeeded = $true
} finally {
  if ($null -ne $archive) { $archive.Dispose() }
  if ($null -ne $stream) { $stream.Dispose() }
  if (-not $succeeded -and (Test-Path -LiteralPath $destination -PathType Leaf)) {
    Remove-Item -LiteralPath $destination -Force
  }
}

[pscustomobject]@{
  ok=$true
  operation='new-portable-zip'
  source=$source
  destination=$destination
  entry_count=$identities.Count
  file_count=$fileCount
  size_bytes=(Get-Item -LiteralPath $destination).Length
} | ConvertTo-Json
