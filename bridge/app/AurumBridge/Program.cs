using AurumBridge.Storage;

namespace AurumBridge;

internal static class Program
{
    public static async Task Main()
    {
        var dataDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "AURUM",
            "BridgeV3");
        Directory.CreateDirectory(dataDirectory);

        await using var store = new BridgeStore(Path.Combine(dataDirectory, "bridge.db"));
        await store.InitializeAsync();
        Console.WriteLine("AURUM Bridge core initialized. UI and runtime wiring are not enabled yet.");
    }
}
