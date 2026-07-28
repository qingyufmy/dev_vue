using System.Security.Cryptography;

namespace AurumBridge.ReleaseSigner;

public static class ReleaseSignerCore
{
    public static byte[] Sign(ECDsa privateKey, ReadOnlySpan<byte> payload)
    {
        ArgumentNullException.ThrowIfNull(privateKey);
        if (privateKey.KeySize != 256)
        {
            throw new InvalidOperationException("release_signing_key_curve_invalid");
        }

        return privateKey.SignData(
            payload,
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
    }

    public static string ExportPublicKeyPem(ECDsa key)
    {
        ArgumentNullException.ThrowIfNull(key);
        if (key.KeySize != 256)
        {
            throw new InvalidOperationException("release_signing_key_curve_invalid");
        }

        return key.ExportSubjectPublicKeyInfoPem();
    }
}
