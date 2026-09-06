using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace Liangjian.BridgeV4.Runtime
{
    // A short-lived observation of the exact terminal account, not a cached
    // permission decision. All reads use the existing account-only adapter.
    public sealed class BridgeTerminalIdentityMonitor
    {
        public const int ProbeIntervalMilliseconds = 10000;
        public const int MaximumObservationAgeMilliseconds = 25000;
        private readonly object gate = new object();
        private readonly Func<long, IDictionary<string, object>> source;
        private readonly Func<long> utcNow;
        private readonly Func<int> tickNow;
        private bool observed;
        private int lastProbeTick;
        private int expiresAtTick;

        public BridgeTerminalIdentityMonitor(Func<long, IDictionary<string, object>> sourceValue)
            : this(sourceValue, delegate { return (long)(DateTime.UtcNow
                - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; },
                delegate { return Environment.TickCount; })
        {
        }

        public BridgeTerminalIdentityMonitor(Func<long, IDictionary<string, object>> sourceValue,
            Func<long> utcNowValue, Func<int> tickNowValue)
        {
            if (sourceValue == null || utcNowValue == null || tickNowValue == null)
                throw new ArgumentNullException("bridge_identity_monitor_configuration");
            source = sourceValue; utcNow = utcNowValue; tickNow = tickNowValue;
        }

        public IDictionary<string, object> Read(long requestedAtUtcMsc)
        {
            IDictionary<string, object> facts = source(requestedAtUtcMsc);
            object value;
            if (facts == null || !facts.TryGetValue("observed_at_utc_msc", out value)
                || !(value is long || value is int))
                throw new InvalidDataException("bridge_terminal_identity_observation_invalid");
            long sourceTime = Convert.ToInt64(value, CultureInfo.InvariantCulture);
            long completedAt = utcNow();
            long age = completedAt - sourceTime;
            if (sourceTime < 1 || age < -1000 || age >= MaximumObservationAgeMilliseconds)
                throw new InvalidDataException("bridge_terminal_identity_observation_stale");
            int tick = tickNow();
            lock (gate)
            {
                observed = true;
                lastProbeTick = tick;
                // A delayed response consumes its age; returning now never
                // turns a stale source observation into a fresh identity.
                expiresAtTick = unchecked(tick + MaximumObservationAgeMilliseconds - (int)Math.Max(0, age));
            }
            return facts;
        }

        public bool ProbeDue()
        {
            lock (gate) return observed && unchecked(tickNow() - lastProbeTick) >= ProbeIntervalMilliseconds;
        }

        public bool IsExpired()
        {
            lock (gate) return !observed || unchecked(tickNow() - expiresAtTick) >= 0;
        }
    }
}
