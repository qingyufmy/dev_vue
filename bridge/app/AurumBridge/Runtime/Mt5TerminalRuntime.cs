using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Storage;
using AurumBridge.Workers;

namespace AurumBridge.Runtime;

public sealed class Mt5TerminalRuntime : IAsyncDisposable
{
    private static readonly string[] CollectionStreams = ["account", "positions", "orders"];
    private readonly TerminalDescriptor _terminal;
    private readonly IMt5WorkerClient _worker;
    private readonly BridgeStore _store;
    private readonly Func<long> _clock;
    private readonly Dictionary<string, long> _revisions = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _account = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Dictionary<string, string>> _collections = new(StringComparer.Ordinal)
    {
        ["positions"] = new(StringComparer.Ordinal),
        ["orders"] = new(StringComparer.Ordinal),
    };
    private bool _initialized;

    public Mt5TerminalRuntime(
        TerminalDescriptor terminal,
        IMt5WorkerClient worker,
        BridgeStore store,
        Func<long>? clock = null)
    {
        _terminal = terminal ?? throw new ArgumentNullException(nameof(terminal));
        _worker = worker ?? throw new ArgumentNullException(nameof(worker));
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public TerminalDescriptor Terminal => _terminal;

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        await _worker.StartAsync(TimeSpan.FromSeconds(20), cancellationToken);
        foreach (var stream in CollectionStreams)
        {
            _revisions[stream] = await _store.GetStreamRevisionAsync(
                _terminal.TerminalInstanceId,
                _terminal.ConnectionEpoch,
                stream,
                cancellationToken);
        }
        _initialized = true;
    }

    public async Task<CommandResultMessage> ExecuteCommandAsync(
        CommandMessage command,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        var response = await _worker.RequestAsync(command, cancellationToken);
        return response.Deserialize<CommandResultMessage>(BridgeJson.Options)
            ?? throw new InvalidDataException("mt5_worker_command_result_invalid");
    }

    public async Task RunCollectionLoopAsync(CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        var fullSnapshot = true;
        var lastCalibration = 0L;
        var lastAccountCollection = 0L;
        while (!cancellationToken.IsCancellationRequested)
        {
            var now = _clock();
            if (now - lastCalibration >= 10_000)
            {
                fullSnapshot = true;
                lastCalibration = now;
            }
            var requestedStreams = new List<string> { "positions", "orders" };
            if (fullSnapshot || now - lastAccountCollection >= 1_000)
            {
                requestedStreams.Insert(0, "account");
                lastAccountCollection = now;
            }
            var response = await _worker.RequestAsync(new
            {
                v = 3,
                type = "collect",
                request_id = $"collect_{Guid.NewGuid():N}",
                streams = requestedStreams,
            }, cancellationToken);
            await IngestSnapshotAsync(response, fullSnapshot, cancellationToken);
            fullSnapshot = false;
            var active = _collections["positions"].Count > 0 || _collections["orders"].Count > 0;
            await Task.Delay(active ? 250 : 750, cancellationToken);
        }
    }

    public async Task<int> IngestSnapshotAsync(
        JsonElement snapshot,
        bool fullSnapshot,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        if (!snapshot.TryGetProperty("v", out var version) || version.GetInt32() != 3
            || !snapshot.TryGetProperty("type", out var type) || type.GetString() != "snapshot"
            || !snapshot.TryGetProperty("streams", out var streams) || streams.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException("mt5_worker_snapshot_invalid");
        }
        var observedAt = snapshot.TryGetProperty("observed_at_utc_msc", out var observed)
            ? observed.GetInt64()
            : _clock();
        var persisted = 0;
        if (streams.TryGetProperty("account", out var account) && account.ValueKind == JsonValueKind.Object)
        {
            var raw = account.GetRawText();
            if (fullSnapshot || !_account.TryGetValue("value", out var previous) || previous != raw)
            {
                await PersistAsync("account", [account.Clone()], [], fullSnapshot, observedAt, cancellationToken);
                _account["value"] = raw;
                persisted++;
            }
        }
        foreach (var stream in new[] { "positions", "orders" })
        {
            if (!streams.TryGetProperty(stream, out var values) || values.ValueKind != JsonValueKind.Array)
            {
                continue;
            }
            var current = new Dictionary<string, string>(StringComparer.Ordinal);
            var elements = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            foreach (var value in values.EnumerateArray())
            {
                var ticket = ReadTicket(value, stream);
                current[ticket] = value.GetRawText();
                elements[ticket] = value.Clone();
            }
            var previous = _collections[stream];
            var upserts = fullSnapshot
                ? elements.Values.ToArray()
                : elements.Where(pair => !previous.TryGetValue(pair.Key, out var old) || old != current[pair.Key])
                    .Select(pair => pair.Value).ToArray();
            var deletes = fullSnapshot
                ? Array.Empty<JsonElement>()
                : previous.Keys.Where(ticket => !current.ContainsKey(ticket))
                    .Select(ticket => JsonSerializer.SerializeToElement(ticket)).ToArray();
            if (fullSnapshot || upserts.Length > 0 || deletes.Length > 0)
            {
                await PersistAsync(stream, upserts, deletes, fullSnapshot, observedAt, cancellationToken);
                persisted++;
            }
            _collections[stream] = current;
        }
        return persisted;
    }

    private async Task PersistAsync(
        string stream,
        IReadOnlyList<JsonElement> upserts,
        IReadOnlyList<JsonElement> deletes,
        bool fullSnapshot,
        long observedAt,
        CancellationToken cancellationToken)
    {
        var baseRevision = fullSnapshot ? 0 : _revisions[stream];
        var revision = _revisions[stream] + 1;
        var message = new DataDeltaMessage
        {
            Type = "data_delta",
            MessageId = $"delta_{_terminal.TerminalInstanceId}_{stream}_{revision}_{Guid.NewGuid():N}",
            SentAtUtcMsc = _clock(),
            TerminalInstanceId = _terminal.TerminalInstanceId,
            AccountRef = _terminal.AccountRef,
            ConnectionEpoch = _terminal.ConnectionEpoch,
            Stream = stream,
            Revision = revision,
            BaseRevision = baseRevision,
            ObservedAtUtcMsc = observedAt,
            SourceTimeMsc = null,
            FullSnapshot = fullSnapshot,
            Upserts = upserts,
            Deletes = deletes,
        };
        var result = await _store.PersistDataDeltaAsync(message, cancellationToken);
        if (result.Status is not (PersistDeltaStatus.Applied or PersistDeltaStatus.Duplicate))
        {
            throw new InvalidDataException("mt5_snapshot_revision_gap");
        }
        _revisions[stream] = revision;
    }

    private static string ReadTicket(JsonElement item, string stream)
    {
        var property = item.TryGetProperty("ticket", out var ticket)
            ? ticket
            : item.TryGetProperty(stream == "positions" ? "position_id" : "order_id", out ticket)
                ? ticket
                : throw new InvalidDataException($"mt5_{stream}_ticket_missing");
        return property.ValueKind switch
        {
            JsonValueKind.String => property.GetString()!,
            JsonValueKind.Number => property.GetRawText(),
            _ => throw new InvalidDataException($"mt5_{stream}_ticket_invalid"),
        };
    }

    private void EnsureInitialized()
    {
        if (!_initialized)
        {
            throw new InvalidOperationException("MT5 terminal runtime is not initialized.");
        }
    }

    public ValueTask DisposeAsync() => _worker.DisposeAsync();
}
