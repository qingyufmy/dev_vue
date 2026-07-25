using System.Diagnostics;
using System.Globalization;

namespace AurumBridge.Runtime;

public sealed record BridgeRuntimeHealthSnapshot(
    long UptimeSeconds,
    long WorkingSetBytes,
    long PrivateMemoryBytes,
    long ManagedHeapBytes,
    long CpuTimeMilliseconds,
    int Gen0Collections,
    int Gen1Collections,
    int Gen2Collections,
    BridgeApplicationPhase Phase,
    int TerminalCount);

public static class BridgeRuntimeHealthSampler
{
    public static BridgeRuntimeHealthSnapshot Capture(
        long startedTimestamp,
        BridgeApplicationPhase phase,
        int terminalCount)
    {
        if (startedTimestamp <= 0 || startedTimestamp > Stopwatch.GetTimestamp())
        {
            throw new ArgumentOutOfRangeException(nameof(startedTimestamp));
        }
        if (terminalCount < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(terminalCount));
        }
        using var process = Process.GetCurrentProcess();
        process.Refresh();
        return new(
            (long)Stopwatch.GetElapsedTime(startedTimestamp).TotalSeconds,
            process.WorkingSet64,
            process.PrivateMemorySize64,
            GC.GetTotalMemory(forceFullCollection:false),
            (long)process.TotalProcessorTime.TotalMilliseconds,
            GC.CollectionCount(0),
            GC.CollectionCount(1),
            GC.CollectionCount(2),
            phase,
            terminalCount);
    }

    public static string Format(BridgeRuntimeHealthSnapshot sample)
    {
        ArgumentNullException.ThrowIfNull(sample);
        return string.Create(CultureInfo.InvariantCulture,
            $"uptime_seconds={sample.UptimeSeconds}; working_set_bytes={sample.WorkingSetBytes}; "
            + $"private_memory_bytes={sample.PrivateMemoryBytes}; managed_heap_bytes={sample.ManagedHeapBytes}; "
            + $"cpu_time_milliseconds={sample.CpuTimeMilliseconds}; "
            + $"gc_collections={sample.Gen0Collections},{sample.Gen1Collections},{sample.Gen2Collections}; "
            + $"phase={sample.Phase}; terminals={sample.TerminalCount}");
    }
}
