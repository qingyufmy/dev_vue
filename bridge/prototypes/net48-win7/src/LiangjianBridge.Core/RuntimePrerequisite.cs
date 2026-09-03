using System;
using Microsoft.Win32;

namespace Liangjian.BridgeV4
{
    public sealed class RuntimeStatus
    {
        public RuntimeStatus(bool supported, int release, string source)
        {
            Supported = supported;
            Release = release;
            Source = source;
        }

        public bool Supported { get; private set; }
        public int Release { get; private set; }
        public string Source { get; private set; }
    }

    public static class RuntimePrerequisite
    {
        public const int NetFramework48MinimumRelease = 528040;
        private const string FullKey = @"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full";

        public static RuntimeStatus Detect()
        {
            RuntimeStatus status = ReadView(RegistryView.Registry32);
            RuntimeStatus alternate = ReadView(RegistryView.Registry64);
            return alternate.Release > status.Release ? alternate : status;
        }

        private static RuntimeStatus ReadView(RegistryView view)
        {
            try
            {
                using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                using (RegistryKey key = root.OpenSubKey(FullKey, false))
                {
                    object value = key == null ? null : key.GetValue("Release");
                    int release = value is int ? (int)value : 0;
                    return new RuntimeStatus(
                        release >= NetFramework48MinimumRelease,
                        release,
                        view == RegistryView.Registry32 ? "registry32" : "registry64");
                }
            }
            catch (Exception error)
            {
                return new RuntimeStatus(false, 0, "registry_error:" + error.GetType().Name);
            }
        }
    }
}
