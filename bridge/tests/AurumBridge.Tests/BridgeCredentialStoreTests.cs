using System.Text;
using AurumBridge.Security;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeCredentialStoreTests
{
    private string _directory = null!;
    private string _path = null!;

    [TestInitialize]
    public void Initialize()
    {
        _directory = Path.Combine(Path.GetTempPath(), $"aurum-credential-tests-{Guid.NewGuid():N}");
        _path = Path.Combine(_directory, "credential.dat");
    }

    [TestCleanup]
    public void Cleanup()
    {
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive: true);
        }
    }

    [TestMethod]
    public async Task PersistsOnlyProtectedCredentialMaterialAndCanClearIt()
    {
        var store = new FileBridgeCredentialStore(_path, new ReversingProtector());
        var credential = new BridgeCredential("refresh_" + new string('x', 64), 1_900_000_000_000);

        await store.SaveAsync(credential);
        var raw = await File.ReadAllTextAsync(_path);
        Assert.DoesNotContain(credential.RefreshToken, raw);
        Assert.AreEqual(credential, await store.LoadAsync());

        await store.ClearAsync();
        Assert.IsNull(await store.LoadAsync());
    }

    [TestMethod]
    public async Task AStaleProfileCannotRecreateAuthorizationAfterLogout()
    {
        var firstProcess = new FileBridgeCredentialStore(_path, new ReversingProtector());
        var logoutProcess = new FileBridgeCredentialStore(_path, new ReversingProtector());
        var credential = new BridgeCredential("refresh_" + new string('x', 64), 1_900_000_000_000);
        await firstProcess.SaveAsync(credential);
        var staleCopy = await firstProcess.LoadAsync();
        Assert.IsNotNull(staleCopy);

        await logoutProcess.ClearAsync();
        var saved = await firstProcess.SaveIfCurrentAsync(
            staleCopy,
            staleCopy with { ExpiresAtUtcMsc = staleCopy.ExpiresAtUtcMsc + 1_000 });

        Assert.IsFalse(saved);
        Assert.IsNull(await logoutProcess.LoadAsync());
    }

    [TestMethod]
    public void WindowsDpapiRoundTripsOnlyForTheCurrentUser()
    {
        if (!OperatingSystem.IsWindows())
        {
            Assert.Inconclusive("DPAPI is Windows-only.");
        }
        var protector = new WindowsDpapiProtector();
        var plaintext = Encoding.UTF8.GetBytes("bridge-secret");
        var ciphertext = protector.Protect(plaintext);

        Assert.IsFalse(plaintext.SequenceEqual(ciphertext));
        CollectionAssert.AreEqual(plaintext, protector.Unprotect(ciphertext));
    }

    private sealed class ReversingProtector : IDataProtector
    {
        public byte[] Protect(byte[] plaintext) => plaintext.Reverse().Select(value => (byte)(value ^ 0xA5)).ToArray();
        public byte[] Unprotect(byte[] ciphertext) => ciphertext.Select(value => (byte)(value ^ 0xA5)).Reverse().ToArray();
    }
}
