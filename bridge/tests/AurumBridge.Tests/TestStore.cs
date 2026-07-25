using AurumBridge.Storage;

namespace AurumBridge.Tests;

internal sealed class TestStore : IAsyncDisposable
{
    private readonly string _directory;
    public BridgeStore Store { get; }

    private TestStore(string directory, BridgeStore store)
    {
        _directory = directory;
        Store = store;
    }

    public static async Task<TestStore> CreateAsync()
    {
        var directory = Path.Combine(Path.GetTempPath(), "aurum-bridge-tests", Guid.NewGuid().ToString("N"));
        var store = new BridgeStore(Path.Combine(directory, "bridge.db"));
        await store.InitializeAsync();
        return new(directory, store);
    }

    public async ValueTask DisposeAsync()
    {
        await Store.DisposeAsync();
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive: true);
        }
    }
}
