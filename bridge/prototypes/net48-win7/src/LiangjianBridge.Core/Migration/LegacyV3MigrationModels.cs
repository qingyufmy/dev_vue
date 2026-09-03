using System.Collections.Generic;

namespace Liangjian.BridgeV4.Migration
{
    public sealed class LegacyV3MigrationSnapshot
    {
        public int SchemaVersion { get; set; }
        public string LegacyInstallationId { get; set; }
        public LegacySourceRoots LegacySourceRoots { get; set; }
        public LegacyEndpointOverride EndpointOverride { get; set; }
        public List<LegacyV3ProfileSnapshot> Profiles { get; set; }
        public bool CredentialExchangeRequired { get; set; }
        public List<string> DiscardedCategories { get; set; }
        public long CreatedAtUtcMsc { get; set; }
        public string SourceFingerprint { get; set; }
    }

    public sealed class LegacySourceRoots
    {
        public string InstallRoot { get; set; }
        public string DataRoot { get; set; }
    }

    public sealed class LegacyEndpointOverride
    {
        public string Status { get; set; }
        public string LegacyControlUri { get; set; }
        public string LegacyRealtimeUri { get; set; }
        public string CandidateControlUri { get; set; }
        public string CandidateRealtimeUri { get; set; }
        public bool ActivationReady { get; set; }
        public string Reason { get; set; }
    }

    public sealed class LegacyV3ProfileSnapshot
    {
        public string ProfileId { get; set; }
        public string SourceRelativePath { get; set; }
        public LegacyV3PreferencesSnapshot Preferences { get; set; }
        public List<LegacyTerminalBindingSnapshot> TerminalBindings { get; set; }
        public bool CredentialFilePresent { get; set; }
        public string CredentialState { get; set; }
        public bool CredentialExchangeRequired { get; set; }
    }

    public sealed class LegacyV3PreferencesSnapshot
    {
        public bool Present { get; set; }
        public string Platform { get; set; }
        public string Mt5TerminalInstanceId { get; set; }
        public string Mt5TerminalPath { get; set; }
        public string Mt4TerminalInstanceId { get; set; }
        public string Mt4TerminalPath { get; set; }
        public bool? ObserverEnabled { get; set; }
        public long? ObserverBridgeUserId { get; set; }
        public string ObserverAccountLabel { get; set; }
        public long? ObserverTradingAccountId { get; set; }
        public string ObserverTradingAccountLabel { get; set; }
        public string ObserverClaimedTerminalInstanceId { get; set; }
        public bool? AutoStartEnabled { get; set; }
    }

    public sealed class LegacyTerminalBindingSnapshot
    {
        public string TerminalInstanceId { get; set; }
        public string Platform { get; set; }
        public string TerminalPath { get; set; }
        public string BrokerServer { get; set; }
        public string Login { get; set; }
        public long ConnectionEpoch { get; set; }
        public long UpdatedAtUtcMsc { get; set; }
    }
}
