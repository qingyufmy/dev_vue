[CmdletBinding()]
param(
    [string]$LogDirectory = (Join-Path $env:APPDATA 'AURUM\BridgeV3\logs'),
    [double]$MinimumHours = 168,
    [double]$WarmupMinutes = 30,
    [double]$WindowMinutes = 60,
    [double]$MaxPrivateMemoryGrowthPercent = 5,
    [double]$MaxSampleGapSeconds = 150,
    [int]$MinimumTerminalCount = 1
)

$ErrorActionPreference = 'Stop'

function Get-Median([double[]]$Values) {
    if ($Values.Count -eq 0) {
        throw 'bridge_health_window_empty'
    }
    $ordered = @($Values | Sort-Object)
    $middle = [int][Math]::Floor($ordered.Count / 2)
    if ($ordered.Count % 2 -eq 1) {
        return [double]$ordered[$middle]
    }
    return ([double]$ordered[$middle - 1] + [double]$ordered[$middle]) / 2
}

function Convert-HealthMessage([string]$Message) {
    $values = @{}
    foreach ($part in $Message -split ';\s*') {
        $pair = $part -split '=', 2
        if ($pair.Count -eq 2) {
            $values[$pair[0]] = $pair[1]
        }
    }
    $required = @(
        'uptime_seconds',
        'working_set_bytes',
        'private_memory_bytes',
        'phase',
        'terminals'
    )
    foreach ($name in $required) {
        if (-not $values.ContainsKey($name)) {
            throw "bridge_health_field_missing:$name"
        }
    }
    return $values
}

$resolvedLogDirectory = [IO.Path]::GetFullPath($LogDirectory)
if (-not (Test-Path -LiteralPath $resolvedLogDirectory -PathType Container)) {
    throw 'bridge_health_log_directory_not_found'
}

$samples = @(
    Get-ChildItem -LiteralPath $resolvedLogDirectory -Filter 'bridge-*.log' -File |
        Sort-Object Name |
        ForEach-Object {
            foreach ($line in Get-Content -LiteralPath $_.FullName -Encoding UTF8) {
                if ([string]::IsNullOrWhiteSpace($line)) {
                    continue
                }
                try {
                    $event = $line | ConvertFrom-Json
                } catch {
                    continue
                }
                if ($event.event_name -ne 'bridge_health_sample') {
                    continue
                }
                $values = Convert-HealthMessage ([string]$event.message)
                [pscustomobject]@{
                    Timestamp = [DateTimeOffset]::Parse([string]$event.timestamp_utc)
                    UptimeSeconds = [long]$values.uptime_seconds
                    WorkingSetBytes = [long]$values.working_set_bytes
                    PrivateMemoryBytes = [long]$values.private_memory_bytes
                    Phase = [string]$values.phase
                    Terminals = [int]$values.terminals
                }
            }
        } |
        Sort-Object Timestamp
)

if ($samples.Count -lt 2) {
    throw 'bridge_health_samples_insufficient'
}

$first = $samples[0]
$last = $samples[-1]
$span = $last.Timestamp - $first.Timestamp
if ($span.TotalHours -lt $MinimumHours) {
    throw "bridge_health_span_insufficient:$([Math]::Round($span.TotalHours, 3))h"
}

$maximumGapSeconds = 0.0
$processRestarted = $false
for ($index = 1; $index -lt $samples.Count; $index++) {
    $gap = ($samples[$index].Timestamp - $samples[$index - 1].Timestamp).TotalSeconds
    $maximumGapSeconds = [Math]::Max($maximumGapSeconds, $gap)
    if ($samples[$index].UptimeSeconds -lt $samples[$index - 1].UptimeSeconds) {
        $processRestarted = $true
    }
}
if ($maximumGapSeconds -gt $MaxSampleGapSeconds) {
    throw "bridge_health_sample_gap_exceeded:$([Math]::Round($maximumGapSeconds, 3))s"
}
if ($processRestarted) {
    throw 'bridge_health_process_restarted'
}
if (($samples | Measure-Object Terminals -Minimum).Minimum -lt $MinimumTerminalCount) {
    throw 'bridge_health_terminal_count_below_minimum'
}

$baselineStart = $first.Timestamp.AddMinutes($WarmupMinutes)
$baselineEnd = $baselineStart.AddMinutes($WindowMinutes)
$finalStart = $last.Timestamp.AddMinutes(-$WindowMinutes)
$baseline = @($samples | Where-Object {
    $_.Timestamp -ge $baselineStart -and $_.Timestamp -le $baselineEnd
})
$final = @($samples | Where-Object {
    $_.Timestamp -ge $finalStart -and $_.Timestamp -le $last.Timestamp
})

$baselinePrivate = Get-Median @($baseline.PrivateMemoryBytes)
$finalPrivate = Get-Median @($final.PrivateMemoryBytes)
$privateGrowthPercent = (($finalPrivate - $baselinePrivate) / $baselinePrivate) * 100
$baselineWorkingSet = Get-Median @($baseline.WorkingSetBytes)
$finalWorkingSet = Get-Median @($final.WorkingSetBytes)
$workingSetGrowthPercent = (($finalWorkingSet - $baselineWorkingSet) / $baselineWorkingSet) * 100
$onlineSamples = @($samples | Where-Object Phase -eq 'Online').Count
$onlineRatio = $onlineSamples / $samples.Count

$result = [ordered]@{
    passed = $privateGrowthPercent -le $MaxPrivateMemoryGrowthPercent
    sample_count = $samples.Count
    started_at_utc = $first.Timestamp.ToUniversalTime().ToString('O')
    ended_at_utc = $last.Timestamp.ToUniversalTime().ToString('O')
    duration_hours = [Math]::Round($span.TotalHours, 3)
    maximum_sample_gap_seconds = [Math]::Round($maximumGapSeconds, 3)
    process_restarted = $processRestarted
    minimum_terminal_count = ($samples | Measure-Object Terminals -Minimum).Minimum
    online_sample_ratio = [Math]::Round($onlineRatio, 6)
    baseline_private_memory_bytes = [long]$baselinePrivate
    final_private_memory_bytes = [long]$finalPrivate
    private_memory_growth_percent = [Math]::Round($privateGrowthPercent, 3)
    baseline_working_set_bytes = [long]$baselineWorkingSet
    final_working_set_bytes = [long]$finalWorkingSet
    working_set_growth_percent = [Math]::Round($workingSetGrowthPercent, 3)
    private_memory_growth_limit_percent = $MaxPrivateMemoryGrowthPercent
}

$result | ConvertTo-Json
if (-not $result.passed) {
    throw "bridge_health_private_memory_growth_exceeded:$($result.private_memory_growth_percent)%"
}
