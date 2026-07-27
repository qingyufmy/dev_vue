namespace AurumBridge.Runtime;

internal static class BridgeSymbolIdentity
{
    private static readonly HashSet<string> BrokerSuffixes = new(
        ["a", "s", "c", "pro", "std", "z", "ecn", "m", "raw", "mini"],
        StringComparer.OrdinalIgnoreCase);

    public static bool Equivalent(string left, string right) =>
        string.Equals(StandardName(left), StandardName(right), StringComparison.OrdinalIgnoreCase);

    private static string StandardName(string symbol)
    {
        var separator = symbol.LastIndexOf('.');
        if (separator <= 0 || separator == symbol.Length - 1)
        {
            return symbol;
        }
        return BrokerSuffixes.Contains(symbol[(separator + 1)..])
            ? symbol[..separator]
            : symbol;
    }
}
