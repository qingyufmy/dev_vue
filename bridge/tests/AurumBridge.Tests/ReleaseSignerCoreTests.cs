using System.Security.Cryptography;
using System.Text;
using AurumBridge.ReleaseSigner;

namespace AurumBridge.Tests;

[TestClass]
public sealed class ReleaseSignerCoreTests
{
    [TestMethod]
    public void Sign_UsesP256Sha256P1363Contract()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var payload = Encoding.UTF8.GetBytes("AURUM-RELEASE-V2\ncontract");

        var signature = ReleaseSignerCore.Sign(key, payload);

        Assert.AreEqual(64, signature.Length);
        Assert.IsTrue(key.VerifyData(
            payload,
            signature,
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
    }

    [TestMethod]
    public void ExportPublicKeyPem_DoesNotContainPrivateKeyMaterial()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        var pem = ReleaseSignerCore.ExportPublicKeyPem(key);

        StringAssert.Contains(pem, "BEGIN PUBLIC KEY");
        Assert.IsFalse(pem.Contains("PRIVATE", StringComparison.Ordinal));
    }
}
