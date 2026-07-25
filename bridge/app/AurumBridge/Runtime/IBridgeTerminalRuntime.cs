using AurumBridge.Protocol;

namespace AurumBridge.Runtime;

public interface IBridgeTerminalRuntime : IAsyncDisposable
{
    TerminalDescriptor Terminal { get; }
    Task StartAsync(CancellationToken cancellationToken = default);
    Task<CommandResultMessage> ExecuteCommandAsync(
        CommandMessage command,
        CancellationToken cancellationToken = default);
    Task<QuoteMessage> GetQuoteAsync(
        QuoteRequestMessage request,
        CancellationToken cancellationToken = default);
    Task<DataResponseMessage> GetDataAsync(
        DataRequestMessage request,
        CancellationToken cancellationToken = default) => Task.FromResult(new DataResponseMessage
        {
            Type = "data_response",
            MessageId = $"data_{request.RequestId}_{Guid.NewGuid():N}",
            SentAtUtcMsc = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            RequestId = request.RequestId,
            TerminalInstanceId = request.TerminalInstanceId,
            AccountRef = request.AccountRef,
            ConnectionEpoch = request.ConnectionEpoch,
            Action = request.Action,
            Params = request.Params,
            ObservedAtUtcMsc = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Status = "rejected",
            ErrorCode = "terminal_data_action_unavailable",
        });
    Task RunCollectionLoopAsync(CancellationToken cancellationToken = default);
    void RequestFullSnapshot(string stream);
}
