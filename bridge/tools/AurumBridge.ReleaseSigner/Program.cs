using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

namespace AurumBridge.ReleaseSigner;

internal static class Program
{
    private const int MaximumPayloadBytes = 1024 * 1024;

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length < 1)
            {
                throw new InvalidOperationException("release_signer_command_required");
            }

            var options = ParseOptions(args.Skip(1).ToArray());
            using var certificate = LoadCertificate();
            return args[0].ToLowerInvariant() switch
            {
                "sign" => Sign(certificate, Required(options, "input"), Required(options, "output")),
                "export-public-key" => ExportPublicKey(certificate, Required(options, "output")),
                "self-test" => SelfTest(certificate),
                _ => throw new InvalidOperationException("release_signer_command_invalid"),
            };
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(JsonSerializer.Serialize(new
            {
                ok = false,
                error = SafeErrorCode(exception),
            }));
            return 1;
        }
    }

    private static Dictionary<string, string> ParseOptions(string[] values)
    {
        if (values.Length % 2 != 0)
        {
            throw new InvalidOperationException("release_signer_arguments_invalid");
        }

        var options = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < values.Length; index += 2)
        {
            if (!values[index].StartsWith("--", StringComparison.Ordinal) || values[index].Length <= 2)
            {
                throw new InvalidOperationException("release_signer_arguments_invalid");
            }

            if (!options.TryAdd(values[index][2..], values[index + 1]))
            {
                throw new InvalidOperationException("release_signer_arguments_invalid");
            }
        }

        return options;
    }

    private static string Required(IReadOnlyDictionary<string, string> options, string name)
    {
        return options.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new InvalidOperationException($"release_signer_{name}_required");
    }

    private static X509Certificate2 LoadCertificate()
    {
        var configured = Environment.GetEnvironmentVariable("AURUM_BRIDGE_SIGNING_CERT_THUMBPRINT");
        var thumbprint = string.Concat((configured ?? string.Empty).Where(Uri.IsHexDigit)).ToUpperInvariant();
        if (thumbprint.Length < 40)
        {
            throw new InvalidOperationException("release_signing_certificate_thumbprint_missing");
        }

        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
        var matches = store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: false);
        if (matches.Count != 1)
        {
            throw new InvalidOperationException("release_signing_certificate_not_found");
        }

        var certificate = matches[0];
        var now = DateTime.UtcNow;
        if (!certificate.HasPrivateKey || now < certificate.NotBefore.ToUniversalTime() || now > certificate.NotAfter.ToUniversalTime())
        {
            throw new InvalidOperationException("release_signing_certificate_invalid");
        }

        using var key = certificate.GetECDsaPrivateKey();
        if (key is null || key.KeySize != 256)
        {
            throw new InvalidOperationException("release_signing_key_curve_invalid");
        }

        return certificate;
    }

    private static int Sign(X509Certificate2 certificate, string inputPath, string outputPath)
    {
        var input = Path.GetFullPath(inputPath);
        var output = Path.GetFullPath(outputPath);
        var info = new FileInfo(input);
        if (!info.Exists || info.Length <= 0 || info.Length > MaximumPayloadBytes)
        {
            throw new InvalidOperationException("release_signer_input_invalid");
        }

        var payload = File.ReadAllBytes(input);
        using var privateKey = certificate.GetECDsaPrivateKey()
            ?? throw new InvalidOperationException("release_signing_private_key_unavailable");
        var signature = Convert.ToBase64String(ReleaseSignerCore.Sign(privateKey, payload));
        WriteNewTextFile(output, signature);
        Console.WriteLine(JsonSerializer.Serialize(new { ok = true, operation = "sign" }));
        return 0;
    }

    private static int ExportPublicKey(X509Certificate2 certificate, string outputPath)
    {
        using var publicKey = certificate.GetECDsaPublicKey()
            ?? throw new InvalidOperationException("release_signing_public_key_unavailable");
        WriteNewTextFile(Path.GetFullPath(outputPath), ReleaseSignerCore.ExportPublicKeyPem(publicKey));
        Console.WriteLine(JsonSerializer.Serialize(new { ok = true, operation = "export-public-key" }));
        return 0;
    }

    private static int SelfTest(X509Certificate2 certificate)
    {
        var payload = Encoding.UTF8.GetBytes("AURUM-RELEASE-SIGNER-SELF-TEST");
        using var privateKey = certificate.GetECDsaPrivateKey()
            ?? throw new InvalidOperationException("release_signing_private_key_unavailable");
        using var publicKey = certificate.GetECDsaPublicKey()
            ?? throw new InvalidOperationException("release_signing_public_key_unavailable");
        var signature = ReleaseSignerCore.Sign(privateKey, payload);
        if (!publicKey.VerifyData(
            payload,
            signature,
            System.Security.Cryptography.HashAlgorithmName.SHA256,
            System.Security.Cryptography.DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
        {
            throw new InvalidOperationException("release_signer_self_test_failed");
        }

        Console.WriteLine(JsonSerializer.Serialize(new { ok = true, operation = "self-test" }));
        return 0;
    }

    private static void WriteNewTextFile(string outputPath, string value)
    {
        var directory = Path.GetDirectoryName(outputPath);
        if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory))
        {
            throw new InvalidOperationException("release_signer_output_directory_invalid");
        }

        using var stream = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        using var writer = new StreamWriter(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        writer.Write(value);
    }

    private static string SafeErrorCode(Exception exception)
    {
        return exception.Message.StartsWith("release_", StringComparison.Ordinal)
            ? exception.Message
            : "release_signer_failed";
    }
}
