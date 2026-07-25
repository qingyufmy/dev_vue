using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AurumBridge.Security;

public sealed record BridgeCredential(string RefreshToken, long ExpiresAtUtcMsc);

public interface IBridgeCredentialStore
{
    Task<BridgeCredential?> LoadAsync(CancellationToken cancellationToken = default);
    Task SaveAsync(BridgeCredential credential, CancellationToken cancellationToken = default);
    Task ClearAsync(CancellationToken cancellationToken = default);
}

public interface IDataProtector
{
    byte[] Protect(byte[] plaintext);
    byte[] Unprotect(byte[] ciphertext);
}

public sealed class WindowsDpapiProtector : IDataProtector
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("AURUM Bridge v3 refresh credential");

    public byte[] Protect(byte[] plaintext)
    {
        EnsureWindows();
        return ProtectedData.Protect(plaintext, Entropy, DataProtectionScope.CurrentUser);
    }

    public byte[] Unprotect(byte[] ciphertext)
    {
        EnsureWindows();
        return ProtectedData.Unprotect(ciphertext, Entropy, DataProtectionScope.CurrentUser);
    }

    private static void EnsureWindows()
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("Bridge credentials require Windows DPAPI.");
        }
    }
}

public sealed class FileBridgeCredentialStore : IBridgeCredentialStore
{
    private readonly string _credentialPath;
    private readonly IDataProtector _protector;
    private readonly SemaphoreSlim _access = new(1, 1);

    public FileBridgeCredentialStore(string credentialPath, IDataProtector protector)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(credentialPath);
        _credentialPath = Path.GetFullPath(credentialPath);
        _protector = protector ?? throw new ArgumentNullException(nameof(protector));
    }

    public async Task<BridgeCredential?> LoadAsync(CancellationToken cancellationToken = default)
    {
        await _access.WaitAsync(cancellationToken);
        try
        {
            if (!File.Exists(_credentialPath))
            {
                return null;
            }
            try
            {
                var ciphertext = await File.ReadAllBytesAsync(_credentialPath, cancellationToken);
                var plaintext = _protector.Unprotect(ciphertext);
                try
                {
                    var credential = JsonSerializer.Deserialize<BridgeCredential>(plaintext);
                    if (credential is null || credential.RefreshToken.Length < 40)
                    {
                        throw new InvalidDataException("bridge_credential_payload_invalid");
                    }
                    return credential;
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(plaintext);
                }
            }
            catch (Exception error) when (error is CryptographicException or JsonException)
            {
                throw new InvalidDataException("bridge_credential_decryption_failed", error);
            }
        }
        finally
        {
            _access.Release();
        }
    }

    public async Task SaveAsync(
        BridgeCredential credential,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(credential);
        if (credential.RefreshToken.Length < 40)
        {
            throw new ArgumentException("Bridge refresh credential is invalid.", nameof(credential));
        }
        await _access.WaitAsync(cancellationToken);
        try
        {
            var directory = Path.GetDirectoryName(_credentialPath)!;
            Directory.CreateDirectory(directory);
            var plaintext = JsonSerializer.SerializeToUtf8Bytes(credential);
            byte[] ciphertext;
            try
            {
                ciphertext = _protector.Protect(plaintext);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plaintext);
            }
            var temporaryPath = Path.Combine(directory, $".{Path.GetFileName(_credentialPath)}.{Guid.NewGuid():N}.tmp");
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
                    await stream.WriteAsync(ciphertext, cancellationToken);
                    await stream.FlushAsync(cancellationToken);
                }
                File.Move(temporaryPath, _credentialPath, overwrite: true);
            }
            finally
            {
                if (File.Exists(temporaryPath))
                {
                    File.Delete(temporaryPath);
                }
            }
        }
        finally
        {
            _access.Release();
        }
    }

    public async Task ClearAsync(CancellationToken cancellationToken = default)
    {
        await _access.WaitAsync(cancellationToken);
        try
        {
            if (File.Exists(_credentialPath))
            {
                File.Delete(_credentialPath);
            }
        }
        finally
        {
            _access.Release();
        }
    }
}
