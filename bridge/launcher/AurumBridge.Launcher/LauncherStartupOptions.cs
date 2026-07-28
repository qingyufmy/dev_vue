namespace AurumBridge.Launcher;

public sealed record LauncherStartupOptions(
    bool StartMinimized,
    TimeSpan Delay)
{
    private static readonly TimeSpan AutoStartDelay = TimeSpan.FromSeconds(10);

    public static LauncherStartupOptions Parse(IReadOnlyList<string> args)
    {
        ArgumentNullException.ThrowIfNull(args);
        return args.Count switch
        {
            0 => new(false, TimeSpan.Zero),
            1 when args[0] == "--autostart" => new(true, AutoStartDelay),
            _ => throw new ArgumentException("launcher_arguments_invalid", nameof(args)),
        };
    }
}
