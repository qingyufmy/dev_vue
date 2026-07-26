using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AurumBridge.Security;

public sealed record BridgeCredential(string RefreshToken, long ExpiresAtUtcMsc);

public interface IBridgeCredentialStore
{
    Task<BridgeCredential?> LoadAsync(CancellationToken cancellationToken = default);
    Task SaveAsync(BridgeCredential credential, CancellationToken cancellationToken = default);
    Task<bool> SaveIfCurrentAsync(
        BridgeCredential expected,
        BridgeCredential credential,
        CancellationToken cancellationToken = default);
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
    private readonly string _lockPath;
    private readonly IDataProtector _protector;
    private readonly SemaphoreSlim _access = new(1, 1);

    public FileBridgeCredentialStore(string credentialPath, IDataProtector protector)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(credentialPath);
        _credentialPath = Path.GetFullPath(credentialPath);
        _lockPath = $"{_credentialPath}.lock";
        _protector = protector ?? throw new ArgumentNullException(nameof(protector));
    }

    public async Task<BridgeCredential?> LoadAsync(CancellationToken cancellationToken = default)
    {
        await _access.WaitAsync(cancellationToken);
        try
        {
            await using var processLock = await AcquireProcessLockAsync(cancellationToken);
            return await LoadCoreAsync(cancellationToken);
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
            await using var processLock = await AcquireProcessLockAsync(cancellationToken);
            await SaveCoreAsync(credential, cancellationToken);
        }
        finally
        {
            _access.Release();
        }
    }

    public async Task<bool> SaveIfCurrentAsync(
        BridgeCredential expected,
        BridgeCredential credential,
        CancellationToken cancellationToken = default)
    {
        ValidateCredential(expected, nameof(expected));
        ValidateCredential(credential, nameof(credential));
        await _access.WaitAsync(cancellationToken);
        try
        {
            await using var processLock = await AcquireProcessLockAsync(cancellationToken);
            var current = await LoadCoreAsync(cancellationToken);
            if (current is null || !CryptographicOperations.FixedTimeEquals(
                    Encoding.UTF8.GetBytes(current.RefreshToken),
                    Encoding.UTF8.GetBytes(expected.RefreshToken)))
            {
                return false;
            }
            await SaveCoreAsync(credential, cancellationToken);
            return true;
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
            await using var processLock = await AcquireProcessLockAsync(cancellationToken);
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

    private async Task<BridgeCredential?> LoadCoreAsync(CancellationToken cancellationToken)
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

    private async Task SaveCoreAsync(
        BridgeCredential credential,
        CancellationToken cancellationToken)
    {
        var directory = Path.GetDirectoryName(_credentialPath)!;
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
        var temporaryPath = Path.Combine(
            directory,
            $".{Path.GetFileName(_credentialPath)}.{Guid.NewGuid():N}.tmp");
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

    private async Task<FileStream> AcquireProcessLockAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_credentialPath)!);
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                return new FileStream(
                    _lockPath,
                    FileMode.OpenOrCreate,
                    FileAccess.ReadWrite,
                    FileShare.None,
                    bufferSize:1,
                    FileOptions.Asynchronous);
            }
            catch (IOException) when (!cancellationToken.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(25), cancellationToken);
            }
        }
    }

    private static void ValidateCredential(BridgeCredential credential, string parameterName)
    {
        ArgumentNullException.ThrowIfNull(credential, parameterName);
        if (credential.RefreshToken.Length < 40)
        {
            throw new ArgumentException("Bridge refresh credential is invalid.", parameterName);
        }
    }
}
