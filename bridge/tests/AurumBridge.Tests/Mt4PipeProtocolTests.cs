using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class Mt4PipeProtocolTests
{
    [TestMethod]
    public void HelloRoundTripsUtf8Identity()
    {
        var hello = new Mt4Hello(
            3,
            "3.0.0",
            @"C:\Users\Trader\AppData\Roaming\MetaQuotes\Terminal\账户一",
            "Broker-Demo",
            "12345678",
            true,
            true);

        var decoded = Mt4PipeProtocol.DecodeHello(Mt4PipeProtocol.EncodeHello(hello));

        Assert.AreEqual(hello, decoded);
    }

    [TestMethod]
    public void DecodesSnapshotIntoValidatedJsonCollections()
    {
        var payload = EncodeRaw(writer =>
        {
            writer.Write((int)Mt4MessageType.Snapshot);
            writer.Write(1_800_000_000_000L);
            WriteString(writer, """{"balance":1000.0}""");
            WriteString(writer, """[{"ticket":"101","symbol":"XAUUSD"}]""");
            WriteString(writer, "[]");
        });

        var snapshot = Mt4PipeProtocol.DecodeSnapshot(payload);

        Assert.AreEqual(1000.0, snapshot.Account.GetProperty("balance").GetDouble());
        Assert.HasCount(1, snapshot.Positions);
        Assert.IsEmpty(snapshot.Orders);
    }

    [TestMethod]
    public async Task FrameReaderRejectsOversizedPayloadBeforeAllocation()
    {
        var header = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, Mt4PipeProtocol.MaxFrameBytes + 1);
        await using var stream = new MemoryStream(header);

        await Assert.ThrowsExactlyAsync<InvalidDataException>(() => Mt4PipeProtocol.ReadFrameAsync(stream));
    }

    [TestMethod]
    public void ConvertsV3TradeCommandToStrictMt4Fields()
    {
        var command = Command("place_order", new
        {
            symbol = "XAUUSD",
            side = "buy",
            order_kind = "limit",
            volume = 0.1,
            price = 2300.5,
            stop_loss = 2290.0,
        });

        var local = Mt4PipeProtocol.CreateTradeCommand(command);
        var payload = Mt4PipeProtocol.EncodeCommand(local);

        Assert.AreEqual(Mt4TradeAction.PlaceOrder, local.Action);
        Assert.AreEqual(Mt4OrderSide.Buy, local.Side);
        Assert.AreEqual(Mt4OrderKind.Limit, local.OrderKind);
        Assert.AreEqual(0.1, local.Volume);
        Assert.IsGreaterThan(64, payload.Length);
    }

    [TestMethod]
    public void RejectsMt5OnlyStopLimitBeforeSendingToEa()
    {
        var command = Command("place_order", new
        {
            symbol = "XAUUSD",
            side = "buy",
            order_kind = "stop_limit",
            volume = 0.1,
        });

        var error = Assert.ThrowsExactly<InvalidDataException>(() =>
            Mt4PipeProtocol.CreateTradeCommand(command));

        Assert.AreEqual("mt4_stop_limit_unsupported", error.Message);
    }

    [TestMethod]
    public void PositionProtectionGuardFieldsRoundTripToMt4Ea()
    {
        var command = Command("modify_position", new
        {
            ticket = "10",
            symbol = "XAUUSD",
            side = "buy",
            volume = 0.1,
            magic = 234000,
            stop_loss = 2295.0,
            take_profit = 2320.0,
            expected_stop_loss = 2290.0,
            expected_take_profit = 2320.0,
        });

        var local = Mt4PipeProtocol.CreateTradeCommand(command);
        var decoded = Mt4PipeProtocol.DecodeCommand(Mt4PipeProtocol.EncodeCommand(local));

        Assert.AreEqual(Mt4TradeAction.ModifyPosition, decoded.Action);
        Assert.AreEqual(2295.0, decoded.StopLoss);
        Assert.AreEqual(2290.0, decoded.ExpectedStopLoss);
        Assert.AreEqual(2320.0, decoded.ExpectedTakeProfit);
    }

    [TestMethod]
    public void DurableCommentAndTicketOnlyExecutionQueryRoundTrip()
    {
        var place = Mt4PipeProtocol.DecodeCommand(Mt4PipeProtocol.EncodeCommand(
            Mt4PipeProtocol.CreateTradeCommand(Command("place_order", new
            {
                symbol = "XAUUSD", side = "buy", order_kind = "market", volume = 0.1,
                comment = "AI-2F",
            }))));
        var query = Mt4PipeProtocol.DecodeCommand(Mt4PipeProtocol.EncodeCommand(
            Mt4PipeProtocol.CreateTradeCommand(Command("query_execution", new
            {
                expected_kind = "pending", pending_ticket = "5003", bridge_command_ref = "AI-2F",
            }))));

        Assert.AreEqual("AI-2F", place.Comment);
        Assert.AreEqual(5003L, query.Ticket);
        Assert.AreEqual("pending", query.ExpectedKind);
        Assert.AreEqual("AI-2F", query.BridgeCommandRef);
    }

    [TestMethod]
    public void CommandResultRoundTripsStructuredExecutionEvidence()
    {
        var raw = JsonSerializer.SerializeToElement(new
        {
            found = true, complete = true, kind = "pending", ticket = "5003", pending_state = "filled",
        });
        var decoded = Mt4PipeProtocol.DecodeCommandResult(Mt4PipeProtocol.EncodeCommandResult(new(
            "command_mt4_query_01", "succeeded", null, null, 0, 5003,
            1_800_000_000_100, raw)));

        Assert.IsTrue(decoded.RawResult!.Value.GetProperty("found").GetBoolean());
        Assert.AreEqual("filled", decoded.RawResult.Value.GetProperty("pending_state").GetString());
    }

    [TestMethod]
    public void RatesRequestAndResponseRoundTripWithBoundedFields()
    {
        var request = new DataRequestMessage
        {
            Type = "data_request", MessageId = "message_mt4_rates_01", SentAtUtcMsc = 1,
            RequestId = "request_mt4_rates_01", TerminalInstanceId = "mt4_terminal_codec_01",
            AccountRef = new("Broker-Demo", "12345678"), ConnectionEpoch = 1,
            Action = "rates", Params = JsonSerializer.SerializeToElement(new
            {
                symbol = "XAUUSD", timeframe = "m30", count = 100,
            }),
        };
        var local = Mt4PipeProtocol.CreateRatesRequest(request);
        var decodedRequest = Mt4PipeProtocol.DecodeRatesRequest(Mt4PipeProtocol.EncodeRatesRequest(local));
        var decodedResponse = Mt4PipeProtocol.DecodeRates(Mt4PipeProtocol.EncodeRates(new(
            request.RequestId, 1_800_000_000_100, "succeeded",
            JsonSerializer.SerializeToElement(new { symbol = "XAUUSD", rates = Array.Empty<object>() }), null)));

        Assert.AreEqual("M30", decodedRequest.Timeframe);
        Assert.AreEqual(100, decodedRequest.Count);
        Assert.AreEqual("XAUUSD", decodedResponse.Payload!.Value.GetProperty("symbol").GetString());
    }

    [TestMethod]
    public void SymbolSnapshotRequestAndResponseRoundTrip()
    {
        var request = new DataRequestMessage
        {
            Type = "data_request", MessageId = "message_mt4_symbol_01", SentAtUtcMsc = 1,
            RequestId = "request_mt4_symbol_01", TerminalInstanceId = "mt4_terminal_codec_01",
            AccountRef = new("Broker-Demo", "12345678"), ConnectionEpoch = 1,
            Action = "symbol_snapshot",
            Params = JsonSerializer.SerializeToElement(new { symbol = "XAUUSD" }),
        };
        var local = Mt4PipeProtocol.CreateSymbolSnapshotRequest(request);
        var decodedRequest = Mt4PipeProtocol.DecodeSymbolSnapshotRequest(
            Mt4PipeProtocol.EncodeSymbolSnapshotRequest(local));
        var decodedResponse = Mt4PipeProtocol.DecodeSymbolSnapshot(
            Mt4PipeProtocol.EncodeSymbolSnapshot(new(
                request.RequestId, 1_800_000_000_100, "succeeded",
                JsonSerializer.SerializeToElement(new { symbol = "XAUUSD", source = "mt4" }), null)));

        Assert.AreEqual("XAUUSD", decodedRequest.Symbol);
        Assert.AreEqual("mt4", decodedResponse.Payload!.Value.GetProperty("source").GetString());
    }

    [TestMethod]
    public void RiskSnapshotRequestAndResponseRoundTripWithDualCursor()
    {
        var request = new DataRequestMessage
        {
            Type = "data_request", MessageId = "message_mt4_risk_01", SentAtUtcMsc = 1,
            RequestId = "request_mt4_risk_01", TerminalInstanceId = "mt4_terminal_codec_01",
            AccountRef = new("Broker-Demo", "12345678"), ConnectionEpoch = 1,
            Action = "risk_snapshot", Params = JsonSerializer.SerializeToElement(new
            {
                symbol = "XAUUSD", last_deal_time_msc = 100L, last_deal_ticket = 7L,
                baseline_from_utc_msc = 0L,
                proposed_order = new { symbol = "XAUUSD", order_type = "buy", volume = 0.1, entry_price = 2300, sl = 2290 },
            }),
        };
        var local = Mt4PipeProtocol.CreateRiskSnapshotRequest(request);
        var decodedRequest = Mt4PipeProtocol.DecodeRiskSnapshotRequest(
            Mt4PipeProtocol.EncodeRiskSnapshotRequest(local));
        var decodedResponse = Mt4PipeProtocol.DecodeRiskSnapshot(
            Mt4PipeProtocol.EncodeRiskSnapshot(new(
                request.RequestId, 1_800_000_000_100, "succeeded",
                JsonSerializer.SerializeToElement(new { snapshot_version = 1, complete = true }), null)));

        Assert.AreEqual(100L, decodedRequest.LastDealTimeMsc);
        Assert.AreEqual(7L, decodedRequest.LastDealTicket);
        Assert.AreEqual("buy", decodedRequest.ProposedOrderType);
        Assert.AreEqual(1, decodedResponse.Payload!.Value.GetProperty("snapshot_version").GetInt32());
    }

    [TestMethod]
    public void RiskSnapshotRejectsMalformedProposedOrderBeforeEaIo()
    {
        var request = new DataRequestMessage
        {
            Type = "data_request", MessageId = "message_mt4_risk_bad_01", SentAtUtcMsc = 1,
            RequestId = "request_mt4_risk_bad_01", TerminalInstanceId = "mt4_terminal_codec_01",
            AccountRef = new("Broker-Demo", "12345678"), ConnectionEpoch = 1,
            Action = "risk_snapshot",
            Params = JsonSerializer.SerializeToElement(new { symbol = "XAUUSD", proposed_order = "invalid" }),
        };

        var error = Assert.ThrowsExactly<InvalidDataException>(() =>
            Mt4PipeProtocol.CreateRiskSnapshotRequest(request));
        Assert.AreEqual("mt4_risk_snapshot_request_invalid", error.Message);
    }

    [TestMethod]
    public void QuoteRequestAndResponseRoundTripWithStrictRoute()
    {
        var request = Mt4PipeProtocol.CreateQuoteRequest(QuoteRequest());
        var decodedRequest = Mt4PipeProtocol.DecodeQuoteRequest(
            Mt4PipeProtocol.EncodeQuoteRequest(request));
        var quote = new Mt4Quote(
            request.RequestId, request.Symbol, 1_800_000_000_100,
            "succeeded", 2300.0, 2300.2, null);
        var decodedQuote = Mt4PipeProtocol.DecodeQuote(Mt4PipeProtocol.EncodeQuote(quote));

        Assert.AreEqual(request, decodedRequest);
        Assert.AreEqual(quote, decodedQuote);
    }

    [TestMethod]
    public async Task EaConnectionCompletesHandshakeAndSnapshotRequest()
    {
        var pipeName = $"aurum_mt4_test_{Guid.NewGuid():N}";
        var accept = Mt4EaConnection.AcceptAsync(pipeName, TimeSpan.FromSeconds(5));
        await using var client = new NamedPipeClientStream(
            ".",
            pipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous);
        await client.ConnectAsync(5_000);
        await Mt4PipeProtocol.WriteFrameAsync(client, Mt4PipeProtocol.EncodeHello(new(
            3,
            "3.0.0-test",
            @"C:\MT4\Data",
            "Broker-Demo",
            "12345678",
            true,
            true)));
        await using var connection = await accept;

        var welcomeTask = connection.SendWelcomeAsync(new("mt4_terminal_pipe_01", 7, "aurum_mt4_terminal_pipe_01"));
        var welcome = Mt4PipeProtocol.DecodeWelcome(await Mt4PipeProtocol.ReadFrameAsync(client));
        await welcomeTask;
        Assert.AreEqual(7L, welcome.ConnectionEpoch);
        Assert.AreEqual("aurum_mt4_terminal_pipe_01", welcome.ReconnectPipeName);

        var collectTask = connection.CollectAsync(Mt4CollectionStreams.All);
        var streams = Mt4PipeProtocol.DecodeCollect(await Mt4PipeProtocol.ReadFrameAsync(client));
        Assert.AreEqual(Mt4CollectionStreams.All, streams);
        await Mt4PipeProtocol.WriteFrameAsync(client, Mt4PipeProtocol.EncodeSnapshot(new(
            1_800_000_000_000,
            JsonSerializer.SerializeToElement(new { balance = 1000.0 }),
            [JsonSerializer.SerializeToElement(new { ticket = "1" })],
            [])));
        var snapshot = await collectTask;

        Assert.AreEqual(1000.0, snapshot.Account.GetProperty("balance").GetDouble());
        Assert.HasCount(1, snapshot.Positions);

        var localCommand = Mt4PipeProtocol.CreateTradeCommand(Command("cancel_order", new { ticket = "99" }));
        var executeTask = connection.ExecuteAsync(localCommand);
        var receivedCommand = Mt4PipeProtocol.DecodeCommand(await Mt4PipeProtocol.ReadFrameAsync(client));
        Assert.AreEqual(99L, receivedCommand.Ticket);
        await Mt4PipeProtocol.WriteFrameAsync(client, Mt4PipeProtocol.EncodeCommandResult(new(
            localCommand.CommandId,
            "succeeded",
            null,
            null,
            0,
            99,
            1_800_000_000_100)));
        var result = await executeTask;
        Assert.AreEqual("succeeded", result.Status);
        Assert.AreEqual(99L, result.Ticket);

        var quoteRequest = Mt4PipeProtocol.CreateQuoteRequest(QuoteRequest());
        var quoteTask = connection.GetQuoteAsync(quoteRequest);
        var receivedQuoteRequest = Mt4PipeProtocol.DecodeQuoteRequest(
            await Mt4PipeProtocol.ReadFrameAsync(client));
        Assert.AreEqual("XAUUSD", receivedQuoteRequest.Symbol);
        await Mt4PipeProtocol.WriteFrameAsync(client, Mt4PipeProtocol.EncodeQuote(new(
            quoteRequest.RequestId,
            quoteRequest.Symbol,
            1_800_000_000_200,
            "succeeded",
            2300.0,
            2300.2,
            null)));
        Assert.AreEqual(2300.2, (await quoteTask).Ask);

        var ratesRequest = Mt4PipeProtocol.CreateRatesRequest(new DataRequestMessage
        {
            Type = "data_request", MessageId = "message_mt4_rates_pipe_01", SentAtUtcMsc = 1,
            RequestId = "request_mt4_rates_pipe_01", TerminalInstanceId = "mt4_terminal_pipe_01",
            AccountRef = new("Broker-Demo", "12345678"), ConnectionEpoch = 7,
            Action = "rates", Params = JsonSerializer.SerializeToElement(new
            {
                symbol = "XAUUSD", timeframe = "M30", count = 100,
            }),
        });
        var ratesTask = connection.GetRatesAsync(ratesRequest);
        var receivedRatesRequest = Mt4PipeProtocol.DecodeRatesRequest(
            await Mt4PipeProtocol.ReadFrameAsync(client));
        Assert.AreEqual(100, receivedRatesRequest.Count);
        await Mt4PipeProtocol.WriteFrameAsync(client, Mt4PipeProtocol.EncodeRates(new(
            ratesRequest.RequestId, 1_800_000_000_300, "succeeded",
            JsonSerializer.SerializeToElement(new { symbol = "XAUUSD", rates = Array.Empty<object>() }), null)));
        Assert.AreEqual("succeeded", (await ratesTask).Status);
    }

    private static byte[] EncodeRaw(Action<BinaryWriter> write)
    {
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, new UTF8Encoding(false, true), leaveOpen: true);
        write(writer);
        return stream.ToArray();
    }

    private static void WriteString(BinaryWriter writer, string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        writer.Write(bytes.Length);
        writer.Write(bytes);
    }

    private static CommandMessage Command(string action, object parameters) => new()
    {
        Type = "command",
        MessageId = "message_mt4_codec_01",
        SentAtUtcMsc = 1_800_000_000_000,
        CommandId = "command_mt4_codec_01",
        TerminalInstanceId = "mt4_terminal_codec_01",
        AccountRef = new("Broker-Demo", "12345678"),
        ConnectionEpoch = 1,
        IssuedAtUtcMsc = 1_800_000_000_000,
        DeadlineUtcMsc = 1_800_000_030_000,
        Action = action,
        Params = JsonSerializer.SerializeToElement(parameters),
    };

    private static QuoteRequestMessage QuoteRequest() => new()
    {
        Type = "quote_request",
        MessageId = "message_quote_mt4_codec_01",
        SentAtUtcMsc = 1_800_000_000_000,
        RequestId = "request_quote_mt4_codec_01",
        TerminalInstanceId = "mt4_terminal_codec_01",
        AccountRef = new("Broker-Demo", "12345678"),
        ConnectionEpoch = 1,
        Symbol = "XAUUSD",
    };
}
