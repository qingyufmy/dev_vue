using System.Diagnostics;
using AurumBridge.Runtime;
using AurumBridge.Security;
using AurumBridge.Update;
using AurumBridge.Workers;

namespace AurumBridge.UI;

public sealed class BridgeApplicationContext : ApplicationContext
{
    private readonly BridgeMainForm _form;
    private readonly NotifyIcon _notifyIcon;
    private readonly BridgeApplicationController _controller;
    private readonly BridgeFileLogger _logger;
    private readonly BridgeUserPreferencesStore _preferences;
    private readonly BridgeSingleInstanceGuard _singleInstance;
    private readonly BridgeUpdateCoordinator? _updateCoordinator;
    private readonly string? _startupReadyFile;
    private readonly string _profileId;
    private readonly string _rootDataDirectory;
    private readonly bool _backgroundMode;
    private readonly BridgeFailureLogThrottle _failureLogThrottle = new(TimeSpan.FromMinutes(1));
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _observerRuntimeReload = new(1, 1);
    private readonly Lock _observerRuntimeSync = new();
    private readonly Dictionary<string, ObserverRuntime> _observerRuntimes = new(StringComparer.Ordinal);
    private readonly long _startedTimestamp = Stopwatch.GetTimestamp();
    private Task? _updateTask;
    private Task? _healthTask;
    private Task? _observerRuntimeTask;
    private BridgeLogViewerForm? _logViewer;
    private int _startupReadyWritten;
    private int _latestPhase = (int)BridgeApplicationPhase.Starting;
    private int _latestTerminalCount;
    private int _canManageObserverSources;
    private string? _lastLoggedStatusFingerprint;
    private bool _shuttingDown;
    private BridgeApplicationStatus? _primaryStatus;

    public BridgeApplicationContext(
        BridgeSingleInstanceGuard singleInstance,
        string? startupReadyFile = null,
        string profileId = BridgeRuntimeProfile.DefaultId,
        bool backgroundMode = false)
    {
        _singleInstance = singleInstance ?? throw new ArgumentNullException(nameof(singleInstance));
        _startupReadyFile = startupReadyFile;
        _profileId = BridgeRuntimeProfile.Validate(profileId);
        _backgroundMode = backgroundMode;
        if (_backgroundMode && BridgeRuntimeProfile.IsDefault(_profileId))
        {
            throw new ArgumentException("bridge_background_profile_required", nameof(profileId));
        }
        var rootPaths = BridgeRuntimePathResolver.Resolve(AppContext.BaseDirectory);
        _rootDataDirectory = rootPaths.DataDirectory;
        var paths = BridgeRuntimePathResolver.Resolve(
            AppContext.BaseDirectory,
            profileId:_profileId);
        _logger = new(Path.Combine(paths.DataDirectory, "logs"));
        _preferences = new(Path.Combine(paths.DataDirectory, "preferences.json"));
        string? selectedPlatform = null;
        string? selectedMt5TerminalId = null;
        string? selectedMt5TerminalPath = null;
        string? selectedMt4TerminalId = null;
        IReadOnlyList<BridgeObserverProfileView> observerProfileViews = [];
        try
        {
            var preferences = _preferences.LoadAsync().GetAwaiter().GetResult();
            selectedPlatform = preferences.Platform;
            selectedMt5TerminalId = preferences.Mt5TerminalInstanceId;
            selectedMt5TerminalPath = preferences.Mt5TerminalPath;
            selectedMt4TerminalId = preferences.Mt4TerminalInstanceId;
        }
        catch (Exception error)
        {
            _logger.Error("preferences_load_failed", error);
        }
        if (BridgeRuntimeProfile.IsDefault(_profileId))
        {
            EnsureAutoStart();
            _updateCoordinator = CreateUpdateCoordinator(paths.ServerBaseUri);
            SignalObserverProfilesShutdown();
            try
            {
                observerProfileViews = LoadObserverProfileViewsAsync(
                    _rootDataDirectory,
                    CancellationToken.None).GetAwaiter().GetResult();
                _logger.Info(
                    "observer_profile_catalog_loaded",
                    $"count={observerProfileViews.Count}; mode=isolated_sessions");
            }
            catch (Exception error)
            {
                _logger.Error("observer_terminal_catalog_load_failed", error);
            }
        }
        _controller = new(
            paths,
            selectedPlatform,
            selectedMt5TerminalId,
            selectedMt5TerminalPath,
            selectedMt4TerminalId);
        _form = new(_profileId);
        _form.PairRequested += HandlePairRequested;
        _form.ObserverSourcesRequested += HandleObserverSourcesRequested;
        _form.ObserverActionRequested += HandleObserverActionRequested;
        _form.InstallMt4ExpertRequested += HandleInstallMt4ExpertRequested;
        _form.RedetectRequested += (_, _) => _controller.RequestRedetect();
        _form.OpenLogsRequested += HandleOpenLogsRequested;
        _form.LogoutRequested += HandleLogoutRequested;
        _form.PlatformChanged += HandlePlatformChanged;
        _form.TerminalChanged += HandleTerminalChanged;
        _form.ExitRequested += HandleExitRequested;
        _controller.StatusChanged += HandlePrimaryStatusChanged;
        _controller.ConnectionFailureObserved += error =>
            LogConnectionFailure("bridge_connection_failure", "primary", error);
        _controller.TerminalFailureObserved += failure =>
            LogTerminalFailure("primary", failure);
        _singleInstance.ActivationRequested += HandleActivationRequested;
        _singleInstance.ShutdownRequested += HandleShutdownRequested;
        _singleInstance.StartActivationListener();

        if (BridgeRuntimeProfile.IsDefault(_profileId))
        {
            _form.ApplyObserverProfiles(observerProfileViews);
        }

        var menu = new ContextMenuStrip();
        menu.Items.Add($"打开{BridgeBrand.ProductName}", null, (_, _) => _form.ShowFromTray());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出桥接", null, HandleExitRequested);
        _notifyIcon = new()
        {
            Icon = BridgeBrandIcon.ApplicationIcon,
            Text = BridgeBrand.ProductName,
            ContextMenuStrip = menu,
            Visible = !_backgroundMode,
        };
        _notifyIcon.DoubleClick += (_, _) => _form.ShowFromTray();
        if (_backgroundMode)
        {
            _ = _form.Handle;
        }
        else
        {
            _form.Show();
        }
        _logger.Info("bridge_started");
        _ = ObserveControllerAsync(RunControllerAsync(_stop.Token));
        if (BridgeRuntimeProfile.IsDefault(_profileId))
        {
            _observerRuntimeTask = InitializeObserverRuntimesAsync(_stop.Token);
        }
        _healthTask = ObserveHealthAsync(_stop.Token);
        if (_updateCoordinator is not null)
        {
            _updateTask = ObserveUpdatesAsync(_updateCoordinator, _stop.Token);
        }
    }

