using AurumBridge.Runtime;

namespace AurumBridge.UI;

public static class BridgeStatusFingerprint
{
    public static string ForLog(BridgeApplicationStatus status)
    {
        ArgumentNullException.ThrowIfNull(status);
        return string.Join(
            "|",
            status.Phase,
            status.DetailCode ?? string.Empty,
            status.SelectedPlatform ?? string.Empty,
            status.SelectedTerminalInstanceId ?? string.Empty,
            status.ServerConnected,
            status.CanManageObserverSources,
            string.Join(",", status.TerminalCandidates.Select(candidate =>
                candidate.TerminalInstanceId)),
            DescribeTerminals(status.Terminals));
    }

    public static string ForAccounts(
        BridgeApplicationStatus status,
        IReadOnlyList<BridgeObserverProfileView> observerProfiles,
        IEnumerable<string> busyObserverProfiles)
    {
        ArgumentNullException.ThrowIfNull(status);
        ArgumentNullException.ThrowIfNull(observerProfiles);
        ArgumentNullException.ThrowIfNull(busyObserverProfiles);
        return string.Join(
            "|",
            status.CanManageObserverSources,
            DescribeTerminals(status.Terminals),
            string.Join(",", observerProfiles.Select(profile => string.Join(
                ":",
                profile.ProfileId,
                profile.Platform ?? string.Empty,
                profile.Configured,
                profile.Enabled,
                profile.TerminalInstanceId ?? string.Empty,
                profile.BridgeUserId?.ToString() ?? string.Empty,
                profile.ObserverAccountLabel ?? string.Empty,
                profile.TradingAccountLabel ?? string.Empty,
                profile.RuntimePhase?.ToString() ?? string.Empty,
                profile.RuntimeDetailCode ?? string.Empty))),
            string.Join(",", busyObserverProfiles.Order(StringComparer.Ordinal)));
    }

    private static string DescribeTerminals(IEnumerable<BridgeTerminalStatus> terminals) =>
        string.Join(",", terminals.Select(terminal => string.Join(
            ":",
            terminal.TerminalInstanceId,
            terminal.Platform,
            terminal.BrokerServer,
            terminal.Login,
            terminal.RuntimeState,
            terminal.ErrorCode ?? string.Empty,
            terminal.ObserverProfileId ?? string.Empty,
            terminal.TerminalTradingAllowed?.ToString() ?? string.Empty,
            terminal.ProgramTradingAllowed?.ToString() ?? string.Empty,
            terminal.AccountTradingAllowed?.ToString() ?? string.Empty,
            terminal.AccountExpertTradingAllowed?.ToString() ?? string.Empty)));
}
