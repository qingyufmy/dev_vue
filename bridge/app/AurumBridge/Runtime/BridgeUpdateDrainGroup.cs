namespace AurumBridge.Runtime;

public interface IBridgeUpdateDrainTarget
{
    Task PauseForUpdateAsync(TimeSpan timeout, CancellationToken cancellationToken = default);
    void ResumeAfterFailedUpdate();
}

public sealed class BridgeUpdateDrainGroup : IDisposable
{
    private readonly IReadOnlyList<IBridgeUpdateDrainTarget> _targets;
    private bool _committed;
    private bool _disposed;

    private BridgeUpdateDrainGroup(IReadOnlyList<IBridgeUpdateDrainTarget> targets)
    {
        _targets = targets;
    }

    public static async Task<BridgeUpdateDrainGroup> AcquireAsync(
        IEnumerable<IBridgeUpdateDrainTarget> targets,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(targets);
        if (timeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(timeout));
        }
        var distinct = new List<IBridgeUpdateDrainTarget>();
        foreach (var target in targets)
        {
            ArgumentNullException.ThrowIfNull(target);
            if (!distinct.Any(existing => ReferenceEquals(existing, target)))
            {
                distinct.Add(target);
            }
        }
        if (distinct.Count < 1)
        {
            throw new ArgumentException("bridge_update_drain_targets_required", nameof(targets));
        }
        var paused = new List<IBridgeUpdateDrainTarget>(distinct.Count);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        try
        {
            foreach (var target in distinct)
            {
                await target.PauseForUpdateAsync(timeout, deadline.Token);
                paused.Add(target);
            }
            return new(paused);
        }
        catch
        {
            for (var index = paused.Count - 1; index >= 0; index--)
            {
                paused[index].ResumeAfterFailedUpdate();
            }
            throw;
        }
    }

    public void Commit() => _committed = true;

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        if (_committed)
        {
            return;
        }
        for (var index = _targets.Count - 1; index >= 0; index--)
        {
            _targets[index].ResumeAfterFailedUpdate();
        }
    }
}
