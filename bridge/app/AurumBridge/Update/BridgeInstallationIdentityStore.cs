namespace AurumBridge.Update;

public sealed class BridgeInstallationIdentityStore(string identityPath)
{
    private readonly string _identityPath = Path.GetFullPath(
        string.IsNullOrWhiteSpace(identityPath)
            ? throw new ArgumentException("bridge_installation_identity_path_required", nameof(identityPath))
            : identityPath);

    public async Task<string> LoadOrCreateAsync(CancellationToken cancellationToken = default)
    {
        var existing = await LoadAsync(cancellationToken);
        if (existing is not null)
        {
            return existing;
        }
        var identity = $"install_{Guid.NewGuid():N}";
        Directory.CreateDirectory(Path.GetDirectoryName(_identityPath)!);
        try
        {
            await using var stream = new FileStream(
                _identityPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.Read,
                4096,
                FileOptions.Asynchronous | FileOptions.WriteThrough);
            await using var writer = new StreamWriter(stream, leaveOpen:true);
            await writer.WriteAsync(identity.AsMemory(), cancellationToken);
            await writer.FlushAsync(cancellationToken);
            await stream.FlushAsync(cancellationToken);
            return identity;
        }
        catch (IOException) when (File.Exists(_identityPath))
        {
            return await LoadAsync(cancellationToken)
                ?? throw new InvalidDataException("bridge_installation_identity_invalid");
        }
    }

    private async Task<string?> LoadAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(_identityPath))
        {
            return null;
        }
        var value = (await File.ReadAllTextAsync(_identityPath, cancellationToken)).Trim();
        if (value.Length is < 8 or > 128
            || !value.StartsWith("install_", StringComparison.Ordinal)
            || value.Any(character => !char.IsAsciiLetterOrDigit(character)
                && character is not ('.' or '_' or ':' or '-')))
        {
            throw new InvalidDataException("bridge_installation_identity_invalid");
        }
        return value;
    }
}
