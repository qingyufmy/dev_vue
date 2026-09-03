using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Liangjian.BridgeV4.Update
{
    /// <summary>
    /// Small .NET Framework CNG adapter for the fixed P-256 SPKI and raw
    /// IEEE-P1363 signatures used by the shared release contract.
    /// </summary>
    internal sealed class ReleaseSignatureVerifier : IDisposable
    {
        private readonly ECDsaCng verifier;

        public ReleaseSignatureVerifier(string subjectPublicKeyPem)
        {
            verifier = new ECDsaCng(ImportSubjectPublicKey(subjectPublicKeyPem));
        }

        public ReleaseSignatureVerifier(byte[] eccPublicBlob)
        {
            if (eccPublicBlob == null || eccPublicBlob.Length != 72)
            {
                throw Invalid("update_public_key_invalid");
            }
            try
            {
                verifier = new ECDsaCng(CngKey.Import(eccPublicBlob, CngKeyBlobFormat.EccPublicBlob));
            }
            catch (CryptographicException)
            {
                throw Invalid("update_public_key_invalid");
            }
        }

        public bool Verify(byte[] data, byte[] signature)
        {
            try
            {
                return verifier.VerifyData(data, signature, HashAlgorithmName.SHA256);
            }
            catch (CryptographicException)
            {
                return false;
            }
        }

        public void Dispose()
        {
            verifier.Dispose();
        }

        private static CngKey ImportSubjectPublicKey(string pem)
        {
            if (string.IsNullOrWhiteSpace(pem) || pem.Length > 16 * 1024)
            {
                throw Invalid("update_public_key_invalid");
            }
            string normalized = pem.Trim();
            const string begin = "-----BEGIN PUBLIC KEY-----";
            const string end = "-----END PUBLIC KEY-----";
            if (!normalized.StartsWith(begin, StringComparison.Ordinal)
                || !normalized.EndsWith(end, StringComparison.Ordinal))
            {
                throw Invalid("update_public_key_invalid");
            }
            string body = normalized.Substring(begin.Length, normalized.Length - begin.Length - end.Length);
            body = body.Replace("\r", string.Empty).Replace("\n", string.Empty).Replace(" ", string.Empty).Replace("\t", string.Empty);
            byte[] der;
            try
            {
                der = Convert.FromBase64String(body);
            }
            catch (FormatException)
            {
                throw Invalid("update_public_key_invalid");
            }
            byte[] eccBlob = ParseP256SubjectPublicKey(der);
            try
            {
                return CngKey.Import(eccBlob, CngKeyBlobFormat.EccPublicBlob);
            }
            catch (CryptographicException)
            {
                throw Invalid("update_public_key_invalid");
            }
        }

        private static byte[] ParseP256SubjectPublicKey(byte[] der)
        {
            DerReader outer = new DerReader(der);
            DerReader subject = outer.ReadConstructed(0x30);
            DerReader algorithm = subject.ReadConstructed(0x30);
            byte[] ecPublicKeyOid = algorithm.ReadPrimitive(0x06);
            byte[] p256Oid = algorithm.ReadPrimitive(0x06);
            if (algorithm.Remaining != 0 || !Equal(ecPublicKeyOid, new byte[] { 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01 })
                || !Equal(p256Oid, new byte[] { 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07 }))
            {
                throw Invalid("update_public_key_invalid");
            }
            byte[] bitString = subject.ReadPrimitive(0x03);
            if (bitString.Length != 66 || bitString[0] != 0 || bitString[1] != 0x04 || subject.Remaining != 0 || outer.Remaining != 0)
            {
                throw Invalid("update_public_key_invalid");
            }
            byte[] blob = new byte[72];
            blob[0] = 0x45;
            blob[1] = 0x43;
            blob[2] = 0x53;
            blob[3] = 0x31;
            blob[4] = 32;
            Array.Copy(bitString, 2, blob, 8, 64);
            return blob;
        }

        private static bool Equal(byte[] left, byte[] right)
        {
            if (left == null || right == null || left.Length != right.Length) return false;
            for (int index = 0; index < left.Length; index++) if (left[index] != right[index]) return false;
            return true;
        }

        private static InvalidDataException Invalid(string code)
        {
            return new InvalidDataException(code);
        }

        private sealed class DerReader
        {
            private readonly byte[] bytes;
            private int offset;
            private readonly int end;

            public DerReader(byte[] value)
            {
                if (value == null) throw Invalid("update_public_key_invalid");
                bytes = value;
                end = value.Length;
            }

            private DerReader(byte[] value, int start, int length)
            {
                bytes = value;
                offset = start;
                end = start + length;
            }

            public int Remaining { get { return end - offset; } }

            public DerReader ReadConstructed(byte expectedTag)
            {
                byte[] value = ReadElement(expectedTag);
                return new DerReader(value, 0, value.Length);
            }

            public byte[] ReadPrimitive(byte expectedTag)
            {
                return ReadElement(expectedTag);
            }

            private byte[] ReadElement(byte expectedTag)
            {
                if (offset >= end || bytes[offset++] != expectedTag) throw Invalid("update_public_key_invalid");
                int length = ReadLength();
                if (length < 0 || length > end - offset) throw Invalid("update_public_key_invalid");
                byte[] result = new byte[length];
                Array.Copy(bytes, offset, result, 0, length);
                offset += length;
                return result;
            }

            private int ReadLength()
            {
                if (offset >= end) throw Invalid("update_public_key_invalid");
                int first = bytes[offset++];
                if ((first & 0x80) == 0) return first;
                int count = first & 0x7f;
                if (count == 0 || count > 4 || count > end - offset) throw Invalid("update_public_key_invalid");
                int result = 0;
                for (int index = 0; index < count; index++)
                {
                    result = checked((result << 8) | bytes[offset++]);
                }
                return result;
            }
        }
    }
}
