using System.Text.Json;
using System.Text.Json.Serialization;

namespace AurumBridge.Update;

public static class BridgeUpdateStates
{
    public const string Checking = "checking";
    public const string Downloading = "downloading";
    public const string WaitingWindow = "waiting_window";
    public const string AcquiringLease = "acquiring_lease";
    public const string Draining = "draining";
    public const string Activating = "activating";
    public const string Verifying = "verifying";
    public const string Healthy = "healthy";
    public const string RolledBack = "rolled_back";
    public const string Failed = "failed";

    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal)
    {
        Checking,
        Downloading,
        WaitingWindow,
        AcquiringLease,
        Draining,
        Activating,
        Verifying,
        Healthy,
        RolledBack,
        Failed,
    };
}

public sealed record BridgeUpdateState
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

    [JsonPropertyName("next_retry_at_utc_msc")]
    public long? NextRetryAtUtcMsc { get; init; }

    [JsonPropertyName("last_error_code")]
    public string? LastErrorCode { get; init; }

    [JsonPropertyName("updated_at_utc_msc")]
    public required long UpdatedAtUtcMsc { get; init; }
}

public sealed class BridgeUpdateStateStore(
    string statePath,
    Func<long>? clock = null)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };
    private readonly string _statePath = Path.GetFullPath(
        string.IsNullOrWhiteSpace(statePath)
            ? throw new ArgumentException("update_state_path_required", nameof(statePath))
            : statePath);
    private readonly Func<long> _clock = clock
        ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    public async Task<BridgeUpdateState?> LoadAsync(
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
            var state = await JsonSerializer.DeserializeAsync<BridgeUpdateState>(
                stream,
                JsonOptions,
                cancellationToken)
                ?? throw new InvalidDataException("update_state_invalid");
            Validate(state);
            return state;
        }
        catch (JsonException error)
        {
            throw new InvalidDataException("update_state_invalid", error);
        }
    }

    public async Task SaveAsync(
        BridgeUpdateState state,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(state);
        var timestamped = state with { UpdatedAtUtcMsc = _clock() };
        Validate(timestamped);
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
                    timestamped,
                    JsonOptions,
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

    private static void Validate(BridgeUpdateState state)
    {
        var requiresTarget = state.State is not (BridgeUpdateStates.Checking
            or BridgeUpdateStates.Failed);
        var requiresStagedAt = state.State is BridgeUpdateStates.WaitingWindow
            or BridgeUpdateStates.AcquiringLease
            or BridgeUpdateStates.Draining
            or BridgeUpdateStates.Activating
            or BridgeUpdateStates.Verifying;
        if (state.SchemaVersion != 1
            || !BridgeUpdateStates.All.Contains(state.State)
            || state.UpdatedAtUtcMsc <= 0
            || requiresTarget && (!Version.TryParse(state.TargetVersion, out _)
                || state.Priority is not ("normal" or "urgent"))
            || state.ReleaseId is { Length: > 128 }
            || state.StagedAtUtcMsc is <= 0
            || state.NextRetryAtUtcMsc is < 0
            || state.LastErrorCode is { Length: > 256 }
            || state.State == BridgeUpdateStates.Failed
                && string.IsNullOrWhiteSpace(state.LastErrorCode)
            || requiresStagedAt && state.StagedAtUtcMsc is null)
        {
            throw new InvalidDataException("update_state_invalid");
        }
    }
}
