namespace AurumBridge.Runtime;

public static class BridgeObserverRuntimeInitializer
{
    public static async Task InitializeIndependentlyAsync(
        IEnumerable<string> profileIds,
        Func<string, CancellationToken, Task> initializeAsync,
        Action<string, Exception> onFailure,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(profileIds);
        ArgumentNullException.ThrowIfNull(initializeAsync);
        ArgumentNullException.ThrowIfNull(onFailure);

        foreach (var profileId in profileIds)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                await initializeAsync(profileId, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception error)
            {
                onFailure(profileId, error);
            }
        }
    }
}
