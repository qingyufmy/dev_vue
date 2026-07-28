using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using AurumBridge.Launcher;
using AurumBridge.Runtime;
using AurumBridge.Update;

namespace AurumBridge.UpdateRehearsal;

internal static class Program
{
    private const string InstallationId = "install_0123456789abcdef0123456789abcdef";
    private static readonly JsonSerializerOptions OutputJson = new()
    {
        WriteIndented = false,
    };

    public static async Task<int> Main(string[] args)
    {
        try
        {
            var options = ParseArguments(args);
            var server = ParseLoopbackServer(Required(options, "server"));
            var publicKeyPath = ExistingFile(Required(options, "public-key"));
            var firstManifestPath = ExistingFile(Required(options, "first-manifest"));
            var secondManifestPath = ExistingFile(Required(options, "second-manifest"));
            var installRoot = PrepareEmptyInstallRoot(Required(options, "install-root"));
            var expectedServer = BridgeServerEndpointConfiguration.ParseServerUri(
                Required(options, "expected-server-url"));
            if (!Version.TryParse(Required(options, "initial-version"), out var initialVersion))
            {
                throw new ArgumentException("update_rehearsal_initial_version_invalid");
            }
            var releaseToken = Environment.GetEnvironmentVariable("AURUM_BRIDGE_RELEASE_API_TOKEN");
            if (string.IsNullOrWhiteSpace(releaseToken) || releaseToken.Length < 32)
            {
                throw new InvalidOperationException("update_rehearsal_release_token_invalid");
            }
            ConfigureIsolatedHealthEnvironment(installRoot);

            using var httpClient = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
            using var verifier = new ReleaseManifestVerifier(
                await File.ReadAllTextAsync(publicKeyPath));
            var manifestClient = new ReleaseManifestClient(server, httpClient);
            var installer = new ReleaseInstaller(installRoot, new ReleaseStager(httpClient));
            var pointerPath = Path.Combine(installRoot, "current.json");
            var pointerStore = new VersionPointerStore(pointerPath);
            var activationStore = new ReleaseActivationStore(pointerPath);
            var updateStateStore = new BridgeUpdateStateStore(
                Path.Combine(installRoot, "update-state.json"));
            var launcherVersion = typeof(LauncherEngine).Assembly.GetName().Version
                ?? throw new InvalidOperationException("update_rehearsal_launcher_version_missing");

            await pointerStore.SaveAsync(new()
            {
                ActiveVersion = initialVersion.ToString(),
                LastKnownGoodVersion = initialVersion.ToString(),
                Status = "healthy",
                ExpectedTerminalInstanceIds = [],
                UpdatedAtUtcMsc = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            });

            await PublishAsync(httpClient, server, releaseToken, firstManifestPath);
            var firstManifest = await FetchAsync(manifestClient, verifier, launcherVersion);
            var first = await installer.StageAsync(firstManifest, initialVersion)
                ?? throw new InvalidDataException("update_rehearsal_first_stage_missing");
            var firstServer = ReadServerEndpoint(first.VersionDirectory);
            EnsureExpectedServer(firstServer, expectedServer);
            await EnsureHealthCheckAsync(
                installRoot,
                first,
                "update_rehearsal_first_health_check_failed");
            await SaveActivatingStateAsync(updateStateStore, first);
            await activationStore.PrepareActivationAsync(first, initialVersion);
            var healthyEngine = new LauncherEngine(
                installRoot,
                pointerStore,
                new RehearsalProcessRunner(installRoot));
            var firstActivated = await healthyEngine.LaunchAsync();
            var firstPointer = await pointerStore.LoadAsync();
            var firstState = await updateStateStore.LoadAsync();
            if (firstActivated != first.Version
                || firstPointer.ActiveVersion != first.Version
                || firstPointer.LastKnownGoodVersion != first.Version
                || firstPointer.Status != "healthy"
                || firstState?.State != BridgeUpdateStates.Healthy
                || firstState.TargetVersion != first.Version
                || firstState.MaintenanceLeaseId is not null
                || firstState.LastErrorCode is not null)
            {
                throw new InvalidDataException("update_rehearsal_first_activation_invalid");
            }

            await PublishAsync(httpClient, server, releaseToken, secondManifestPath);
            var secondManifest = await FetchAsync(manifestClient, verifier, launcherVersion);
            var second = await installer.StageAsync(secondManifest, Version.Parse(first.Version))
                ?? throw new InvalidDataException("update_rehearsal_second_stage_missing");
            var secondServer = ReadServerEndpoint(second.VersionDirectory);
            EnsureExpectedServer(secondServer, expectedServer);
            await EnsureHealthCheckAsync(
                installRoot,
                second,
                "update_rehearsal_second_health_check_failed");
            await SaveActivatingStateAsync(updateStateStore, second);
            await activationStore.PrepareActivationAsync(second, Version.Parse(first.Version));
            var rollbackEngine = new LauncherEngine(
                installRoot,
                pointerStore,
                new RehearsalProcessRunner(installRoot, unreadyVersion:second.Version));
            var rollbackVersion = await rollbackEngine.LaunchAsync();
            var finalPointer = await pointerStore.LoadAsync();
            var finalState = await updateStateStore.LoadAsync();
            if (rollbackVersion != first.Version
                || finalPointer.ActiveVersion != first.Version
                || finalPointer.LastKnownGoodVersion != first.Version
                || finalPointer.Status != "rolled_back"
                || finalState?.State != BridgeUpdateStates.RolledBack
                || finalState.TargetVersion != second.Version
                || finalState.MaintenanceLeaseId is not null
                || finalState.LastErrorCode != "launcher_startup_readiness_failed")
            {
                throw new InvalidDataException("update_rehearsal_rollback_invalid");
            }

            WriteResult(new
            {
                ok = true,
                operation = "client-update-rehearsal",
                install_root = installRoot,
                first = new
                {
                    release_id = first.ReleaseId,
                    version = first.Version,
                    priority = first.Priority,
                    server_url = firstServer.AbsoluteUri.TrimEnd('/'),
                    health_check = "passed",
                    activation = "healthy",
                },
                second = new
                {
                    release_id = second.ReleaseId,
                    version = second.Version,
                    priority = second.Priority,
                    server_url = secondServer.AbsoluteUri.TrimEnd('/'),
                    health_check = "passed",
                    simulated_startup_readiness = "failed",
                },
                final_pointer = new
                {
                    active_version = finalPointer.ActiveVersion,
                    last_known_good_version = finalPointer.LastKnownGoodVersion,
                    status = finalPointer.Status,
                },
                final_update_state = new
                {
                    state = finalState.State,
                    target_version = finalState.TargetVersion,
                    last_error_code = finalState.LastErrorCode,
                    maintenance_lease_cleared = finalState.MaintenanceLeaseId is null,
                },
            });
            return 0;
        }
        catch (Exception error)
        {
            var failure = new Dictionary<string, object?>
            {
                ["ok"] = false,
                ["error"] = string.IsNullOrWhiteSpace(error.Message)
                    ? "update_rehearsal_failed"
                    : error.Message,
            };
            if (Environment.GetEnvironmentVariable("AURUM_BRIDGE_REHEARSAL_DEBUG") == "1")
            {
                failure["exception_type"] = error.GetType().FullName;
                failure["stack_trace"] = error.StackTrace;
            }
            WriteResult(failure);
            return 1;
        }
    }

