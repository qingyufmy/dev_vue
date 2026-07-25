using System.Text.Json;
using System.Text.Json.Serialization;

namespace AurumBridge.Launcher;

public sealed record VersionPointer
{
    [JsonPropertyName("active_version")]
    public required string ActiveVersion { get; init; }

    [JsonPropertyName("last_known_good_version")]
    public required string LastKnownGoodVersion { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("updated_at_utc_msc")]
    public required long UpdatedAtUtcMsc { get; init; }
}

public sealed class VersionPointerStore(string pointerPath)
{
    private readonly string _pointerPath = Path.GetFullPath(pointerPath);

    public async Task<VersionPointer> LoadAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            await using var stream = new FileStream(
                _pointerPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                4096,
                FileOptions.Asynchronous);
            var pointer = await JsonSerializer.DeserializeAsync<VersionPointer>(stream, cancellationToken: cancellationToken)
                ?? throw new InvalidDataException("launcher_version_pointer_invalid");
            Validate(pointer);
            return pointer;
        }
        catch (JsonException error)
        {
            throw new InvalidDataException("launcher_version_pointer_invalid", error);
        }
    }

    public async Task SaveAsync(VersionPointer pointer, CancellationToken cancellationToken = default)
    {
        Validate(pointer);
        var directory = Path.GetDirectoryName(_pointerPath)!;
        Directory.CreateDirectory(directory);
        var temporaryPath = Path.Combine(directory, $".{Path.GetFileName(_pointerPath)}.{Guid.NewGuid():N}.tmp");
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
                await JsonSerializer.SerializeAsync(stream, pointer, cancellationToken: cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }
            File.Move(temporaryPath, _pointerPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    private static void Validate(VersionPointer pointer)
    {
        ArgumentNullException.ThrowIfNull(pointer);
        if (!Version.TryParse(pointer.ActiveVersion, out _)
            || !Version.TryParse(pointer.LastKnownGoodVersion, out _)
            || pointer.Status is not ("pending" or "healthy" or "rolled_back")
            || pointer.UpdatedAtUtcMsc <= 0)
        {
            throw new InvalidDataException("launcher_version_pointer_invalid");
        }
    }
}
