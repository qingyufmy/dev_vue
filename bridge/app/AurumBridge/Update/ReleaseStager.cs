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
        return await DownloadPackageAsync(
            package,
            stagingDirectory,
            contentCacheDirectory:null,
            cancellationToken);
    }

    public async Task<string> DownloadPackageAsync(
        ReleasePackage package,
        string stagingDirectory,
        string? contentCacheDirectory,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(package);
        ArgumentException.ThrowIfNullOrWhiteSpace(stagingDirectory);
        var stagingRoot = Path.GetFullPath(stagingDirectory);
        var root = contentCacheDirectory is null
            ? stagingRoot
            : Path.GetFullPath(contentCacheDirectory);
        Directory.CreateDirectory(root);
        var fileName = contentCacheDirectory is null
            ? $"{package.ModuleId}.{package.Version}.zip"
            : $"{NormalizeSha256(package.Sha256)}.zip";
        if (!string.Equals(Path.GetFileName(fileName), fileName, StringComparison.Ordinal)
            || fileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        {
            throw new InvalidDataException("update_package_identity_invalid");
        }
        var finalPath = Path.Combine(root, fileName);
        if (File.Exists(finalPath))
        {
            if (await VerifyPackageFileAsync(package, finalPath, cancellationToken))
            {
                return finalPath;
            }
            File.Delete(finalPath);
        }
        var temporaryPath = Path.Combine(root, $".{Guid.NewGuid():N}.part");
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
                    Convert.FromHexString(NormalizeSha256(package.Sha256))))
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

    public async Task<string?> FindVerifiedCachedPackageAsync(
        ReleasePackage package,
        string contentCacheDirectory,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(package);
        ArgumentException.ThrowIfNullOrWhiteSpace(contentCacheDirectory);
        var cacheRoot = Path.GetFullPath(contentCacheDirectory);
        var cachePath = Path.Combine(cacheRoot, $"{NormalizeSha256(package.Sha256)}.zip");
        return File.Exists(cachePath)
            && await VerifyPackageFileAsync(package, cachePath, cancellationToken)
                ? cachePath
                : null;
    }

    public static long GetExpandedSize(string packagePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packagePath);
        using var archive = ZipFile.OpenRead(packagePath);
        long expandedSize = 0;
        foreach (var entry in archive.Entries)
        {
            if (string.IsNullOrEmpty(entry.Name))
            {
                continue;
            }
            expandedSize = checked(expandedSize + entry.Length);
            if (expandedSize > 1024L * 1024 * 1024)
            {
                throw new InvalidDataException("update_package_expanded_size_exceeded");
            }
        }
        return expandedSize;
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

    private static async Task<bool> VerifyPackageFileAsync(
        ReleasePackage package,
        string packagePath,
        CancellationToken cancellationToken)
    {
        var file = new FileInfo(packagePath);
        if (!file.Exists || file.Length != package.SizeBytes)
        {
            return false;
        }
        await using var stream = new FileStream(
            packagePath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            64 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[64 * 1024];
        int read;
        while ((read = await stream.ReadAsync(buffer, cancellationToken)) > 0)
        {
            hash.AppendData(buffer, 0, read);
        }
        return CryptographicOperations.FixedTimeEquals(
            hash.GetHashAndReset(),
            Convert.FromHexString(NormalizeSha256(package.Sha256)));
    }

    private static string NormalizeSha256(string value)
    {
        if (value is null
            || value.Length != 64
            || value.Any(character => !Uri.IsHexDigit(character)))
        {
            throw new InvalidDataException("update_package_identity_invalid");
        }
        return value.ToLowerInvariant();
    }
}
