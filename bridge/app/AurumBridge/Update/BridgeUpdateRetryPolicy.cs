namespace AurumBridge.Update;

public static class BridgeUpdateRetryPolicy
{
    private const double MinimumJitter = 0.8;
    private const double MaximumJitter = 1.2;
    private static readonly TimeSpan MaximumDelay = TimeSpan.FromMinutes(15);

    public static TimeSpan ComputeCheckDelay(
        int consecutiveFailures,
        double jitterSample)
    {
        if (consecutiveFailures < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(consecutiveFailures));
        }
        if (double.IsNaN(jitterSample) || jitterSample < 0 || jitterSample > 1)
        {
            throw new ArgumentOutOfRangeException(nameof(jitterSample));
        }
        var exponent = Math.Min(consecutiveFailures - 1, 5);
        var baseSeconds = Math.Min(30 * (1 << exponent), MaximumDelay.TotalSeconds);
        var jitter = MinimumJitter
            + (MaximumJitter - MinimumJitter) * jitterSample;
        return TimeSpan.FromSeconds(Math.Min(baseSeconds * jitter, MaximumDelay.TotalSeconds));
    }
}