    private static async Task<ReleaseManifest> FetchAsync(
        ReleaseManifestClient client,
        ReleaseManifestVerifier verifier,
        Version launcherVersion)
    {
        return await client.FetchVerifiedAsync(
            verifier,
            launcherVersion,
            InstallationId,
            "internal")
            ?? throw new InvalidDataException("update_rehearsal_manifest_missing");
    }

    private static async Task EnsureHealthCheckAsync(
        string installRoot,
        StagedRelease release,
        string failureCode)
    {
        var executable = Path.Combine(release.VersionDirectory, "AURUMBridge.exe");
        var runner = new BridgeProcessRunner(installRoot);
        if (!await runner.RunHealthCheckAsync(executable, TimeSpan.FromSeconds(10)))
        {
            throw new InvalidDataException(failureCode);
        }
    }

    private static async Task SaveActivatingStateAsync(
        BridgeUpdateStateStore store,
        StagedRelease release)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await store.SaveAsync(new()
        {
            State = BridgeUpdateStates.Activating,
            TargetVersion = release.Version,
            ReleaseId = release.ReleaseId,
            Priority = release.Priority,
            ManualActivationRequested = false,
            StagedAtUtcMsc = now,
            MinimumIdleSeconds = release.MinimumIdleSeconds,
            ActivationDeadlineUtcMsc = release.ActivationDeadlineUtcMsc,
            MaintenanceLeaseId = $"lease_local_{Guid.NewGuid():N}",
            MaintenanceLeaseExpiresAtUtcMsc = now
                + (long)TimeSpan.FromMinutes(10).TotalMilliseconds,
            UpdatedAtUtcMsc = now,
        });
    }

    private static void ConfigureIsolatedHealthEnvironment(string installRoot)
    {
        Environment.SetEnvironmentVariable(
            "AURUM_BRIDGE_DATA_DIR",
            Path.Combine(installRoot, "rehearsal-data"));
        foreach (var name in new[]
        {
            "AURUM_BRIDGE_SERVER_URL",
            "AURUM_BRIDGE_PYTHON",
            "AURUM_BRIDGE_MT5_WORKER",
            "AURUM_BRIDGE_MT4_EA",
            "AURUM_BRIDGE_RELEASE_API_TOKEN",
        })
        {
            Environment.SetEnvironmentVariable(name, null);
        }
    }

    private static async Task PublishAsync(
        HttpClient client,
        Uri server,
        string token,
        string manifestPath)
    {
        var manifest = await File.ReadAllTextAsync(manifestPath);
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            new Uri(server, "/api/admin/bridge/v3/releases/publish"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Content = new StringContent(
            $"{{\"manifest\":{manifest}}}",
            Encoding.UTF8,
            "application/json");
        using var response = await client.SendAsync(request);
        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException("update_rehearsal_publish_failed");
        }
        using var payload = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (!payload.RootElement.TryGetProperty("ok", out var ok) || !ok.GetBoolean())
        {
            throw new HttpRequestException("update_rehearsal_publish_failed");
        }
    }

    private static Uri ReadServerEndpoint(string versionDirectory)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(
            Path.Combine(versionDirectory, BridgeServerEndpointConfiguration.FileName)));
        if (!document.RootElement.TryGetProperty("server_url", out var value)
            || value.ValueKind != JsonValueKind.String)
        {
            throw new InvalidDataException("update_rehearsal_server_endpoint_missing");
        }
        return BridgeServerEndpointConfiguration.ParseServerUri(value.GetString()!);
    }

    private static void EnsureExpectedServer(Uri actual, Uri expected)
    {
        if (actual != expected)
        {
            throw new InvalidDataException("update_rehearsal_server_endpoint_mismatch");
        }
    }

    private static Uri ParseLoopbackServer(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || !uri.IsLoopback
            || uri.Scheme != Uri.UriSchemeHttp
            || uri.UserInfo.Length > 0
            || uri.Query.Length > 0
            || uri.Fragment.Length > 0
            || uri.AbsolutePath != "/")
        {
            throw new ArgumentException("update_rehearsal_server_invalid");
        }
        return uri;
    }

    private static string PrepareEmptyInstallRoot(string value)
    {
        var root = Path.GetFullPath(value);
        Directory.CreateDirectory(root);
        if (Directory.EnumerateFileSystemEntries(root).Any())
        {
            throw new IOException("update_rehearsal_install_root_not_empty");
        }
        return root;
    }

    private static string ExistingFile(string value)
    {
        var file = Path.GetFullPath(value);
        return File.Exists(file)
            ? file
            : throw new FileNotFoundException("update_rehearsal_file_missing", file);
    }

    private static Dictionary<string, string> ParseArguments(string[] args)
    {
        if (args.Length == 0 || args.Length % 2 != 0)
        {
            throw new ArgumentException("update_rehearsal_arguments_invalid");
        }
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var index = 0; index < args.Length; index += 2)
        {
            if (!args[index].StartsWith("--", StringComparison.Ordinal)
                || string.IsNullOrWhiteSpace(args[index + 1])
                || !values.TryAdd(args[index][2..], args[index + 1]))
            {
                throw new ArgumentException("update_rehearsal_arguments_invalid");
            }
        }
        return values;
    }

    private static string Required(IReadOnlyDictionary<string, string> values, string key)
    {
        return values.TryGetValue(key, out var value)
            ? value
            : throw new ArgumentException($"update_rehearsal_{key.Replace('-', '_')}_missing");
    }

    private static void WriteResult(object value) => Console.WriteLine(
        JsonSerializer.Serialize(value, OutputJson));
}

internal sealed class RehearsalProcessRunner(
    string installRoot,
    string? unreadyVersion = null) : IBridgeProcessRunner
{
    private readonly BridgeProcessRunner _healthRunner = new BridgeProcessRunner(installRoot);

    public Task<bool> RunHealthCheckAsync(
        string executablePath,
        TimeSpan timeout,
        CancellationToken cancellationToken = default) =>
        _healthRunner.RunHealthCheckAsync(executablePath, timeout, cancellationToken);

    public Task<bool> StartBridgeAndWaitReadyAsync(
        string executablePath,
        string expectedVersion,
        IReadOnlyList<string> expectedTerminalInstanceIds,
        bool startMinimized,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        _ = executablePath;
        _ = expectedTerminalInstanceIds;
        _ = timeout;
        _ = cancellationToken;
        return Task.FromResult(!string.Equals(
            expectedVersion,
            unreadyVersion,
            StringComparison.Ordinal));
    }

    public void StartBridge(string executablePath, bool startMinimized)
    {
        _ = executablePath;
        _ = startMinimized;
    }
}
