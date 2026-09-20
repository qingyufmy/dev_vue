using System;
using System.IO;
using Liangjian.BridgeV4.Configuration;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class Mt4AdapterInstallerSmokeTests
    {
        public static void RunAll()
        {
            string root = Path.Combine(Path.GetTempPath(), "bridge-mt4-install-" + Guid.NewGuid().ToString("N"));
            string first = Path.Combine(root, "first");
            string second = Path.Combine(root, "second");
            string firstExperts = Path.Combine(first, "MQL4", "Experts");
            string secondExperts = Path.Combine(second, "MQL4", "Experts");
            try
            {
                Directory.CreateDirectory(firstExperts); Directory.CreateDirectory(secondExperts);
                string source = Path.Combine(root, Mt4AdapterInstaller.AdapterFileName);
                File.WriteAllText(source, "v4-fixture");
                bool rejected = false;
                try { Mt4AdapterInstaller.Install(source, root, false); } catch (IOException) { rejected = true; }
                Assert(rejected, "non_mt4_directory_accepted");
                Mt4AdapterInstallResult installed = Mt4AdapterInstaller.Install(source, first, false);
                Assert(installed.Changed && installed.Destination == Path.Combine(firstExperts, Mt4AdapterInstaller.AdapterFileName), "wrong_mt4_destination");
                Assert(Directory.GetFiles(secondExperts).Length == 0, "unselected_terminal_modified");
                Assert(!Mt4AdapterInstaller.Install(source, first, false).Changed, "identical_adapter_rewritten");
                File.WriteAllText(installed.Destination, "existing-user-adapter");
                Assert(Mt4AdapterInstaller.NeedsOverwrite(source, first, false), "different_adapter_not_detected");
                rejected = false;
                try { Mt4AdapterInstaller.Install(source, first, false); } catch (IOException) { rejected = true; }
                Assert(rejected && File.ReadAllText(installed.Destination) == "existing-user-adapter", "unconfirmed_adapter_overwritten");
                Mt4AdapterInstallResult replaced = Mt4AdapterInstaller.Install(source, first, true);
                Assert(File.ReadAllText(replaced.Backup) == "existing-user-adapter", "original_adapter_not_backed_up");
                Assert(File.ReadAllText(replaced.Destination) == "v4-fixture", "adapter_replace_failed");
                Mt4AdapterInstallResult exported = Mt4AdapterInstaller.Export(source, second, false);
                Assert(exported.Destination == Path.Combine(second, Mt4AdapterInstaller.AdapterFileName)
                    && Directory.GetFiles(secondExperts).Length == 0, "export_modified_terminal");
                rejected = false;
                try { Mt4AdapterInstaller.Install(Path.Combine(root, "AURUMBridge.ex4"), first, true); } catch (IOException) { rejected = true; }
                Assert(rejected, "legacy_adapter_source_accepted");
            }
            finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
        }

        private static void Assert(bool value, string code) { if (!value) throw new InvalidOperationException(code); }
    }
}
