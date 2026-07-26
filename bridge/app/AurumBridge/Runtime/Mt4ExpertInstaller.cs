using System.Security.Cryptography;
using AurumBridge.Workers;

namespace AurumBridge.Runtime;

public enum Mt4ExpertDeploymentStatus
{
    Installed,
    Current,
}

public sealed record Mt4ExpertDeployment(
    Mt4Installation Installation,
    string DestinationPath,
    Mt4ExpertDeploymentStatus Status);

public sealed record Mt4ExpertDeploymentFailure(
    string TerminalInstanceId,
    string ErrorCode);

public sealed record Mt4ExpertDeploymentResult(
    IReadOnlyList<Mt4ExpertDeployment> Deployments,
    IReadOnlyList<Mt4ExpertDeploymentFailure> Failures);

public sealed class Mt4ExpertInstaller(string expertSourcePath)
{
    public const string ExpertFileName = "AURUMBridgeEA.ex4";
    private const int MaximumExpertBytes = 16 * 1024 * 1024;
    private readonly string _expertSourcePath = Path.GetFullPath(expertSourcePath);

    public async Task<Mt4ExpertDeploymentResult> DeployAsync(
        IEnumerable<Mt4Installation> installations,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(installations);
        var targets = installations.ToArray();
        byte[] source;
        try
        {
            source = await ReadSourceAsync(cancellationToken);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            return new(
                [],
                targets.Select(installation => new Mt4ExpertDeploymentFailure(
                    installation.TerminalInstanceId,
                    NormalizeError(error))).ToArray());
        }
        var sourceHash = SHA256.HashData(source);
        var deployments = new List<Mt4ExpertDeployment>();
        var failures = new List<Mt4ExpertDeploymentFailure>();
        foreach (var installation in targets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var destination = ResolveDestination(installation.TerminalDataPath);
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                if (await MatchesAsync(
                        destination,
                        source.Length,
                        sourceHash,
                        cancellationToken))
                {
                    deployments.Add(new(
                        installation,
                        destination,
                        Mt4ExpertDeploymentStatus.Current));
                    continue;
                }
                await WriteAtomicallyAsync(destination, source, cancellationToken);
                deployments.Add(new(
                    installation,
                    destination,
                    Mt4ExpertDeploymentStatus.Installed));
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                failures.Add(new(
                    installation.TerminalInstanceId,
                    NormalizeError(error)));
            }
        }
        return new(deployments, failures);
    }

    private async Task<byte[]> ReadSourceAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(_expertSourcePath))
        {
            throw new FileNotFoundException("mt4_ea_package_not_found", _expertSourcePath);
        }
        var info = new FileInfo(_expertSourcePath);
        if (info.Length is <= 0 or > MaximumExpertBytes)
        {
            throw new InvalidDataException("mt4_ea_package_invalid");
        }
        var content = await File.ReadAllBytesAsync(_expertSourcePath, cancellationToken);
        if (content.Length is <= 0 or > MaximumExpertBytes)
        {
            throw new InvalidDataException("mt4_ea_package_invalid");
        }
        return content;
    }

    private static string ResolveDestination(string terminalDataPath)
    {
        var dataPath = Path.GetFullPath(terminalDataPath);
        var mql4Path = Path.Combine(dataPath, "MQL4");
        if (!Directory.Exists(mql4Path))
        {
            throw new DirectoryNotFoundException("mt4_terminal_data_path_not_found");
        }
        var expertsPath = Path.GetFullPath(Path.Combine(mql4Path, "Experts"));
        var destination = Path.GetFullPath(Path.Combine(expertsPath, ExpertFileName));
        var prefix = expertsPath.TrimEnd(Path.DirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        if (!destination.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("mt4_ea_destination_invalid");
        }
        return destination;
    }

    private static async Task<bool> MatchesAsync(
        string destination,
        int sourceLength,
        byte[] sourceHash,
        CancellationToken cancellationToken)
    {
        if (!File.Exists(destination))
        {
            return false;
        }
        if (new FileInfo(destination).Length != sourceLength)
        {
            return false;
        }
        await using var stream = new FileStream(
            destination,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,
            64 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        var destinationHash = await SHA256.HashDataAsync(stream, cancellationToken);
        return CryptographicOperations.FixedTimeEquals(sourceHash, destinationHash);
    }

    private static async Task WriteAtomicallyAsync(
        string destination,
        byte[] content,
        CancellationToken cancellationToken)
    {
        var temporaryPath = Path.Combine(
            Path.GetDirectoryName(destination)!,
            $".{ExpertFileName}.{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var stream = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                64 * 1024,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await stream.WriteAsync(content, cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }
            File.Move(temporaryPath, destination, overwrite:true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    private static string NormalizeError(Exception error) => error switch
    {
        FileNotFoundException fileError when fileError.Message == "mt4_ea_package_not_found" =>
            fileError.Message,
        UnauthorizedAccessException => "mt4_ea_install_access_denied",
        DirectoryNotFoundException => "mt4_terminal_data_path_not_found",
        IOException => "mt4_ea_install_io_failed",
        InvalidDataException dataError => dataError.Message,
        _ => "mt4_ea_install_failed",
    };
}
