namespace AurumBridge.UI;

public static class BridgeBrandIcon
{
    public const string ResourceName = "AurumBridge.Assets.liangjian-bridge.ico";

    private static readonly Lazy<Icon> LazyApplicationIcon = new(LoadApplicationIcon);

    public static Icon ApplicationIcon => LazyApplicationIcon.Value;

    private static Icon LoadApplicationIcon()
    {
        var assembly = typeof(BridgeBrandIcon).Assembly;
        using var stream = assembly.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException(
                $"Missing embedded application icon: {ResourceName}");
        using var icon = new Icon(stream);
        return (Icon)icon.Clone();
    }
}