    private BridgeUpdateCoordinator? CreateUpdateCoordinator(Uri serverBaseUri)
    {
        try
        {
            return BridgeUpdateCoordinator.CreateIfInstalled(AppContext.BaseDirectory, serverBaseUri);
        }
        catch (Exception error)
        {
            _logger.Error("update_initialization_failed", error);
            return null;
        }
    }

    private async Task RunControllerAsync(CancellationToken cancellationToken)
    {
        if (BridgeRuntimeProfile.IsDefault(_profileId))
        {
            var profiles = BridgeRuntimeProfile.ListObserverProfiles(_rootDataDirectory);
            var releases = await Task.WhenAll(profiles.Select(profileId =>
                BridgeSingleInstanceGuard.WaitForReleaseAsync(
                    BridgeRuntimeProfile.InstanceId(profileId),
                    TimeSpan.FromSeconds(10),
                    cancellationToken:cancellationToken)));
            if (releases.Any(released => !released))
            {
                _logger.Info("legacy_observer_profile_stop_timeout");
            }
        }
        await _controller.RunAsync(cancellationToken);
    }

    private void EnsureAutoStart()
    {
        try
        {
            var registration = new BridgeAutoStartRegistration(new WindowsAutoStartValueStore());
            if (registration.EnsureForInstalledApplication(AppContext.BaseDirectory))
            {
                _logger.Info("autostart_registered");
            }
        }
        catch (Exception error)
        {
            _logger.Error("autostart_registration_failed", error);
        }
    }

    private void HandleActivationRequested()
    {
        if (_backgroundMode)
        {
            return;
        }
        TryBeginInvoke(() =>
        {
            if (!_shuttingDown)
            {
                _form.ShowFromTray();
            }
        });
    }

    private void HandleShutdownRequested()
    {
        if (_shuttingDown)
        {
            return;
        }
        TryBeginInvoke(() => _ = ShutdownAsync(stopObserverProfiles:false));
    }

    private void HandlePrimaryStatusChanged(BridgeApplicationStatus status)
    {
        if (status.ServerConnected)
        {
            _failureLogThrottle.Reset("primary");
        }
        lock (_observerRuntimeSync)
        {
            _primaryStatus = status;
        }
        Volatile.Write(
            ref _canManageObserverSources,
            status.CanManageObserverSources ? 1 : 0);
        PublishCombinedStatus();
    }

    private void HandleObserverStatus(
        string profileId,
        BridgeApplicationController controller,
        BridgeApplicationStatus status)
    {
        if (status.ServerConnected)
        {
            _failureLogThrottle.Reset($"observer:{profileId}");
        }
        lock (_observerRuntimeSync)
        {
            if (!_observerRuntimes.TryGetValue(profileId, out var runtime)
                || !ReferenceEquals(runtime.Controller, controller))
            {
                return;
            }
            runtime.Status = status;
        }
        PublishCombinedStatus();
        _ = RefreshObserverProfileViewsAsync(_stop.Token);
    }

    private void PublishCombinedStatus()
    {
        BridgeApplicationStatus? status;
        lock (_observerRuntimeSync)
        {
            if (_primaryStatus is null)
            {
                return;
            }
            var observerTerminals = _observerRuntimes
                .OrderBy(item => item.Key, StringComparer.Ordinal)
                .SelectMany(item => (item.Value.Status?.Terminals ?? [])
                    .Select(terminal => terminal with { ObserverProfileId = item.Key }))
                .ToArray();
            status = _primaryStatus with
            {
                Terminals = [.. _primaryStatus.Terminals, .. observerTerminals],
            };
        }
        Volatile.Write(ref _latestPhase, (int)status.Phase);
        Volatile.Write(ref _latestTerminalCount, status.Terminals.Count);
        var statusFingerprint = BridgeStatusFingerprint.ForLog(status);
        if (Interlocked.Exchange(
            ref _lastLoggedStatusFingerprint,
            statusFingerprint) != statusFingerprint)
        {
            var terminalStates = string.Join(",", status.Terminals.Select(terminal =>
                $"{terminal.ObserverProfileId ?? "main"}:{terminal.RuntimeState}"
                + (terminal.ErrorCode is null ? string.Empty : $"[{terminal.ErrorCode}]")));
            _logger.Info(
                "bridge_status_changed",
                $"phase={status.Phase}; terminals={status.Terminals.Count}; states={terminalStates}; detail={status.DetailCode ?? "none"}");
        }
        if (status.Phase == BridgeApplicationPhase.Online
            && _startupReadyFile is not null
            && Interlocked.Exchange(ref _startupReadyWritten, 1) == 0)
        {
            _ = WriteStartupReadyAsync(_startupReadyFile);
        }
        TryBeginInvoke(() =>
        {
            if (_shuttingDown)
            {
                return;
            }
            _form.ApplyStatus(status);
            _notifyIcon.Text = status.Phase == BridgeApplicationPhase.Online
                ? $"{BridgeBrand.ProductName} · 运行中"
                : BridgeBrand.ProductName;
        });
    }

