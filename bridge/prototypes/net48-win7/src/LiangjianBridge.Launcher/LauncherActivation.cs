using System;
using System.Diagnostics;
using System.IO;

namespace Liangjian.BridgeV4.LauncherApp
{
    public sealed class LauncherActivationResult
    {
        public string ActiveVersion { get; internal set; }
        public bool RolledBack { get; internal set; }
        public string ErrorCode { get; internal set; }
    }

    public static class LauncherActivation
    {
        private const int HealthTimeoutMilliseconds = 15000;

        public static LauncherActivationResult ActivateAndLaunch(string installRoot, string targetVersion)
        {
            return ActivateAndLaunch(installRoot, targetVersion, RunHealthCheck, StartApplication);
        }

        public static LauncherActivationResult ActivateAndLaunch(string installRoot, string targetVersion,
            bool startMinimized)
        {
            return ActivateAndLaunch(installRoot, targetVersion, RunHealthCheck,
                delegate(string executable) { StartApplication(executable, startMinimized); });
        }

        public static LauncherActivationResult ActivateAndLaunch(string installRoot, string targetVersion,
            Func<string, bool> healthCheck, Action<string> launch)
        {
            if (healthCheck == null || launch == null)
            {
                throw new ArgumentNullException("bridge_launcher_callback_missing");
            }

            string previousVersion = VersionPointer.Activate(installRoot, targetVersion);
            string targetExecutable = VersionPointer.ResolveExecutable(installRoot, targetVersion);
            bool pendingActivation = string.Equals(VersionPointer.ReadPendingActivation(installRoot),
                targetVersion, StringComparison.Ordinal);
            try
            {
                if (!healthCheck(targetExecutable))
                {
                    throw new InvalidDataException("bridge_version_health_check_failed");
                }
                if (pendingActivation)
                {
                    VersionPointer.CompleteActivation(installRoot, targetVersion);
                }
                launch(targetExecutable);
                return new LauncherActivationResult
                {
                    ActiveVersion = VersionPointer.ReadCurrentVersion(installRoot),
                    RolledBack = false,
                    ErrorCode = null
                };
            }
            catch (Exception error)
            {
                if (pendingActivation)
                {
                    string rollbackVersion = VersionPointer.Rollback(installRoot, targetVersion);
                    string rollbackExecutable = VersionPointer.ResolveExecutable(installRoot, rollbackVersion);
                    launch(rollbackExecutable);
                    return new LauncherActivationResult
                    {
                        ActiveVersion = rollbackVersion,
                        RolledBack = true,
                        ErrorCode = SafeErrorCode(error)
                    };
                }
                throw;
            }
        }

        public static void LaunchCurrent(string installRoot)
        {
            LaunchCurrent(installRoot, false);
        }

        public static void LaunchCurrent(string installRoot, bool startMinimized)
        {
            string pending = VersionPointer.ReadPendingActivation(installRoot);
            if (pending != null)
            {
                ActivateAndLaunch(installRoot, pending, startMinimized);
                return;
            }
            string version = VersionPointer.ReadCurrentVersion(installRoot);
            StartApplication(VersionPointer.ResolveExecutable(installRoot, version), startMinimized);
        }

        private static bool RunHealthCheck(string executable)
        {
            if (RunHealthProcess(executable, "--health-check", null)) return true;

            DirectoryInfo versionDirectory = new FileInfo(executable).Directory;
            DirectoryInfo versionsDirectory = versionDirectory == null ? null : versionDirectory.Parent;
            DirectoryInfo installRoot = versionsDirectory == null ? null : versionsDirectory.Parent;
            if (versionsDirectory == null || installRoot == null
                || !string.Equals(versionsDirectory.Name, "versions", StringComparison.OrdinalIgnoreCase))
                return false;
            string healthDirectory = Path.Combine(installRoot.FullName, "health");
            Directory.CreateDirectory(healthDirectory);
            string healthFile = Path.Combine(healthDirectory,
                "health-v4-rollback-" + Guid.NewGuid().ToString("N") + ".json");
            try
            {
                return RunHealthProcess(executable,
                    "--health-check --health-file \"" + healthFile + "\"", healthFile);
            }
            finally
            {
                if (File.Exists(healthFile)) File.Delete(healthFile);
            }
        }

        private static bool RunHealthProcess(string executable, string arguments, string expectedFile)
        {
            using (Process process = Process.Start(new ProcessStartInfo(executable, arguments)
            {
                WorkingDirectory = Path.GetDirectoryName(executable),
                UseShellExecute = false,
                CreateNoWindow = true
            }))
            {
                if (process == null) return false;
                if (!process.WaitForExit(HealthTimeoutMilliseconds))
                {
                    try { process.Kill(); }
                    catch (InvalidOperationException) { }
                    return false;
                }
                return process.ExitCode == 0
                    && (string.IsNullOrEmpty(expectedFile) || File.Exists(expectedFile));
            }
        }

        private static void StartApplication(string executable)
        {
            StartApplication(executable, false);
        }

        private static void StartApplication(string executable, bool startMinimized)
        {
            Process.Start(new ProcessStartInfo(executable, startMinimized ? "--start-minimized" : string.Empty)
            {
                WorkingDirectory = Path.GetDirectoryName(executable),
                UseShellExecute = true
            });
        }

        private static string SafeErrorCode(Exception error)
        {
            string value = error == null ? null : error.Message;
            if (string.IsNullOrEmpty(value) || value.Length > 128) return "bridge_version_activation_failed";
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                if (!((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9')
                    || character == '_')) return "bridge_version_activation_failed";
            }
            return value;
        }
    }
}
