using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Storage;
using Microsoft.Data.Sqlite;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeStoreTests
{
    private string _directory = null!;
    private BridgeStore _store = null!;

    [TestInitialize]
    public async Task InitializeAsync()
    {
        _directory = Path.Combine(Path.GetTempPath(), "aurum-bridge-tests", Guid.NewGuid().ToString("N"));
        _store = new BridgeStore(Path.Combine(_directory, "bridge.db"));
        await _store.InitializeAsync();
    }

    [TestCleanup]
    public async Task CleanupAsync()
    {
        await _store.DisposeAsync();
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive: true);
        }
    }

    [TestMethod]
    public async Task InitializesWithWalJournalMode()
    {
        Assert.AreEqual("wal", (await _store.GetJournalModeAsync()).ToLowerInvariant());
    }

    [TestMethod]
    public async Task PersistsAccountScopedTerminalDataCacheWithFreshnessAndParameterIsolation()
    {
        var account = new AccountRef("Broker-Demo", "12345678");
        var parameters = Json("""{"symbol":"XAUUSD","timeframe":"M30","count":100}""");
        var payload = Json("""{"symbol":"XAUUSD","rates":[{"close":2300.5}]}""");
        await _store.PutTerminalDataCacheAsync(
            "mt4_terminal_cache_01", account, 3, "rates", parameters,
            1_800_000_000_000, 1_800_000_000_100, payload);

        var cached = await _store.GetTerminalDataCacheAsync(
            "mt4_terminal_cache_01", account, 3, "rates", parameters, 1_800_000_000_000);
        var stale = await _store.GetTerminalDataCacheAsync(
            "mt4_terminal_cache_01", account, 3, "rates", parameters, 1_800_000_000_100);
        var otherParams = await _store.GetTerminalDataCacheAsync(
            "mt4_terminal_cache_01", account, 3, "rates",
            Json("""{"symbol":"EURUSD","timeframe":"M30","count":100}"""),
            1_800_000_000_000);
        var otherAccount = await _store.GetTerminalDataCacheAsync(
            "mt4_terminal_cache_01", new("Broker-Demo", "87654321"), 3, "rates",
            parameters, 1_800_000_000_000);
        var otherEpoch = await _store.GetTerminalDataCacheAsync(
            "mt4_terminal_cache_01", account, 4, "rates", parameters, 1_800_000_000_000);

        Assert.IsNotNull(cached);
        Assert.AreEqual(1_800_000_000_000, cached.ObservedAtUtcMsc);
        Assert.AreEqual(2300.5,
            cached.Payload.GetProperty("rates")[0].GetProperty("close").GetDouble());
        Assert.IsNull(stale);
        Assert.IsNull(otherParams);
        Assert.IsNull(otherAccount);
        Assert.IsNull(otherEpoch);
    }

    [TestMethod]
    public async Task PersistsLatestStateAndOutboxInOneTransaction()
    {
        var message = Delta("positions", revision: 1, baseRevision: 0,
            upserts: [Json("""{"ticket":"1001","symbol":"XAUUSD"}""")]);

        var result = await _store.PersistDataDeltaAsync(message);
        var outbox = await _store.GetPendingOutboxAsync();

        Assert.AreEqual(PersistDeltaStatus.Applied, result.Status);
        Assert.HasCount(1, outbox);
        Assert.AreEqual(message.MessageId, outbox[0].MessageId);
        Assert.AreEqual("data_delta", outbox[0].MessageType);
        StringAssert.Contains(outbox[0].PayloadJson, "XAUUSD");
    }

    [TestMethod]
    public async Task PublishesCommittedAccountSnapshotsForLocalStatusProjection()
    {
        string? terminalId = null;
        JsonElement? account = null;
        _store.AccountSnapshotPersisted += (id, value) =>
        {
            terminalId = id;
            account = value;
        };
        var message = Delta("account", 1, 0,
            [Json("""{"trade_allowed":true,"trade_expert":false}""")]);

        var result = await _store.PersistDataDeltaAsync(message);

        Assert.AreEqual(PersistDeltaStatus.Applied, result.Status);
        Assert.AreEqual(message.TerminalInstanceId, terminalId);
        Assert.IsNotNull(account);
        Assert.IsTrue(account.Value.GetProperty("trade_allowed").GetBoolean());
        Assert.IsFalse(account.Value.GetProperty("trade_expert").GetBoolean());
    }

    [TestMethod]
    public async Task RejectsRevisionGapWithoutAddingOutboxWork()
    {
        await _store.PersistDataDeltaAsync(Delta("orders", 1, 0,
            [Json("""{"ticket":"2001"}""")]));

        var gap = await _store.PersistDataDeltaAsync(Delta("orders", 3, 2,
            [Json("""{"ticket":"2002"}""")]));

        Assert.AreEqual(PersistDeltaStatus.Gap, gap.Status);
        Assert.AreEqual(2L, gap.ExpectedRevision);
        Assert.HasCount(1, await _store.GetPendingOutboxAsync());
    }

    [TestMethod]
    public async Task AcceptsAnExactReplayButRejectsConflictingContentAtTheSameRevision()
    {
        var original = Delta("positions", 1, 0,
            [Json("""{"ticket":"1001","symbol":"XAUUSD"}""")]);
        await _store.PersistDataDeltaAsync(original);

        var replay = await _store.PersistDataDeltaAsync(original);
        Assert.AreEqual(PersistDeltaStatus.Duplicate, replay.Status);
        Assert.HasCount(1, await _store.GetPendingOutboxAsync());

        var conflict = original with
        {
            Upserts = [Json("""{"ticket":"1001","symbol":"EURUSD"}""")],
        };
        await Assert.ThrowsExactlyAsync<InvalidDataException>(
            () => _store.PersistDataDeltaAsync(conflict));
    }

    [TestMethod]
    public async Task RemovesOutboxOnlyAfterAppliedOrDuplicateAcknowledgement()
    {
        var message = Delta("account", 1, 0,
            [Json("""{"balance":1000,"equity":995}""")]);
        await _store.PersistDataDeltaAsync(message);

        Assert.IsFalse(await _store.AcknowledgeOutboxAsync(message.MessageId, "gap", 10));
        Assert.HasCount(1, await _store.GetPendingOutboxAsync());
        Assert.IsTrue(await _store.AcknowledgeOutboxAsync(message.MessageId, "applied", 11));
        Assert.IsEmpty(await _store.GetPendingOutboxAsync());
    }

    [TestMethod]
    [TestCategory("Acceptance")]
    public async Task RecoversEveryUnacknowledgedOutboxMessageAfterProcessRestart()
    {
        const int messageCount = 200;
        for (var revision = 1; revision <= messageCount; revision++)
        {
            await _store.PersistDataDeltaAsync(Delta(
                "positions",
                revision,
                revision - 1,
                [Json($$"""{"ticket":"{{revision:D8}}","symbol":"XAUUSD"}""")]));
        }
        var beforeRestart = await _store.GetPendingOutboxAsync(messageCount);
        await _store.DisposeAsync();

        _store = new BridgeStore(Path.Combine(_directory, "bridge.db"));
        await _store.InitializeAsync();
        var recovered = await _store.GetPendingOutboxAsync(messageCount);

        Assert.AreEqual(messageCount, recovered.Count);
        CollectionAssert.AreEqual(
            beforeRestart.Select(message => message.MessageId).ToArray(),
            recovered.Select(message => message.MessageId).ToArray());
        CollectionAssert.AreEqual(
            beforeRestart.Select(message => message.PayloadJson).ToArray(),
            recovered.Select(message => message.PayloadJson).ToArray());
    }

    [TestMethod]
    public async Task PreservesOutboxRetryDeadlineAfterProcessRestart()
    {
        const long sentAt = 1_800_000_000_000;
        const long retryAt = sentAt + 2_000;
        var message = Delta("account", 1, 0,
            [Json("""{"balance":1000,"equity":995}""")]);
        await _store.PersistDataDeltaAsync(message);
        Assert.IsTrue(await _store.RecordOutboxAttemptAsync(message.MessageId, 0, retryAt));
        Assert.IsEmpty(await _store.GetReadyOutboxAsync(retryAt - 1));
        await _store.DisposeAsync();

        _store = new BridgeStore(Path.Combine(_directory, "bridge.db"));
        await _store.InitializeAsync();

        Assert.IsEmpty(await _store.GetReadyOutboxAsync(retryAt - 1));
        var ready = await _store.GetReadyOutboxAsync(retryAt);
        Assert.HasCount(1, ready);
        Assert.AreEqual(message.MessageId, ready[0].MessageId);
        Assert.AreEqual(1, ready[0].AttemptCount);
    }

    [TestMethod]
    public async Task CoalescesAnOfflineDataStreamIntoOneBoundedFullSnapshot()
    {
        await _store.PersistDataDeltaAsync(Delta(
            "positions", 1, 0, [Json("""{"ticket":"1","volume":0.1}""")]),
            dataOutboxLimitPerStream:3);
        await _store.PersistDataDeltaAsync(Delta(
            "positions", 2, 1, [Json("""{"ticket":"2","volume":0.2}""")]),
            dataOutboxLimitPerStream:3);
        await _store.PersistDataDeltaAsync(Delta(
            "positions", 3, 2, [Json("""{"ticket":"1","volume":0.3}""")]),
            dataOutboxLimitPerStream:3);

        var pending = await _store.GetPendingOutboxAsync(20);

        Assert.HasCount(1, pending);
        var merged = JsonSerializer.Deserialize<DataDeltaMessage>(
            pending[0].PayloadJson, BridgeJson.Options);
        Assert.IsNotNull(merged);
        Assert.IsTrue(merged.FullSnapshot);
        Assert.AreEqual(0, merged.BaseRevision);
        Assert.AreEqual(3, merged.Revision);
        Assert.HasCount(2, merged.Upserts);
        Assert.IsTrue(merged.Upserts.Any(item =>
            item.GetProperty("ticket").GetString() == "1"
            && item.GetProperty("volume").GetDouble() == 0.3));
        Assert.IsTrue(merged.Upserts.Any(item =>
            item.GetProperty("ticket").GetString() == "2"));
    }

    [TestMethod]
    public async Task CoalescesUnacknowledgedDealsAndKeepsDurableCursorUntilServerAck()
    {
        await _store.PersistDataDeltaAsync(Delta(
            "deals", 1, 0, [Json("""{"ticket":"101","time_msc":1000,"symbol":"XAUUSD"}""")]),
            dataOutboxLimitPerStream:3);
        await _store.PersistDataDeltaAsync(Delta(
            "deals", 2, 1, [Json("""{"ticket":"102","time_msc":2000,"symbol":"XAUUSD"}""")]),
            dataOutboxLimitPerStream:3);
        var latest = Delta(
            "deals", 3, 2, [Json("""{"ticket":"103","time_msc":3000,"symbol":"XAUUSD"}""")]);
        await _store.PersistDataDeltaAsync(latest, dataOutboxLimitPerStream:3);

        var pending = await _store.GetPendingOutboxAsync(20);
        var merged = JsonSerializer.Deserialize<DataDeltaMessage>(pending.Single().PayloadJson, BridgeJson.Options);
        var cursor = await _store.GetHistoryCursorAsync(
            "terminal_01JSTORE0001", new("Broker-Demo", "12345678"), "deals");

        Assert.IsNotNull(merged);
        Assert.IsTrue(merged.FullSnapshot);
        Assert.HasCount(3, merged.Upserts);
        Assert.AreEqual(3_000, cursor.TimeMsc);
        Assert.AreEqual("103", cursor.Ticket);
        Assert.AreEqual(3, await _store.CountPendingDealsAsync(
            "terminal_01JSTORE0001", new("Broker-Demo", "12345678")));

        Assert.IsTrue(await _store.AcknowledgeOutboxAsync(latest.MessageId, "applied", 4_000));
        Assert.AreEqual(0, await _store.CountPendingDealsAsync(
            "terminal_01JSTORE0001", new("Broker-Demo", "12345678")));
        Assert.AreEqual(cursor, await _store.GetHistoryCursorAsync(
            "terminal_01JSTORE0001", new("Broker-Demo", "12345678"), "deals"));
    }

    [TestMethod]
    public async Task RejectsDeletesFromImmutableDealsStream()
    {
        await Assert.ThrowsExactlyAsync<InvalidDataException>(() =>
            _store.PersistDataDeltaAsync(Delta(
                "deals", 1, 0,
                [Json("""{"ticket":"101","time_msc":1000}""")],
                [Json(""""101"""")])));
    }

    [TestMethod]
    public async Task ARequestedFullSnapshotSupersedesOlderUnacknowledgedDeltasOnlyForItsStream()
    {
        await _store.PersistDataDeltaAsync(Delta(
            "positions", 1, 0, [Json("""{"ticket":"1"}""")]));
        await _store.PersistDataDeltaAsync(Delta(
            "orders", 1, 0, [Json("""{"ticket":"9"}""")]));
        await _store.PersistDataDeltaAsync(Delta(
            "positions", 2, 0, [Json("""{"ticket":"1"}""")]) with
        {
            FullSnapshot = true,
        });

        var pending = await _store.GetPendingOutboxAsync(20);
        var deltas = pending.Select(message => JsonSerializer.Deserialize<DataDeltaMessage>(
            message.PayloadJson, BridgeJson.Options)!).ToArray();

        Assert.HasCount(2, deltas);
        Assert.HasCount(1, deltas.Where(delta => delta.Stream == "positions"));
        Assert.AreEqual(2, deltas.Single(delta => delta.Stream == "positions").Revision);
        Assert.HasCount(1, deltas.Where(delta => delta.Stream == "orders"));
    }

    [TestMethod]
    public async Task KeepsExecutionReceiptsBoundedAndIdempotent()
    {
        for (var index = 1; index <= 5; index++)
        {
            var result = Result($"command_{index:00000000}", index);
            await _store.SaveExecutionReceiptAsync(result, receiptLimit: 3);
            Assert.IsTrue(await _store.AcknowledgeOutboxAsync(
                result.MessageId, "applied", result.CompletedAtUtcMsc + 1));
        }
        await _store.SaveExecutionReceiptAsync(Result("command_00000005", 5), receiptLimit: 3);

        Assert.AreEqual(3, await _store.CountExecutionReceiptsAsync());
    }

    [TestMethod]
    public async Task NeverTrimsAnExecutionReceiptWhoseTradeResultIsUnacknowledged()
    {
        var first = Result("command_00000001", 1);
        var second = Result("command_00000002", 2);
        var third = Result("command_00000003", 3);
        await _store.SaveExecutionReceiptAsync(first, receiptLimit: 2);
        await _store.SaveExecutionReceiptAsync(second, receiptLimit: 2);
        await _store.SaveExecutionReceiptAsync(third, receiptLimit: 2);

        Assert.AreEqual(3, await _store.CountExecutionReceiptsAsync());
        Assert.IsNotNull(await _store.GetExecutionReceiptAsync(first.CommandId));
        Assert.IsNotNull(await _store.GetExecutionReceiptAsync(second.CommandId));
        Assert.IsNotNull(await _store.GetExecutionReceiptAsync(third.CommandId));

        Assert.IsTrue(await _store.AcknowledgeOutboxAsync(
            first.MessageId, "applied", first.CompletedAtUtcMsc + 1));
        var fourth = Result("command_00000004", 4);
        await _store.SaveExecutionReceiptAsync(fourth, receiptLimit: 2);

        Assert.IsNull(await _store.GetExecutionReceiptAsync(first.CommandId));
        Assert.IsNotNull(await _store.GetExecutionReceiptAsync(second.CommandId));
        Assert.IsNotNull(await _store.GetExecutionReceiptAsync(third.CommandId));
        Assert.IsNotNull(await _store.GetExecutionReceiptAsync(fourth.CommandId));
    }

    [TestMethod]
    public async Task PersistsExecutionReceiptAndTradeOutboxInOneTransaction()
    {
        var result = Result("command_00000001", 1);

        await _store.SaveExecutionReceiptAsync(result);
        var pending = await _store.GetPendingOutboxAsync();

        Assert.HasCount(1, pending);
        Assert.AreEqual(result.MessageId, pending[0].MessageId);
        Assert.AreEqual("command_result", pending[0].MessageType);
        Assert.AreEqual("trade", pending[0].Priority);
        Assert.IsNotNull(await _store.GetExecutionReceiptAsync(result.CommandId));
    }

    [TestMethod]
    public async Task ActivatingTerminalBindingAdvancesDurableConnectionEpoch()
    {
        var terminalPath = Path.Combine(_directory, "Broker MT5", "terminal64.exe");
        var first = await _store.ActivateTerminalBindingAsync(
            "mt5_terminal_01",
            "MT5",
            terminalPath,
            new(" Broker-Demo ", " 12345678 "),
            1_800_000_000_001);
        var second = await _store.ActivateTerminalBindingAsync(
            "mt5_terminal_01",
            "mt5",
            terminalPath,
            new("Broker-Live", "87654321"),
            1_800_000_000_002);

        Assert.AreEqual(1L, first.ConnectionEpoch);
        Assert.AreEqual(2L, second.ConnectionEpoch);
        Assert.AreEqual("Broker-Demo", first.AccountRef.BrokerServer);
        Assert.AreEqual("12345678", first.AccountRef.Login);
        Assert.AreEqual("Broker-Live", second.AccountRef.BrokerServer);
        Assert.AreEqual("87654321", second.AccountRef.Login);
    }

    [TestMethod]
    public async Task AdvancingTerminalBindingPrunesOnlyItsStaleDataOutbox()
    {
        var terminalPath = Path.Combine(_directory, "Broker MT5", "terminal64.exe");
        var first = await _store.ActivateTerminalBindingAsync(
            "mt5_terminal_01", "mt5", terminalPath, new("Broker-Demo", "12345678"), 10);
        await _store.PersistDataDeltaAsync(Delta("positions", 1, 0,
            [Json("""{"ticket":"1001"}""")]) with
        {
            MessageId = "msg_target_epoch_1",
            TerminalInstanceId = first.TerminalInstanceId,
            ConnectionEpoch = first.ConnectionEpoch,
        });
        await _store.PersistDataDeltaAsync(Delta("positions", 1, 0,
            [Json("""{"ticket":"2001"}""")]) with
        {
            MessageId = "msg_other_terminal",
            TerminalInstanceId = "mt5_terminal_02",
            ConnectionEpoch = 1,
        });

        var second = await _store.ActivateTerminalBindingAsync(
            first.TerminalInstanceId, "mt5", terminalPath, first.AccountRef, 20);

        var afterActivation = await _store.GetPendingOutboxAsync();
        Assert.HasCount(1, afterActivation);
        Assert.AreEqual("msg_other_terminal", afterActivation[0].MessageId);
        Assert.AreEqual(0L, await _store.GetStreamRevisionAsync(
            first.TerminalInstanceId, first.ConnectionEpoch, "positions"));
        Assert.AreEqual(1L, await _store.GetStreamRevisionAsync(
            "mt5_terminal_02", 1, "positions"));

        await _store.PersistDataDeltaAsync(Delta("positions", 1, 0,
            [Json("""{"ticket":"1002"}""")]) with
        {
            MessageId = "msg_target_epoch_2",
            TerminalInstanceId = second.TerminalInstanceId,
            ConnectionEpoch = second.ConnectionEpoch,
        });
        var current = await _store.GetPendingOutboxAsync();
        Assert.HasCount(2, current);
        CollectionAssert.Contains(current.Select(message => message.MessageId).ToArray(), "msg_target_epoch_2");
    }

    [TestMethod]
    public async Task SessionPruningRemovesOnlyObsoleteDataAndPreservesTradeReceipts()
    {
        var current = Delta("positions", 1, 0, [Json("""{"ticket":"1001"}""")]) with
        {
            MessageId = "msg_current_data",
            TerminalInstanceId = "terminal_current",
            ConnectionEpoch = 3,
        };
        var obsolete = Delta("positions", 1, 0, [Json("""{"ticket":"2001"}""")]) with
        {
            MessageId = "msg_obsolete_data",
            TerminalInstanceId = "terminal_obsolete",
            ConnectionEpoch = 8,
        };
        var tradeReceipt = Result("command_obsolete_terminal", 99) with
        {
            TerminalInstanceId = "terminal_obsolete",
            ConnectionEpoch = 8,
        };
        await _store.PersistDataDeltaAsync(current);
        await _store.PersistDataDeltaAsync(obsolete);
        await _store.SaveExecutionReceiptAsync(tradeReceipt);

        var removed = await _store.PruneObsoleteDataOutboxAsync(
            new Dictionary<string, long> { ["terminal_current"] = 3 });

        Assert.AreEqual(1, removed);
        var pending = await _store.GetPendingOutboxAsync();
        CollectionAssert.AreEquivalent(
            new[] { current.MessageId, tradeReceipt.MessageId },
            pending.Select(message => message.MessageId).ToArray());
    }

    [TestMethod]
    public async Task KeepsDealHistoryIsolatedWhenOneTerminalSwitchesAccounts()
    {
        const string terminalId = "mt5_terminal_shared";
        var terminalPath = Path.Combine(_directory, "Shared MT5", "terminal64.exe");
        var accountA = new AccountRef("Broker-Demo", "10001");
        var accountB = new AccountRef("Broker-Demo", "20002");
        var first = await _store.ActivateTerminalBindingAsync(
            terminalId, "mt5", terminalPath, accountA, 10);
        await _store.PersistDataDeltaAsync(Delta(
            "deals", 1, 0, [Json("""{"ticket":"101","time_msc":1000}""")]) with
        {
            MessageId = "msg_account_a_deal",
            TerminalInstanceId = terminalId,
            AccountRef = accountA,
            ConnectionEpoch = first.ConnectionEpoch,
        });

        var second = await _store.ActivateTerminalBindingAsync(
            terminalId, "mt5", terminalPath, accountB, 20);

        Assert.AreEqual(HistoryCursor.Empty,
            await _store.GetHistoryCursorAsync(terminalId, accountB, "deals"));
        Assert.AreEqual(0, await _store.CountPendingDealsAsync(terminalId, accountB));

        await _store.PersistDataDeltaAsync(Delta(
            "deals", 1, 0, [Json("""{"ticket":"101","time_msc":2000}""")]) with
        {
            MessageId = "msg_account_b_deal",
            TerminalInstanceId = terminalId,
            AccountRef = accountB,
            ConnectionEpoch = second.ConnectionEpoch,
        });

        Assert.AreEqual(new HistoryCursor(1_000, "101"),
            await _store.GetHistoryCursorAsync(terminalId, accountA, "deals"));
        Assert.AreEqual(new HistoryCursor(2_000, "101"),
            await _store.GetHistoryCursorAsync(terminalId, accountB, "deals"));
        Assert.AreEqual(1, await _store.CountPendingDealsAsync(terminalId, accountA));
        Assert.AreEqual(1, await _store.CountPendingDealsAsync(terminalId, accountB));
    }

    [TestMethod]
    public async Task MigratesLegacyDealHistoryIntoTheBoundAccountScope()
    {
        var databasePath = Path.Combine(_directory, "legacy.db");
        const string terminalId = "mt5_terminal_legacy";
        var account = new AccountRef("Legacy-Broker", "7654321");
        await using (var connection = new SqliteConnection($"Data Source={databasePath}"))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = """
                CREATE TABLE terminal_bindings (
                  terminal_instance_id TEXT PRIMARY KEY,
                  platform TEXT NOT NULL,
                  terminal_path TEXT NOT NULL,
                  broker_server TEXT NOT NULL,
                  login_account TEXT NOT NULL,
                  connection_epoch INTEGER NOT NULL,
                  updated_at_utc_msc INTEGER NOT NULL
                );
                CREATE TABLE deals_pending (
                  terminal_instance_id TEXT NOT NULL,
                  ticket TEXT NOT NULL,
                  connection_epoch INTEGER NOT NULL,
                  revision INTEGER NOT NULL,
                  deal_time_msc INTEGER NOT NULL,
                  observed_at_utc_msc INTEGER NOT NULL,
                  source_time_msc INTEGER,
                  payload_json TEXT NOT NULL,
                  PRIMARY KEY (terminal_instance_id, ticket)
                );
                CREATE TABLE history_cursors (
                  terminal_instance_id TEXT NOT NULL,
                  stream TEXT NOT NULL,
                  cursor_value TEXT NOT NULL,
                  updated_at_utc_msc INTEGER NOT NULL,
                  PRIMARY KEY (terminal_instance_id, stream)
                );
                INSERT INTO terminal_bindings VALUES
                  ($terminal_id, 'mt5', $terminal_path, $broker_server, $login, 4, 1000);
                INSERT INTO deals_pending VALUES
                  ($terminal_id, '9001', 4, 12, 12345, 12346, 12345, $payload);
                INSERT INTO history_cursors VALUES
                  ($terminal_id, 'deals', $cursor, 12346);
                """;
            command.Parameters.AddWithValue("$terminal_id", terminalId);
            command.Parameters.AddWithValue("$terminal_path", Path.Combine(_directory, "Legacy", "terminal64.exe"));
            command.Parameters.AddWithValue("$broker_server", account.BrokerServer);
            command.Parameters.AddWithValue("$login", account.Login);
            command.Parameters.AddWithValue("$payload", "{\"ticket\":\"9001\",\"time_msc\":12345}");
            command.Parameters.AddWithValue("$cursor", "{\"time_msc\":12345,\"ticket\":\"9001\"}");
            await command.ExecuteNonQueryAsync();
        }

        await using var migrated = new BridgeStore(databasePath);
        await migrated.InitializeAsync();
        await migrated.InitializeAsync();

        Assert.AreEqual(new HistoryCursor(12_345, "9001"),
            await migrated.GetHistoryCursorAsync(terminalId, account, "deals"));
        Assert.AreEqual(1, await migrated.CountPendingDealsAsync(terminalId, account));
        Assert.AreEqual(0, await migrated.CountPendingDealsAsync(
            terminalId, new AccountRef(account.BrokerServer, "other-account")));
    }

    [TestMethod]
    public async Task ListsLatestTerminalBindingsForStartupRecovery()
    {
        var firstPath = Path.Combine(_directory, "One", "terminal64.exe");
        var secondPath = Path.Combine(_directory, "Two", "terminal64.exe");
        await _store.ActivateTerminalBindingAsync(
            "mt5_terminal_02", "mt5", secondPath, new("Broker-Two", "2"), 20);
        await _store.ActivateTerminalBindingAsync(
            "mt5_terminal_01", "mt5", firstPath, new("Broker-One", "1"), 10);

        var bindings = await _store.GetTerminalBindingsAsync();

        Assert.HasCount(2, bindings);
        Assert.AreEqual("mt5_terminal_01", bindings[0].TerminalInstanceId);
        Assert.AreEqual(Path.GetFullPath(firstPath), bindings[0].TerminalPath);
        Assert.AreEqual(1L, bindings[0].ConnectionEpoch);
        Assert.AreEqual("mt5", bindings[0].ToDescriptor("test-worker").Platform);
    }

    [TestMethod]
    public async Task ArchivesHistoryByAccountAndReturnsOnlyTheRequestedBoundedPage()
    {
        var terminal = new TerminalDescriptor
        {
            TerminalInstanceId = "terminal_history_01",
            Platform = "mt5",
            AccountRef = new("Broker-Demo", "10001"),
            ConnectionEpoch = 3,
        };
        var other = terminal with { AccountRef = new("Broker-Demo", "20002") };
        await _store.PersistHistoryArchiveBatchAsync(terminal, new(
            [Json("""{"ticket":"501","deal_ticket":"501","order":"101","position_id":"P1","time_msc":1000}""")],
            [Json("""{"ticket":"101","position_id":"P1","time_done":"1970-01-01 00:00:01"}""")],
            [
                Json("""{"ticket":"101","deal_ticket":"501","position_id":"P1","type":"BUY","volume":0.1,"profit":5,"net_profit":4.5,"time_msc":1000,"close_time":"1970-01-01 00:00:01"}"""),
                Json("""{"ticket":"102","deal_ticket":"502","position_id":"P2","type":"SELL","volume":0.2,"profit":-2,"net_profit":-2.5,"time_msc":2000,"close_time":"1970-01-01 00:00:02"}"""),
                Json("""{"ticket":"103","deal_ticket":"503","position_id":"P3","type":"BUY","volume":0.3,"profit":3,"net_profit":3,"time_msc":3000,"close_time":"1970-01-01 00:00:03"}"""),
            ],
            new HistoryCursor(3_000, "503"),
            HasMore:false,
            ObservedAtUtcMsc:4_000));
        await _store.PersistHistoryArchiveBatchAsync(other, new(
            [], [],
            [Json("""{"ticket":"999","deal_ticket":"999","position_id":"PX","type":"BUY","profit":99,"time_msc":9000}""")],
            new HistoryCursor(9_000, "999"), false, 10_000));

        var payload = await _store.ReadHistoryArchivePageAsync(terminal,
            JsonSerializer.SerializeToElement(new { page = 1, page_size = 2, include_deals = true }));

        Assert.AreEqual(2, payload.GetProperty("orders").GetArrayLength());
        Assert.AreEqual("503", payload.GetProperty("orders")[0].GetProperty("deal_ticket").GetString());
        Assert.AreEqual(3, payload.GetProperty("pagination").GetProperty("total_count").GetInt32());
        Assert.AreEqual(2, payload.GetProperty("pagination").GetProperty("total_pages").GetInt32());
        Assert.IsTrue(payload.GetProperty("history_sync").GetProperty("complete").GetBoolean());
        Assert.AreEqual("mt5_sqlite", payload.GetProperty("source").GetString());
        Assert.AreEqual(0, payload.GetProperty("orders").EnumerateArray()
            .Count(item => item.GetProperty("ticket").GetString() == "999"));
    }

    [TestMethod]
    public async Task RejectsOversizedHistoryPagesAndRegressingArchiveCursors()
    {
        var terminal = new TerminalDescriptor
        {
            TerminalInstanceId = "terminal_history_guard",
            Platform = "mt4",
            AccountRef = new("Broker-Demo", "30003"),
            ConnectionEpoch = 1,
        };
        await _store.PersistHistoryArchiveBatchAsync(terminal, new(
            [], [], [], new HistoryCursor(2_000, "2"), true, 3_000));

        await Assert.ThrowsExactlyAsync<InvalidDataException>(() =>
            _store.PersistHistoryArchiveBatchAsync(terminal, new(
                [], [], [], new HistoryCursor(1_000, "1"), true, 4_000)));
        await Assert.ThrowsExactlyAsync<InvalidDataException>(() =>
            _store.ReadHistoryArchivePageAsync(terminal,
                JsonSerializer.SerializeToElement(new { page = 1, page_size = 201 })));
    }

    private static DataDeltaMessage Delta(
        string stream,
        long revision,
        long baseRevision,
        IReadOnlyList<JsonElement> upserts,
        IReadOnlyList<JsonElement>? deletes = null) => new()
    {
        Type = "data_delta",
        MessageId = $"msg_{stream}_{revision:00000000}",
        SentAtUtcMsc = 1_800_000_000_000 + revision,
        TerminalInstanceId = "terminal_01JSTORE0001",
        AccountRef = new("Broker-Demo", "12345678"),
        ConnectionEpoch = 7,
        Stream = stream,
        Revision = revision,
        BaseRevision = baseRevision,
        ObservedAtUtcMsc = 1_800_000_000_000 + revision,
        SourceTimeMsc = 1_800_000_000_000,
        Upserts = upserts,
        Deletes = deletes ?? [],
    };

    private static CommandResultMessage Result(string commandId, long sequence) => new()
    {
        Type = "command_result",
        MessageId = $"msg_result_{sequence:00000000}",
        SentAtUtcMsc = 1_800_000_000_000 + sequence,
        CommandId = commandId,
        TerminalInstanceId = "terminal_01JSTORE0001",
        AccountRef = new("Broker-Demo", "12345678"),
        ConnectionEpoch = 7,
        Status = "succeeded",
        CompletedAtUtcMsc = 1_800_000_000_000 + sequence,
        Evidence = new() { ObservedAtUtcMsc = 1_800_000_000_000 + sequence },
    };

    private static JsonElement Json(string json) => JsonDocument.Parse(json).RootElement.Clone();
}
