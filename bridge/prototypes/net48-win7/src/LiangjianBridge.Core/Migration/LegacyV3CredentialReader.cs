using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.Migration
{
    /// <summary>
    /// The V3 credential is only an input to the one-time exchange. It is
    /// never copied to the migration snapshot or written to the V4 catalog.
    /// </summary>
    public sealed class LegacyV3RefreshCredential : IDisposable
    {
        private string refreshToken;
        private bool disposed;

        internal LegacyV3RefreshCredential(string token, long expiresAtUtcMsc)
        {
            refreshToken = token;
            ExpiresAtUtcMsc = expiresAtUtcMsc;
        }

        public long ExpiresAtUtcMsc { get; private set; }

        public string RefreshToken
        {
            get
            {
                if (disposed) throw new ObjectDisposedException("LegacyV3RefreshCredential");
                return refreshToken;
            }
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            refreshToken = null;
            ExpiresAtUtcMsc = 0;
        }
    }

    public static class LegacyV3CredentialReader
    {
        public const int MaximumCiphertextBytes = 64 * 1024;
        public const int MaximumRefreshTokenLength = 512;
        public const string CredentialFileName = "credential.dat";
        public const string EntropyText = "AURUM Bridge v3 refresh credential";

        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes(EntropyText);
        private static readonly JavaScriptSerializer Serializer = CreateSerializer();

        public static LegacyV3RefreshCredential Read(string path, long nowUtcMsc)
        {
            if (string.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path)
                || nowUtcMsc < 0 || !IsRegularFile(path))
            {
                throw Invalid();
            }

            byte[] ciphertext = null;
            byte[] plaintext = null;
            string json = null;
            try
            {
                FileInfo info = new FileInfo(path);
                if (info.Length <= 0 || info.Length > MaximumCiphertextBytes)
                {
                    throw Invalid();
                }
                ciphertext = File.ReadAllBytes(path);
                if (ciphertext.Length == 0 || ciphertext.Length > MaximumCiphertextBytes)
                {
                    throw Invalid();
                }
                plaintext = ProtectedData.Unprotect(ciphertext, Entropy,
                    DataProtectionScope.CurrentUser);
                if (plaintext == null || plaintext.Length == 0 || plaintext.Length > MaximumCiphertextBytes)
                {
                    throw Invalid();
                }
                json = new UTF8Encoding(false, true).GetString(plaintext);
                return Parse(json, nowUtcMsc);
            }
            catch (InvalidDataException)
            {
                throw Invalid();
            }
            catch (Exception)
            {
                // Never surface a DPAPI, JSON or HTTP payload that could
                // contain the refresh token.
                throw Invalid();
            }
            finally
            {
                if (ciphertext != null) Array.Clear(ciphertext, 0, ciphertext.Length);
                if (plaintext != null) Array.Clear(plaintext, 0, plaintext.Length);
                json = null;
            }
        }

        private static LegacyV3RefreshCredential Parse(string json, long nowUtcMsc)
        {
            IDictionary<string, object> root;
            try
            {
                root = Serializer.DeserializeObject(json) as IDictionary<string, object>;
            }
            catch (Exception)
            {
                throw Invalid();
            }
            RequireExactFields(root, new[] { "RefreshToken", "ExpiresAtUtcMsc" });

            object tokenValue;
            object expiryValue;
            if (!root.TryGetValue("RefreshToken", out tokenValue)
                || !root.TryGetValue("ExpiresAtUtcMsc", out expiryValue))
            {
                throw Invalid();
            }
            string token = tokenValue as string;
            if (!ValidRefreshToken(token)) throw Invalid();
            long expiresAt = ReadInt64(expiryValue);
            if (expiresAt <= nowUtcMsc) throw Invalid();
            return new LegacyV3RefreshCredential(token, expiresAt);
        }

        private static bool ValidRefreshToken(string token)
        {
            if (string.IsNullOrWhiteSpace(token) || token.Length < 40
                || token.Length > MaximumRefreshTokenLength)
            {
                return false;
            }
            for (int index = 0; index < token.Length; index++)
            {
                char current = token[index];
                if (current < 0x21 || current == 0x7f || current == '\r'
                    || current == '\n' || current == '\0')
                {
                    return false;
                }
            }
            return true;
        }

        private static long ReadInt64(object value)
        {
            try
            {
                if (value is decimal)
                {
                    decimal decimalValue = (decimal)value;
                    if (decimal.Truncate(decimalValue) != decimalValue
                        || decimalValue < long.MinValue || decimalValue > long.MaxValue)
                    {
                        throw Invalid();
                    }
                    return (long)decimalValue;
                }
                if (!(value is byte) && !(value is sbyte) && !(value is short)
                    && !(value is ushort) && !(value is int) && !(value is uint)
                    && !(value is long) && !(value is ulong))
                {
                    throw Invalid();
                }
                return Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture);
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch (Exception)
            {
                throw Invalid();
            }
        }

        private static void RequireExactFields(IDictionary<string, object> values, string[] fields)
        {
            if (values == null || values.Count != fields.Length) throw Invalid();
            HashSet<string> expected = new HashSet<string>(fields, StringComparer.Ordinal);
            foreach (string key in values.Keys)
            {
                if (!expected.Remove(key)) throw Invalid();
            }
            if (expected.Count != 0) throw Invalid();
        }

        private static bool IsRegularFile(string path)
        {
            try
            {
                FileAttributes attributes = File.GetAttributes(path);
                return (attributes & FileAttributes.Directory) == 0
                    && (attributes & FileAttributes.ReparsePoint) == 0;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = MaximumCiphertextBytes;
            serializer.RecursionLimit = 8;
            return serializer;
        }

        private static InvalidDataException Invalid()
        {
            return new InvalidDataException("legacy_v3_credential_invalid");
        }
    }
}
