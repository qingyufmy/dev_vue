using AurumBridge.Protocol;

namespace AurumBridge.Runtime;

public interface IBridgeTerminalRuntime : IAsyncDisposable
{
    TerminalDescriptor Terminal { get; }
    Task StartAsync(CancellationToken cancellationToken = default);
    Task<CommandResultMessage> ExecuteCommandAsync(
        CommandMessage command,
        CancellationToken cancellationToken = default);
    Task RunCollectionLoopAsync(CancellationToken cancellationToken = default);
    void RequestFullSnapshot(string stream);
}