    private void HandleObserverSourcesRequested(object? sender, EventArgs eventArgs)
    {
        if (Volatile.Read(ref _canManageObserverSources) != 1)
        {
            _logger.Info("observer_profiles_access_rejected");
            return;
        }
        CreateObserverProfile();
    }

    private async void HandleObserverActionRequested(
        object? sender,
        BridgeObserverActionEventArgs eventArgs)
    {
        if (Volatile.Read(ref _canManageObserverSources) != 1)
        {
            _logger.Info("observer_profiles_access_rejected");
            return;
        }
        if (eventArgs.Action is BridgeObserverAction.Configure or BridgeObserverAction.Bind)
        {
            ConfigureObserverProfile(eventArgs.ProfileId);
            return;
        }
        _form.SetObserverActionBusy(eventArgs.ProfileId, true);
        try
        {
            var profileDirectory = BridgeRuntimeProfile.ResolveDataDirectory(
                _rootDataDirectory,
                eventArgs.ProfileId);
            var preferences = new BridgeUserPreferencesStore(
                Path.Combine(profileDirectory, "preferences.json"));
            if (eventArgs.Action == BridgeObserverAction.Pause)
            {
                await preferences.SaveObserverEnabledAsync(false, _stop.Token);
                _logger.Info(
                    "observer_profile_paused",
                    $"profile={eventArgs.ProfileId}");
            }
            else
            {
                await preferences.SaveObserverEnabledAsync(true, _stop.Token);
                _logger.Info(
                    eventArgs.Action == BridgeObserverAction.Start
                        ? "observer_profile_started"
                        : "observer_profile_retried",
                    $"profile={eventArgs.ProfileId}");
            }
            await ReloadObserverProfileRuntimeAsync(eventArgs.ProfileId, _stop.Token);
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("observer_profile_action_failed", error);
            MessageBox.Show(
                _form,
                "观摩源操作未完成，请稍后重试。",
                "观摩源",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        finally
        {
            if (!_form.IsDisposed)
            {
                _form.SetObserverActionBusy(eventArgs.ProfileId, false);
            }
        }
    }

    private async void CreateObserverProfile()
    {
        var sources = await LoadObserverSourcesForDialogAsync();
        if (sources is null)
        {
            return;
        }
        using var dialog = new BridgeObserverProfileDialog(sources);
        if (dialog.ShowDialog(_form) != DialogResult.OK)
        {
            return;
        }
        try
        {
            if (BridgeRuntimeProfile.ListObserverProfiles(_rootDataDirectory)
                .Contains(dialog.ProfileId, StringComparer.Ordinal))
            {
                MessageBox.Show(
                    _form,
                    "该观摩源名称已经存在，请更换名称，或从观摩源菜单直接打开已有档案。",
                    "观摩源已存在",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return;
            }
            await EnsureObserverTerminalAvailableAsync(
                dialog.ProfileId,
                dialog.TerminalInstanceId,
                _stop.Token);
            var profileDirectory = BridgeRuntimeProfile.CreateObserverProfile(
                _rootDataDirectory,
                dialog.ProfileId);
            await SaveObserverProfilePreferencesAsync(profileDirectory, dialog);
            _logger.Info("observer_profile_created", $"profile={dialog.ProfileId}");
            await ReloadObserverProfileRuntimeAsync(dialog.ProfileId, _stop.Token);
            ShowMt4ObserverInstructionsIfNeeded(dialog.Platform);
        }
        catch (InvalidOperationException error) when (
            error.Message == "observer_terminal_already_assigned")
        {
            MessageBox.Show(
                _form,
                "该终端已被主账户或另一个观摩源使用，请选择独立终端。",
                "终端已被占用",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        catch (Exception error)
        {
            _logger.Error("observer_profile_create_failed", error);
            MessageBox.Show(
                _form,
                "观摩源无法创建或启动。名称请使用 1-40 位英文字母、数字、横线或下划线。",
                "新增观摩源",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private async void ConfigureObserverProfile(string profileId)
    {
        try
        {
            var profileDirectory = BridgeRuntimeProfile.CreateObserverProfile(
                _rootDataDirectory,
                profileId);
            var preferences = new BridgeUserPreferencesStore(
                Path.Combine(profileDirectory, "preferences.json"));
            var current = await preferences.LoadAsync(_stop.Token);
            var sources = await LoadObserverSourcesForDialogAsync();
            if (sources is null)
            {
                return;
            }
            using var dialog = new BridgeObserverProfileDialog(
                sources,
                profileId,
                current.Platform,
                current.Mt5TerminalPath,
                current.Mt4TerminalPath,
                current.ObserverBridgeUserId);
            if (dialog.ShowDialog(_form) != DialogResult.OK)
            {
                return;
            }
            await StopObserverRuntimeAsync(profileId);
            await SaveObserverProfilePreferencesAsync(profileDirectory, dialog);
            _logger.Info(
                "observer_profile_terminal_configured",
                $"profile={profileId}; platform={dialog.Platform}; terminal_id={dialog.TerminalInstanceId}");
            await ReloadObserverProfileRuntimeAsync(profileId, _stop.Token);
            ShowMt4ObserverInstructionsIfNeeded(dialog.Platform);
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (InvalidOperationException error) when (
            error.Message == "observer_terminal_already_assigned")
        {
            MessageBox.Show(
                _form,
                "该终端已被主账户或另一个观摩源使用，请选择独立终端。",
                "终端已被占用",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        catch (Exception error)
        {
            _logger.Error("observer_profile_start_failed", error);
            MessageBox.Show(
                _form,
                "观摩源暂时无法启动，请稍后重试。",
                "观摩源",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private static async Task<IReadOnlyList<BridgeObserverProfileView>>
        LoadObserverProfileViewsAsync(
            string rootDataDirectory,
            CancellationToken cancellationToken,
            IReadOnlyDictionary<string, BridgeApplicationStatus>? runtimeStatuses = null)
    {
        var items = new List<BridgeObserverProfileView>();
        foreach (var profileId in BridgeRuntimeProfile.ListObserverProfiles(rootDataDirectory))
        {
            var profileDirectory = BridgeRuntimeProfile.ResolveDataDirectory(
                rootDataDirectory,
                profileId);
            var preferences = new BridgeUserPreferencesStore(
                Path.Combine(profileDirectory, "preferences.json"));
            var current = await preferences.LoadAsync(cancellationToken);
            var configured = current.Platform switch
            {
                BridgePlatform.Mt5 => !string.IsNullOrWhiteSpace(current.Mt5TerminalPath)
                    && File.Exists(current.Mt5TerminalPath),
                BridgePlatform.Mt4 => !string.IsNullOrWhiteSpace(current.Mt4TerminalPath)
                    && !string.IsNullOrWhiteSpace(current.Mt4TerminalInstanceId)
                    && Directory.Exists(Path.Combine(current.Mt4TerminalPath, "MQL4")),
                _ => false,
            };
            BridgeApplicationStatus? runtimeStatus = null;
            runtimeStatuses?.TryGetValue(profileId, out runtimeStatus);
            items.Add(new(
                profileId,
                current.Platform,
                configured,
                current.ObserverEnabled,
                current.Platform == BridgePlatform.Mt4
                    ? current.Mt4TerminalInstanceId
                    : current.Mt5TerminalInstanceId,
                current.ObserverBridgeUserId,
                current.ObserverAccountLabel,
                current.ObserverTradingAccountLabel,
                runtimeStatus?.Phase,
                runtimeStatus?.DetailCode));
        }
        return items;
    }

    private async Task InitializeObserverRuntimesAsync(CancellationToken cancellationToken)
    {
        try
        {
            await BridgeObserverRuntimeInitializer.InitializeIndependentlyAsync(
                BridgeRuntimeProfile.ListObserverProfiles(_rootDataDirectory),
                async (profileId, token) =>
                {
                    await BridgeSingleInstanceGuard.WaitForReleaseAsync(
                        BridgeRuntimeProfile.InstanceId(profileId),
                        TimeSpan.FromSeconds(10),
                        cancellationToken:token);
                    await ReloadObserverProfileRuntimeAsync(profileId, token);
                },
                (profileId, error) => _logger.Error(
                    "observer_runtime_initialization_failed",
                    new InvalidOperationException($"profile_id={profileId}", error)),
                cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private async Task ReloadObserverProfileRuntimeAsync(
        string profileId,
        CancellationToken cancellationToken)
    {
        await _observerRuntimeReload.WaitAsync(cancellationToken);
        try
        {
            await StopObserverRuntimeCoreAsync(profileId);
            var profileDirectory = BridgeRuntimeProfile.ResolveDataDirectory(
                _rootDataDirectory,
                profileId);
            var preferences = await new BridgeUserPreferencesStore(
                Path.Combine(profileDirectory, "preferences.json")).LoadAsync(cancellationToken);
            if (!preferences.ObserverEnabled
                || preferences.ObserverBridgeUserId is null
                || preferences.Platform is null)
            {
                await RefreshObserverProfileViewsAsync(cancellationToken);
                return;
            }
            var configured = preferences.Platform switch
            {
                BridgePlatform.Mt5 => !String.IsNullOrWhiteSpace(preferences.Mt5TerminalPath)
                    && File.Exists(preferences.Mt5TerminalPath),
                BridgePlatform.Mt4 => !String.IsNullOrWhiteSpace(preferences.Mt4TerminalPath)
                    && !String.IsNullOrWhiteSpace(preferences.Mt4TerminalInstanceId)
                    && Directory.Exists(Path.Combine(preferences.Mt4TerminalPath, "MQL4")),
                _ => false,
            };
            if (!configured)
            {
                await RefreshObserverProfileViewsAsync(cancellationToken);
                return;
            }
            var paths = BridgeRuntimePathResolver.Resolve(
                AppContext.BaseDirectory,
                profileId:profileId);
            var terminalInstanceId = preferences.Platform == BridgePlatform.Mt4
                ? preferences.Mt4TerminalInstanceId
                : preferences.Mt5TerminalInstanceId;
            if (String.IsNullOrWhiteSpace(terminalInstanceId))
            {
                await RefreshObserverProfileViewsAsync(cancellationToken);
                return;
            }
            if (!String.Equals(
                preferences.ObserverClaimedTerminalInstanceId,
                terminalInstanceId,
                StringComparison.Ordinal))
            {
                await RotateObserverCredentialAsync(
                    profileId,
                    preferences.ObserverBridgeUserId.Value,
                    terminalInstanceId,
                    paths,
                    cancellationToken);
                var preferencesStore = new BridgeUserPreferencesStore(
                    Path.Combine(profileDirectory, "preferences.json"));
                await preferencesStore.SaveObserverClaimedTerminalAsync(
                    terminalInstanceId,
                    cancellationToken);
                preferences = await preferencesStore.LoadAsync(cancellationToken);
                _logger.Info(
                    "observer_terminal_claimed",
                    $"profile={profileId}; terminal={terminalInstanceId}; bridge_user_id={preferences.ObserverBridgeUserId}");
            }
            var controller = new BridgeApplicationController(
                paths,
                preferences.Platform,
                preferences.Mt5TerminalInstanceId,
                preferences.Mt5TerminalPath,
                preferences.Mt4TerminalInstanceId);
            var runtime = new ObserverRuntime(controller);
            controller.StatusChanged += status => HandleObserverStatus(profileId, controller, status);
            controller.ConnectionFailureObserved += error => LogConnectionFailure(
                "observer_connection_failure",
                $"observer:{profileId}",
                error);
            controller.TerminalFailureObserved += failure =>
                LogTerminalFailure($"observer:{profileId}", failure);
            lock (_observerRuntimeSync)
            {
                _observerRuntimes[profileId] = runtime;
            }
            runtime.RunTask = ObserveObserverControllerAsync(profileId, controller, cancellationToken);
            _logger.Info(
                "observer_runtime_started",
                $"profile={profileId}; bridge_user_id={preferences.ObserverBridgeUserId}; mode=isolated_session");
            await RefreshObserverProfileViewsAsync(cancellationToken);
        }
        finally
        {
            _observerRuntimeReload.Release();
        }
    }

    private async Task StopObserverRuntimeAsync(string profileId)
    {
        await _observerRuntimeReload.WaitAsync(_stop.Token);
        try
        {
            await StopObserverRuntimeCoreAsync(profileId);
        }
        finally
        {
            _observerRuntimeReload.Release();
        }
    }

    private async Task StopObserverRuntimeCoreAsync(string profileId)
    {
        ObserverRuntime? runtime;
        lock (_observerRuntimeSync)
        {
            _observerRuntimes.Remove(profileId, out runtime);
        }
        if (runtime is null)
        {
            return;
        }
        await runtime.Controller.DisposeAsync();
        if (runtime.RunTask is not null)
        {
            await IgnoreCancellationAsync(runtime.RunTask);
        }
        PublishCombinedStatus();
    }

    private async Task ObserveObserverControllerAsync(
        string profileId,
        BridgeApplicationController controller,
        CancellationToken cancellationToken)
    {
        try
        {
            await controller.RunAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error(
                "observer_runtime_failed",
                new InvalidOperationException($"profile={profileId}; {error.Message}", error));
        }
    }

    private void LogConnectionFailure(string eventName, string scope, Exception error)
    {
        var decision = _failureLogThrottle.Observe(scope, error);
        if (!decision.ShouldLog)
        {
            return;
        }
        if (decision.SuppressedCount > 0)
        {
            _logger.Warning(
                $"{eventName}_repeated",
                $"scope={scope}; code={decision.ErrorCode}; suppressed={decision.SuppressedCount}");
            return;
        }
        _logger.Error(eventName, error);
    }

    private void LogTerminalFailure(string scope, TerminalRuntimeFailure failure)
    {
        var failureScope = $"{scope}:terminal:{failure.TerminalInstanceId}";
        var decision = _failureLogThrottle.Observe(failureScope, failure.Error);
        if (!decision.ShouldLog)
        {
            return;
        }
        if (decision.SuppressedCount > 0)
        {
            _logger.Warning(
                "terminal_worker_failure_repeated",
                $"scope={failureScope}; code={failure.ErrorCode}; failures={failure.ConsecutiveFailures}; suppressed={decision.SuppressedCount}");
            return;
        }
        _logger.Error(
            "terminal_worker_failure",
            new InvalidOperationException(
                $"scope={failureScope}; code={failure.ErrorCode}; failures={failure.ConsecutiveFailures}",
                failure.Error));
    }

    private async Task RefreshObserverProfileViewsAsync(CancellationToken cancellationToken)
    {
        Dictionary<string, BridgeApplicationStatus> statuses;
        lock (_observerRuntimeSync)
        {
            statuses = _observerRuntimes
                .Where(item => item.Value.Status is not null)
                .ToDictionary(
                    item => item.Key,
                    item => item.Value.Status!,
                    StringComparer.Ordinal);
        }
        var profiles = await LoadObserverProfileViewsAsync(
            _rootDataDirectory,
            cancellationToken,
            statuses);
        TryBeginInvoke(() =>
        {
            if (!_shuttingDown)
            {
                _form.ApplyObserverProfiles(profiles);
            }
        });
    }

    private async Task<IReadOnlyList<BridgeObserverSource>?> LoadObserverSourcesForDialogAsync()
    {
        try
        {
            var sources = await _controller.ListManagedObserverSourcesAsync(_stop.Token);
            if (sources.Count > 0)
            {
                return sources;
            }
            MessageBox.Show(
                _form,
                "后台还没有可绑定的观摩账户。请先在 AI 交易实验室管理端创建观摩源账户。",
                "暂无观摩账户",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (Exception error)
        {
            _logger.Error("observer_sources_load_failed", error);
            MessageBox.Show(
                _form,
                "暂时无法读取观摩账户，请检查服务器连接后重试。",
                "观摩账户不可用",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        return null;
    }

    private async Task SaveObserverProfilePreferencesAsync(
        string profileDirectory,
        BridgeObserverProfileDialog dialog)
    {
        await EnsureObserverTerminalAvailableAsync(
            dialog.ProfileId,
            dialog.TerminalInstanceId,
            _stop.Token);
        var preferences = new BridgeUserPreferencesStore(
            Path.Combine(profileDirectory, "preferences.json"));
        var profilePaths = BridgeRuntimePathResolver.Resolve(
            AppContext.BaseDirectory,
            profileId:dialog.ProfileId);
        await RotateObserverCredentialAsync(
            dialog.ProfileId,
            dialog.ObserverSource.BridgeUserId,
            dialog.TerminalInstanceId,
            profilePaths,
            _stop.Token);
        await preferences.SaveObserverBindingAsync(dialog.ObserverSource, _stop.Token);
        await preferences.SavePlatformAsync(dialog.Platform, _stop.Token);
        if (dialog.Platform == BridgePlatform.Mt4)
        {
            var installation = dialog.Mt4Installation
                ?? throw new InvalidOperationException("observer_mt4_directory_not_selected");
            await preferences.SaveMt4TerminalAsync(
                installation.TerminalInstanceId,
                _stop.Token);
            await preferences.SaveMt4TerminalPathAsync(
                installation.TerminalDataPath,
                _stop.Token);
            await preferences.SaveObserverClaimedTerminalAsync(
                dialog.TerminalInstanceId,
                _stop.Token);
            return;
        }
        var terminalPath = dialog.Mt5ExecutablePath
            ?? throw new InvalidOperationException("observer_mt5_directory_not_selected");
        await preferences.SaveMt5TerminalAsync(dialog.TerminalInstanceId, _stop.Token);
        await preferences.SaveMt5TerminalPathAsync(terminalPath, _stop.Token);
        await preferences.SaveObserverClaimedTerminalAsync(
            dialog.TerminalInstanceId,
            _stop.Token);
    }

    private async Task RotateObserverCredentialAsync(
        string profileId,
        long bridgeUserId,
        string terminalInstanceId,
        BridgeRuntimePaths profilePaths,
        CancellationToken cancellationToken)
    {
        var credentialStore = new FileBridgeCredentialStore(
            profilePaths.CredentialPath,
            new WindowsDpapiProtector());
        var existingCredential = await credentialStore.LoadAsync(cancellationToken);
        var credential = await _controller.CreateManagedObserverCredentialAsync(
            bridgeUserId,
            terminalInstanceId,
            cancellationToken);
        if (existingCredential is not null)
        {
            try
            {
                using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
                var previousSession = new BridgeSessionClient(
                    profilePaths.ServerBaseUri,
                    httpClient,
                    credentialStore);
                await previousSession.LogoutAsync(cancellationToken);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                _logger.Warning(
                    "observer_previous_session_revoke_failed",
                    $"profile={profileId}; {error.Message}");
            }
        }
        await credentialStore.SaveAsync(credential, cancellationToken);
    }

    private async Task EnsureObserverTerminalAvailableAsync(
        string profileId,
        string terminalInstanceId,
        CancellationToken cancellationToken)
    {
        var main = await _preferences.LoadAsync(cancellationToken);
        var mainTerminalId = main.Platform == BridgePlatform.Mt4
            ? main.Mt4TerminalInstanceId
            : main.Mt5TerminalInstanceId;
        if (mainTerminalId == terminalInstanceId)
        {
            throw new InvalidOperationException("observer_terminal_already_assigned");
        }
        foreach (var otherProfileId in BridgeRuntimeProfile.ListObserverProfiles(
            _rootDataDirectory).Where(value => value != profileId))
        {
            var directory = BridgeRuntimeProfile.ResolveDataDirectory(
                _rootDataDirectory,
                otherProfileId);
            var preferences = await new BridgeUserPreferencesStore(
                Path.Combine(directory, "preferences.json")).LoadAsync(cancellationToken);
            var otherTerminalId = preferences.Platform == BridgePlatform.Mt4
                ? preferences.Mt4TerminalInstanceId
                : preferences.Mt5TerminalInstanceId;
            if (otherTerminalId == terminalInstanceId)
            {
                throw new InvalidOperationException("observer_terminal_already_assigned");
            }
        }
    }

    private void ShowMt4ObserverInstructionsIfNeeded(string platform)
    {
        if (platform != BridgePlatform.Mt4)
        {
            return;
        }
        MessageBox.Show(
            _form,
            "EA 将自动安装到该 MT4。\n\n" + BridgeUiText.Mt4ExpertSetupInstructions,
            "完成 MT4 观摩源连接",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
    }

    private async Task WriteStartupReadyAsync(string path)
    {
        try
        {
            var version = typeof(BridgeApplicationContext).Assembly.GetName().Version?.ToString(3)
                ?? "3.0.0";
            await BridgeStartupSignal.WriteAsync(path, version, cancellationToken:_stop.Token);
            _logger.Info("startup_ready_confirmed", $"version={version}");
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("startup_ready_signal_failed", error);
        }
    }

    private async void HandlePairRequested(object? sender, EventArgs eventArgs)
    {
        _logger.Info("pairing_started");
        _form.SetPairingBusy(true);
        try
        {
            await _controller.PairAsync(prompt =>
            {
                _ = Process.Start(new ProcessStartInfo(prompt.VerificationUri.AbsoluteUri)
                {
                    UseShellExecute = true,
                }) ?? throw new InvalidOperationException("pairing_browser_start_failed");
                _form.SetPairingBrowserOpened();
                _logger.Info("pairing_browser_opened");
                return Task.CompletedTask;
            }, _stop.Token);
            _logger.Info("pairing_completed");
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("pairing_failed", error);
            MessageBox.Show(
                _form,
                BridgeUiText.DescribeError(error),
                "账号连接未完成",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        finally
        {
            if (!_form.IsDisposed)
            {
                _form.SetPairingBusy(false);
            }
        }
    }

    private async void HandleInstallMt4ExpertRequested(object? sender, EventArgs eventArgs)
    {
        _form.SetMt4ExpertBusy(true);
        try
        {
            var deployment = await _controller.InstallOrRepairMt4ExpertAsync(_stop.Token);
            _logger.Info(
                "mt4_ea_manual_deployment_completed",
                $"terminal_id={deployment.Installation.TerminalInstanceId}; status={deployment.Status}");
            var summary = deployment.Status == Mt4ExpertDeploymentStatus.Installed
                ? "EA 已安装到当前 MT4。"
                : "EA 已经是最新版本。";
            MessageBox.Show(
                _form,
                $"{summary}\n\n{BridgeUiText.Mt4ExpertSetupInstructions}",
                "安装 / 修复 MT4 EA",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("mt4_ea_manual_deployment_failed", error);
            var description = error is FileNotFoundException
                ? BridgeUiText.DescribeError(error)
                : BridgeUiText.DescribeCode(
                    error.Message,
                    "MT4 EA 暂时无法安装，请稍后重试。");
            MessageBox.Show(
                _form,
                description,
                "安装 / 修复 MT4 EA",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        finally
        {
            if (!_form.IsDisposed && !_form.Disposing)
            {
                _form.SetMt4ExpertBusy(false);
            }
        }
    }

    private void HandleOpenLogsRequested(object? sender, EventArgs eventArgs)
    {
        try
        {
            Directory.CreateDirectory(_logger.LogDirectory);
            if (_logViewer is null || _logViewer.IsDisposed)
            {
                _logViewer = new(_logger.LogDirectory);
                _logViewer.Show(_form);
            }
            else if (!_logViewer.Visible)
            {
                _logViewer.Show(_form);
            }
            else
            {
                _ = _logViewer.ReloadAsync();
            }
            _logViewer.BringToFront();
        }
        catch (Exception error)
        {
            _logger.Error("open_logs_failed", error);
            MessageBox.Show(
                _form,
                "暂时无法显示日志，请稍后重试。",
                "查看日志",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private async void HandlePlatformChanged(object? sender, BridgePlatformChangedEventArgs eventArgs)
    {
        _form.BeginPlatformSwitch(eventArgs.Platform);
        try
        {
            await _preferences.SavePlatformAsync(eventArgs.Platform, _stop.Token);
            _controller.SelectPlatform(eventArgs.Platform);
            _logger.Info("bridge_platform_selected", $"platform={eventArgs.Platform}");
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
            if (!_form.IsDisposed)
            {
                _form.CancelPlatformSwitch();
            }
        }
        catch (Exception error)
        {
            _logger.Error("preferences_save_failed", error);
            _form.CancelPlatformSwitch();
            MessageBox.Show(
                _form,
                "交易平台选择未能保存，请稍后重试。",
                "选择交易平台",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private async void HandleTerminalChanged(object? sender, BridgeTerminalChangedEventArgs eventArgs)
    {
        try
        {
            var platform = _controller.SelectedPlatform;
            if (platform == BridgePlatform.Mt4)
            {
                await _preferences.SaveMt4TerminalAsync(
                    eventArgs.TerminalInstanceId,
                    _stop.Token);
            }
            else
            {
                await _preferences.SaveMt5TerminalAsync(
                    eventArgs.TerminalInstanceId,
                    _stop.Token);
            }
            _controller.SelectTerminal(eventArgs.TerminalInstanceId);
            _logger.Info(
                "bridge_terminal_selected",
                $"terminal_id={eventArgs.TerminalInstanceId}");
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("terminal_preference_save_failed", error);
            var platformName = BridgePlatform.DisplayName(
                _controller.SelectedPlatform ?? BridgePlatform.Mt5);
            MessageBox.Show(
                _form,
                $"{platformName} 终端选择未能保存，请重新选择。",
                $"选择 {platformName} 终端",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private async void HandleLogoutRequested(object? sender, EventArgs eventArgs)
    {
        var answer = MessageBox.Show(
            _form,
            "确定退出当前 AURUM 账号？\n\n退出后桥接会停止服务器连接；MT 中已有订单不会被撤销或平仓。",
            "退出账号",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes)
        {
            return;
        }
        try
        {
            await LogoutObserverProfilesAsync(_stop.Token);
            var revoked = await _controller.LogoutAsync(_stop.Token);
            SignalObserverProfilesShutdown();
            _logger.Info("bridge_account_logged_out", $"server_revoked={revoked}");
            MessageBox.Show(
                _form,
                revoked
                    ? "已退出账号。下次连接需要重新在浏览器中授权。"
                    : "本机已退出账号。服务器暂时无法确认撤销，但本机凭证已经清除。",
                "退出账号",
                MessageBoxButtons.OK,
                revoked ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("bridge_logout_failed", error);
            MessageBox.Show(
                _form,
                "暂时无法退出账号，请稍后重试。",
                "退出账号",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private async void HandleExitRequested(object? sender, EventArgs eventArgs)
    {
        if (_shuttingDown)
        {
            return;
        }
        var answer = MessageBox.Show(
            _form,
            $"确定退出{BridgeBrand.ProductName}？\n\n退出只会停止数据与指令转发，不会撤单、平仓或关闭 MT。",
            "退出桥接",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes)
        {
            return;
        }
        await ShutdownAsync(stopObserverProfiles:BridgeRuntimeProfile.IsDefault(_profileId));
    }

    private async Task ShutdownAsync(bool stopObserverProfiles)
    {
        if (_shuttingDown)
        {
            return;
        }
        _shuttingDown = true;
        _logger.Info("bridge_stopping");
        if (stopObserverProfiles)
        {
            SignalObserverProfilesShutdown();
        }
        _stop.Cancel();
        if (_observerRuntimeTask is not null)
        {
            await IgnoreCancellationAsync(_observerRuntimeTask);
        }
        await StopAllObserverRuntimesAsync();
        if (_updateTask is not null)
        {
            await IgnoreCancellationAsync(_updateTask);
        }
        if (_healthTask is not null)
        {
            await IgnoreCancellationAsync(_healthTask);
        }
        await _controller.DisposeAsync();
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _logViewer?.Close();
        _logViewer?.Dispose();
        _form.AllowClose();
        _form.Close();
        _form.Dispose();
        _stop.Dispose();
        _singleInstance.ActivationRequested -= HandleActivationRequested;
        _singleInstance.ShutdownRequested -= HandleShutdownRequested;
        _updateCoordinator?.Dispose();
        _logger.Dispose();
        ExitThread();
    }

    private void SignalObserverProfilesShutdown()
    {
        if (!BridgeRuntimeProfile.IsDefault(_profileId))
        {
            return;
        }
        foreach (var profileId in BridgeRuntimeProfile.ListObserverProfiles(_rootDataDirectory))
        {
            try
            {
                BridgeSingleInstanceGuard.RequestShutdown(
                    BridgeRuntimeProfile.InstanceId(profileId));
            }
            catch (Exception error)
            {
                _logger.Error(
                    "observer_profile_shutdown_signal_failed",
                    new InvalidOperationException($"profile={profileId}", error));
            }
        }
    }

    private async Task ObserveUpdatesAsync(
        BridgeUpdateCoordinator coordinator,
        CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(1), cancellationToken);
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    var staged = await coordinator.CheckAndStageAsync(cancellationToken);
                    if (staged is not null)
                    {
                        TryBeginInvoke(() => _ = ApplyStagedUpdateAsync(coordinator, staged));
                        return;
                    }
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception error)
                {
                    _logger.Error("update_check_failed", error);
                }
                await Task.Delay(TimeSpan.FromHours(6), cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private async Task ObserveHealthAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    var sample = BridgeRuntimeHealthSampler.Capture(
                        _startedTimestamp,
                        (BridgeApplicationPhase)Volatile.Read(ref _latestPhase),
                        Volatile.Read(ref _latestTerminalCount));
                    _logger.Info("bridge_health_sample", BridgeRuntimeHealthSampler.Format(sample));
                }
                catch (Exception error)
                {
                    _logger.Error("bridge_health_sample_failed", error);
                }
                await Task.Delay(TimeSpan.FromMinutes(1), cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private async Task ApplyStagedUpdateAsync(
        BridgeUpdateCoordinator coordinator,
        StagedRelease staged)
    {
        if (_shuttingDown)
        {
            return;
        }
        var admissionPaused = false;
        var activationPrepared = false;
        try
        {
            await _controller.PauseForUpdateAsync(TimeSpan.FromSeconds(30), _stop.Token);
            admissionPaused = true;
            await coordinator.PrepareActivationAsync(staged, _stop.Token);
            activationPrepared = true;
            _shuttingDown = true;
            _logger.Info("update_activation_prepared", $"version={staged.Version}");
            SignalObserverProfilesShutdown();
            _stop.Cancel();
            if (_observerRuntimeTask is not null)
            {
                await IgnoreCancellationAsync(_observerRuntimeTask);
            }
            await StopAllObserverRuntimesAsync();
            if (_healthTask is not null)
            {
                await IgnoreCancellationAsync(_healthTask);
            }
            await _controller.DisposeAsync();
            _singleInstance.ActivationRequested -= HandleActivationRequested;
            _singleInstance.ShutdownRequested -= HandleShutdownRequested;
            _singleInstance.Dispose();
            coordinator.StartLauncher();
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            _logViewer?.Close();
            _logViewer?.Dispose();
            _form.AllowClose();
            _form.Close();
            _form.Dispose();
            coordinator.Dispose();
            _logger.Dispose();
            ExitThread();
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("update_activation_failed", error);
            if (admissionPaused && !activationPrepared)
            {
                _controller.ResumeAfterFailedUpdate();
            }
            if (activationPrepared && !_form.IsDisposed)
            {
                MessageBox.Show(
                    _form,
                    $"更新已准备完成，但自动重启失败。请手动重新打开{BridgeBrand.ProductName}。",
                    "更新等待重启",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                _form.AllowClose();
                _form.Close();
                ExitThread();
            }
        }
    }

    private static async Task IgnoreCancellationAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (OperationCanceledException)
        {
        }
    }

    private async Task StopAllObserverRuntimesAsync()
    {
        ObserverRuntime[] runtimes;
        lock (_observerRuntimeSync)
        {
            runtimes = _observerRuntimes.Values.ToArray();
            _observerRuntimes.Clear();
        }
        foreach (var runtime in runtimes)
        {
            await runtime.Controller.DisposeAsync();
            if (runtime.RunTask is not null)
            {
                await IgnoreCancellationAsync(runtime.RunTask);
            }
        }
    }

    private async Task LogoutObserverProfilesAsync(CancellationToken cancellationToken)
    {
        await StopAllObserverRuntimesAsync();
        foreach (var profileId in BridgeRuntimeProfile.ListObserverProfiles(_rootDataDirectory))
        {
            var paths = BridgeRuntimePathResolver.Resolve(
                AppContext.BaseDirectory,
                profileId:profileId);
            using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
            var credentials = new FileBridgeCredentialStore(
                paths.CredentialPath,
                new WindowsDpapiProtector());
            var session = new BridgeSessionClient(paths.ServerBaseUri, httpClient, credentials);
            await session.LogoutAsync(cancellationToken);
        }
        await RefreshObserverProfileViewsAsync(cancellationToken);
    }

    private async Task ObserveControllerAsync(Task runTask)
    {
        try
        {
            await runTask;
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _logger.Error("bridge_runtime_failed", error);
            if (_backgroundMode)
            {
                TryBeginInvoke(() => _ = ShutdownAsync(stopObserverProfiles:false));
                return;
            }
            TryBeginInvoke(() =>
            {
                if (_shuttingDown)
                {
                    return;
                }
                MessageBox.Show(
                    _form,
                    BridgeUiText.DescribeError(error),
                    "桥接运行异常",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            });
        }
    }

    private bool TryBeginInvoke(Action action)
    {
        ArgumentNullException.ThrowIfNull(action);
        if (_form.IsDisposed || _form.Disposing || !_form.IsHandleCreated)
        {
            return false;
        }
        try
        {
            _form.BeginInvoke(() =>
            {
                if (!_form.IsDisposed && !_form.Disposing)
                {
                    action();
                }
            });
            return true;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private sealed class ObserverRuntime(BridgeApplicationController controller)
    {
        public BridgeApplicationController Controller { get; } = controller;
        public BridgeApplicationStatus? Status { get; set; }
        public Task? RunTask { get; set; }
    }
}
