using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using AurumBridge.Protocol;

namespace AurumBridge.Workers;

public sealed record Mt5ProbeResult(
    string TerminalPath,
    AccountRef AccountRef,
    JsonElement Account,
    JsonElement Terminal);

public sealed class Mt5ProbeClient
{
    private const int MaxProbeOutputCharacters = 1024 * 1024;

    public async Task<Mt5ProbeResult> ProbeAsync(
        string pythonExecutable,
        string workerScript,
        string terminalPath,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        var startInfo = BuildStartInfo(pythonExecutable, workerScript, terminalPath);
        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("mt5_probe_process_start_failed");
        using var timeoutCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCancellation.CancelAfter(timeout);
        try
        {
            var stdoutTask = process.StandardOutput.ReadToEndAsync(timeoutCancellation.Token);
            var stderrTask = process.StandardError.ReadToEndAsync(timeoutCancellation.Token);
            await process.WaitForExitAsync(timeoutCancellation.Token);
            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            if (stdout.Length > MaxProbeOutputCharacters || stderr.Length > MaxProbeOutputCharacters)
            {
                throw new InvalidDataException("mt5_probe_output_too_large");
            }
            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException("mt5_probe_failed");
            }
            var result = ParseResponse(stdout);
            if (!string.Equals(
                Path.GetFullPath(result.TerminalPath),
                Path.GetFullPath(terminalPath),
                StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("mt5_probe_terminal_path_mismatch");
            }
            return result;
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None);
            }
            cancellationToken.ThrowIfCancellationRequested();
            throw new TimeoutException("mt5_probe_timeout");
        }
    }

    public static ProcessStartInfo BuildStartInfo(
        string pythonExecutable,
        string workerScript,
        string terminalPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pythonExecutable);
        ArgumentException.ThrowIfNullOrWhiteSpace(workerScript);
        ArgumentException.ThrowIfNullOrWhiteSpace(terminalPath);
        var startInfo = new ProcessStartInfo
        {
            FileName = pythonExecutable,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };
        foreach (var argument in new[] { workerScript, "--probe", "--terminal", terminalPath })
        {
            startInfo.ArgumentList.Add(argument);
        }
        return startInfo;
    }

    public static Mt5ProbeResult ParseResponse(string payloadJson)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(payloadJson);
        var payload = JsonSerializer.Deserialize<Mt5ProbePayload>(payloadJson, BridgeJson.Options)
            ?? throw new InvalidDataException("mt5_probe_response_invalid");
        if (payload.Version != 3
            || payload.Type != "mt5_probe"
            || string.IsNullOrWhiteSpace(payload.TerminalPath)
            || string.IsNullOrWhiteSpace(payload.AccountRef.Login)
            || string.IsNullOrWhiteSpace(payload.AccountRef.BrokerServer)
            || payload.Account.ValueKind != JsonValueKind.Object
            || payload.Terminal.ValueKind != JsonValueKind.Object
            || !payload.Terminal.TryGetProperty("connected", out var connected)
            || connected.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
            || !connected.GetBoolean())
        {
            throw new InvalidDataException("mt5_probe_response_invalid");
        }
        return new(payload.TerminalPath, payload.AccountRef, payload.Account, payload.Terminal);
    }

    private sealed record Mt5ProbePayload
    {
        [JsonPropertyName("v")]
        public int Version { get; init; }

        [JsonPropertyName("type")]
        public string Type { get; init; } = string.Empty;

        [JsonPropertyName("terminal_path")]
        public string TerminalPath { get; init; } = string.Empty;

        [JsonPropertyName("account_ref")]
        public AccountRef AccountRef { get; init; } = new(string.Empty, string.Empty);

        [JsonPropertyName("account")]
        public JsonElement Account { get; init; }

        [JsonPropertyName("terminal")]
        public JsonElement Terminal { get; init; }
    }
}
