using System.Text.Json;
using System.Text.Json.Serialization;

namespace AurumBridge.Launcher;

public sealed record LauncherUpdateState
{
    [JsonPropertyName("schema_version")]
    public int SchemaVersion { get; init; } = 1;

    [JsonPropertyName("state")]
    public required string State { get; init; }

    [JsonPropertyName("target_version")]
    public string? TargetVersion { get; init; }

    [JsonPropertyName("release_id")]
    public string? ReleaseId { get; init; }

    [JsonPropertyName("priority")]
    public string? Priority { get; init; }

    [JsonPropertyName("manual_activation_requested")]
    public bool ManualActivationRequested { get; init; }

    [JsonPropertyName("staged_at_utc_msc")]
    public long? StagedAtUtcMsc { get; init; }

    [JsonPropertyName("activation_started_at_utc_msc")]
    public long? ActivationStartedAtUtcMsc { get; init; }

    [JsonPropertyName("minimum_idle_seconds")]
    public int MinimumIdleSeconds { get; init; } = 120;

    [JsonPropertyName("activation_deadline_utc_msc")]
    public long? ActivationDeadlineUtcMsc { get; init; }

    [JsonPropertyName("maintenance_lease_id")]
    public string? MaintenanceLeaseId { get; init; }

    [JsonPropertyName("maintenance_lease_expires_at_utc_msc")]
    public long? MaintenanceLeaseExpiresAtUtcMsc { get; init; }

    [JsonPropertyName("next_retry_at_utc_msc")]
    public long? NextRetryAtUtcMsc { get; init; }

    [JsonPropertyName("last_error_code")]
    public string? LastErrorCode { get; init; }

    [JsonPropertyName("updated_at_utc_msc")]
    public required long UpdatedAtUtcMsc { get; init; }
}

public sealed class LauncherUpdateStateStore(
    string statePath,
    Func<long>? clock = null)
{
    private readonly string _statePath = Path.GetFullPath(statePath);
    private readonly Func<long> _clock = clock
        ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    public async Task<LauncherUpdateState?> LoadAsync(
        CancellationToken cancellationToken = default)
    {
        if (!File.Exists(_statePath))
        {
            return null;
        }
        try
        {
            await using var stream = new FileStream(
                _statePath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                4096,
                FileOptions.Asynchronous);
            var state = await JsonSerializer.DeserializeAsync(
                stream,
                LauncherJsonContext.Default.LauncherUpdateState,
                cancellationToken)
                ?? throw new InvalidDataException("launcher_update_state_invalid");
            Validate(state);
            return state;
        }
        catch (JsonException error)
        {
            throw new InvalidDataException("launcher_update_state_invalid", error);
        }
    }

    public async Task MarkAsync(
        string state,
        string targetVersion,
        string? errorCode = null,
        bool clearMaintenanceLease = false,
        CancellationToken cancellationToken = default)
    {
        if (state is not ("verifying" or "healthy" or "rolled_back"))
        {
            throw new ArgumentOutOfRangeException(nameof(state));
        }
        var current = await LoadAsync(cancellationToken);
        if (current is null
            || !string.Equals(current.TargetVersion, targetVersion, StringComparison.Ordinal))
        {
            return;
        }
        var next = current with
        {
            State = state,
            MaintenanceLeaseId = clearMaintenanceLease ? null : current.MaintenanceLeaseId,
            MaintenanceLeaseExpiresAtUtcMsc = clearMaintenanceLease
                ? null
                : current.MaintenanceLeaseExpiresAtUtcMsc,
            NextRetryAtUtcMsc = null,
            LastErrorCode = errorCode,
            UpdatedAtUtcMsc = _clock(),
        };
        Validate(next);
        var directory = Path.GetDirectoryName(_statePath)!;
        Directory.CreateDirectory(directory);
        var temporaryPath = Path.Combine(
            directory,
            $".{Path.GetFileName(_statePath)}.{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var stream = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                4096,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await JsonSerializer.SerializeAsync(
                    stream,
                    next,
                    LauncherJsonContext.Default.LauncherUpdateState,
                    cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }
            File.Move(temporaryPath, _statePath, overwrite:true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    private static void Validate(LauncherUpdateState state)
    {
        if (state.SchemaVersion != 1
            || string.IsNullOrWhiteSpace(state.State)
            || !Version.TryParse(state.TargetVersion, out _)
            || state.Priority is not ("normal" or "urgent")
            || state.StagedAtUtcMsc is null or <= 0
            || state.ActivationStartedAtUtcMsc is <= 0
            || state.MinimumIdleSeconds is < 30 or > 3600
            || state.UpdatedAtUtcMsc <= 0
            || (state.MaintenanceLeaseId is null)
                != (state.MaintenanceLeaseExpiresAtUtcMsc is null))
        {
            throw new InvalidDataException("launcher_update_state_invalid");
        }
    }
}
