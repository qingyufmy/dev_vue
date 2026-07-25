using System.IO.Compression;
using System.Security.Cryptography;

namespace AurumBridge.Update;

public sealed class ReleaseStager(HttpClient httpClient)
{
    private readonly HttpClient _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));

    public async Task<string> DownloadPackageAsync(
        ReleasePackage package,
        string stagingDirectory,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(package);
        ArgumentException.ThrowIfNullOrWhiteSpace(stagingDirectory);
        var root = Path.GetFullPath(stagingDirectory);
        Directory.CreateDirectory(root);
        var fileName = $"{package.ModuleId}.{package.Version}.zip";
        if (!string.Equals(Path.GetFileName(fileName), fileName, StringComparison.Ordinal)
            || fileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        {
            throw new InvalidDataException("update_package_identity_invalid");
        }
        var finalPath = Path.Combine(root, fileName);
        var temporaryPath = Path.Combine(root, $".{Guid.NewGuid():N}.download");
        try
        {
            using var response = await _httpClient.GetAsync(
                package.Url,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
            response.EnsureSuccessStatusCode();
            if (response.Content.Headers.ContentLength is long declaredLength
                && declaredLength != package.SizeBytes)
            {
                throw new InvalidDataException("update_package_size_mismatch");
            }
            await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[64 * 1024];
            long total = 0;
            await using (var destination = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                64 * 1024,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                int read;
                while ((read = await source.ReadAsync(buffer, cancellationToken)) > 0)
                {
                    total = checked(total + read);
                    if (total > package.SizeBytes)
                    {
                        throw new InvalidDataException("update_package_size_mismatch");
                    }
                    hash.AppendData(buffer, 0, read);
                    await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                }
                await destination.FlushAsync(cancellationToken);
            }
            var actualHash = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            if (total != package.SizeBytes
                || !CryptographicOperations.FixedTimeEquals(
                    Convert.FromHexString(actualHash),
                    Convert.FromHexString(package.Sha256)))
            {
                throw new InvalidDataException("update_package_integrity_failed");
            }
            File.Move(temporaryPath, finalPath, overwrite: true);
            return finalPath;
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    public static string ExtractPackage(string packagePath, string versionDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packagePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(versionDirectory);
        var root = Path.GetFullPath(versionDirectory);
        Directory.CreateDirectory(root);
        var prefix = root.EndsWith(Path.DirectorySeparatorChar)
            ? root
            : root + Path.DirectorySeparatorChar;
        using var archive = ZipFile.OpenRead(packagePath);
        var files = new List<(ZipArchiveEntry Entry, string Destination)>();
        long expandedSize = 0;
        foreach (var entry in archive.Entries)
        {
            if (string.IsNullOrEmpty(entry.Name))
            {
                continue;
            }
            var destination = Path.GetFullPath(Path.Combine(root, entry.FullName));
            if (!destination.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("update_package_path_traversal");
            }
            expandedSize = checked(expandedSize + entry.Length);
            if (expandedSize > 1024L * 1024 * 1024)
            {
                throw new InvalidDataException("update_package_expanded_size_exceeded");
            }
            files.Add((entry, destination));
        }
        foreach (var (entry, destination) in files)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            entry.ExtractToFile(destination, overwrite: false);
        }
        return root;
    }
}
