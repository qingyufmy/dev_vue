using System.IO.Pipes;
using System.Text.Json;
using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class WorkerPipeProtocolTests
{
    [TestMethod]
    public async Task FrameRoundTripsUtf8Json()
    {
        await using var stream = new MemoryStream();
        await WorkerPipeProtocol.WriteAsync(stream, new { v = 3, type = "collect", text = "交易" });
        stream.Position = 0;
        using var message = await WorkerPipeProtocol.ReadAsync(stream);

        Assert.AreEqual("交易", message.RootElement.GetProperty("text").GetString());
    }

    [TestMethod]
    public async Task RejectsOversizedFrameBeforeAllocatingPayload()
    {
        await using var stream = new MemoryStream();
        await stream.WriteAsync(BitConverter.GetBytes((uint)WorkerPipeProtocol.MaxFrameBytes + 1));
        stream.Position = 0;

        await Assert.ThrowsExactlyAsync<InvalidDataException>(() => WorkerPipeProtocol.ReadAsync(stream));
    }

    [TestMethod]
    public async Task CurrentUserNamedPipeCarriesOneRequestAndResponse()
    {
        var pipeName = $"aurum-test-{Guid.NewGuid():N}";
        await using var server = new NamedPipeServerStream(
            pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await using var client = new NamedPipeClientStream(
            ".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous,
            System.Security.Principal.TokenImpersonationLevel.Identification);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var connection = server.WaitForConnectionAsync(timeout.Token);
        await client.ConnectAsync(timeout.Token);
        await connection;

        var requestTask = WorkerPipeProtocol.ReadAsync(server, timeout.Token);
        await WorkerPipeProtocol.WriteAsync(client, new { v = 3, type = "collect" }, timeout.Token);
        using var request = await requestTask;
        Assert.AreEqual("collect", request.RootElement.GetProperty("type").GetString());
        var responseTask = WorkerPipeProtocol.ReadAsync(client, timeout.Token);
        await WorkerPipeProtocol.WriteAsync(server, new { v = 3, type = "snapshot" }, timeout.Token);
        using var response = await responseTask;
        Assert.AreEqual("snapshot", response.RootElement.GetProperty("type").GetString());
    }
}
