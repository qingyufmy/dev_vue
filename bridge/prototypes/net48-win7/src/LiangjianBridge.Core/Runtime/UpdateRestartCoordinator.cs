using System;
using System.Collections.Generic;
using System.IO;
using Liangjian.BridgeV4.Protocol;

namespace Liangjian.BridgeV4.Runtime
{
    public sealed class UpdateActivitySnapshot
    {
        public int ActiveCommands { get; set; }
        public int UncertainCommands { get; set; }
        public int PendingCriticalWrites { get; set; }
    }

    public sealed class PendingBridgeRelease
    {
        public string ReleaseId { get; set; }
        public string Version { get; set; }
        public string ManifestUrl { get; set; }
        public string RolloutChannel { get; set; }
        public string Reason { get; set; }
        public long RestartNotBeforeUtcMsc { get; set; }
        public bool Staged { get; set; }
    }

    public sealed class UpdateRestartCoordinator
    {
        private readonly object gate = new object();
        private PendingBridgeRelease pending;

        public PendingBridgeRelease Pending
        {
            get { lock (gate) return Copy(pending); }
        }

        public void Observe(BridgeEnvelope envelope)
        {
            if (envelope == null || envelope.MessageType != "release.available")
            {
                throw new InvalidDataException("bridge_release_invalid");
            }
            RequireOnly(envelope.Payload, "release_id", "release_version", "rollout_channel", "reason", "manifest_url", "restart_not_before_utc_msc");
            string channel = ReadText(envelope.Payload, "rollout_channel", 16);
            string reason = ReadText(envelope.Payload, "reason", 16);
            Uri manifest;
            string manifestUrl = ReadText(envelope.Payload, "manifest_url", 2048);
            if ((channel != "internal" && channel != "stable") || (reason != "published" && reason != "rollback")
                || !Uri.TryCreate(manifestUrl, UriKind.Absolute, out manifest) || manifest.Scheme != Uri.UriSchemeHttps)
            {
                throw new InvalidDataException("bridge_release_invalid");
            }
            lock (gate)
            {
                pending = new PendingBridgeRelease
                {
                    ReleaseId = ReadText(envelope.Payload, "release_id", 191),
                    Version = ReadVersion(envelope.Payload),
                    ManifestUrl = manifest.AbsoluteUri,
                    RolloutChannel = channel,
                    Reason = reason,
                    RestartNotBeforeUtcMsc = ReadLong(envelope.Payload, "restart_not_before_utc_msc"),
                    Staged = false
                };
            }
        }

        public void MarkStaged(string releaseId)
        {
            lock (gate)
            {
                if (pending == null || pending.ReleaseId != releaseId)
                    throw new InvalidDataException("bridge_release_stage_mismatch");
                pending.Staged = true;
            }
        }

        public string ReadyVersion(long nowUtcMsc, UpdateActivitySnapshot activity)
        {
            if (activity == null || activity.ActiveCommands < 0 || activity.UncertainCommands < 0 || activity.PendingCriticalWrites < 0)
            {
                throw new InvalidDataException("bridge_update_activity_invalid");
            }
            lock (gate)
            {
                return pending != null && pending.Staged && nowUtcMsc >= pending.RestartNotBeforeUtcMsc
                    && activity.ActiveCommands == 0 && activity.UncertainCommands == 0 && activity.PendingCriticalWrites == 0
                    ? pending.Version : null;
            }
        }

        public bool TryActivateAndRestart(long nowUtcMsc, UpdateActivitySnapshot activity,
            Func<string, bool> activateAndRestart)
        {
            if (activateAndRestart == null)
            {
                throw new ArgumentNullException("activateAndRestart");
            }
            string version = ReadyVersion(nowUtcMsc, activity);
            if (version == null || !activateAndRestart(version))
            {
                return false;
            }
            lock (gate)
            {
                if (pending != null && pending.Version == version) pending = null;
            }
            return true;
        }

        public void Clear(string releaseId)
        {
            lock (gate)
            {
                if (pending == null || pending.ReleaseId != releaseId)
                    throw new InvalidDataException("bridge_release_clear_mismatch");
                pending = null;
            }
        }

        private static PendingBridgeRelease Copy(PendingBridgeRelease value)
        {
            return value == null ? null : new PendingBridgeRelease
            {
                ReleaseId = value.ReleaseId, Version = value.Version, ManifestUrl = value.ManifestUrl,
                RolloutChannel = value.RolloutChannel, Reason = value.Reason,
                RestartNotBeforeUtcMsc = value.RestartNotBeforeUtcMsc, Staged = value.Staged
            };
        }

        private static string ReadVersion(IDictionary<string, object> payload)
        {
            string text = ReadText(payload, "release_version", 64);
            Version version;
            if (!Version.TryParse(text, out version) || version.Major < 0) throw new InvalidDataException("bridge_release_version_invalid");
            return version.ToString();
        }
        private static string ReadText(IDictionary<string, object> values, string key, int max)
        {
            object raw; string text;
            if (!values.TryGetValue(key, out raw) || (text = raw as string) == null || text.Length == 0 || text.Length > max) throw new InvalidDataException("bridge_release_invalid");
            return text;
        }
        private static long ReadLong(IDictionary<string, object> values, string key)
        {
            object raw;
            if (!values.TryGetValue(key, out raw)) throw new InvalidDataException("bridge_release_invalid");
            long value = raw is int ? (int)raw : raw is long ? (long)raw : 0;
            if (value < 1) throw new InvalidDataException("bridge_release_invalid");
            return value;
        }
        private static void RequireOnly(IDictionary<string, object> values, params string[] fields)
        {
            HashSet<string> expected = new HashSet<string>(fields, StringComparer.Ordinal);
            foreach (string key in values.Keys) if (!expected.Remove(key)) throw new InvalidDataException("bridge_release_invalid");
            if (expected.Count != 0) throw new InvalidDataException("bridge_release_invalid");
        }
    }
}
