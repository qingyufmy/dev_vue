using AurumBridge.Runtime;
using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class Mt4ExpertInstallerTests
{
    private string _directory = null!;
    private string _source = null!;
    private string _dataPath = null!;

    [TestInitialize]
    public void Initialize()
    {
        _directory = Path.Combine(Path.GetTempPath(), $"aurum-mt4-ea-{Guid.NewGuid():N}");
        _source = Path.Combine(_directory, "package", Mt4ExpertInstaller.ExpertFileName);
        _dataPath = Path.Combine(_directory, "terminal-data");
        Directory.CreateDirectory(Path.GetDirectoryName(_source)!);
        Directory.CreateDirectory(Path.Combine(_dataPath, "MQL4"));
        File.WriteAllBytes(_source, [1, 2, 3, 4]);
    }

    [TestCleanup]
    public void Cleanup()
    {
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive:true);
        }
    }

    [TestMethod]
    public async Task InstallsExpertIntoTheSelectedTerminalDataDirectory()
    {
        var installation = Installation();

        var result = await new Mt4ExpertInstaller(_source).DeployAsync([installation]);

        Assert.IsEmpty(result.Failures);
        Assert.HasCount(1, result.Deployments);
        Assert.AreEqual(Mt4ExpertDeploymentStatus.Installed, result.Deployments[0].Status);
        var destination = Path.Combine(
            _dataPath,
            "MQL4",
            "Experts",
            Mt4ExpertInstaller.ExpertFileName);
        CollectionAssert.AreEqual(
            await File.ReadAllBytesAsync(_source),
            await File.ReadAllBytesAsync(destination));
    }

    [TestMethod]
    public async Task RepeatedDeploymentDoesNotRewriteAnIdenticalExpert()
    {
        var installer = new Mt4ExpertInstaller(_source);
        var installation = Installation();
        await installer.DeployAsync([installation]);

        var result = await installer.DeployAsync([installation]);

        Assert.AreEqual(Mt4ExpertDeploymentStatus.Current, result.Deployments[0].Status);
    }

    [TestMethod]
    public async Task NewPackageAtomicallyReplacesTheExistingExpert()
    {
        var installer = new Mt4ExpertInstaller(_source);
        var installation = Installation();
        await installer.DeployAsync([installation]);
        await File.WriteAllBytesAsync(_source, [9, 8, 7]);

        var result = await installer.DeployAsync([installation]);

        Assert.AreEqual(Mt4ExpertDeploymentStatus.Installed, result.Deployments[0].Status);
        CollectionAssert.AreEqual(
            new byte[] { 9, 8, 7 },
            await File.ReadAllBytesAsync(result.Deployments[0].DestinationPath));
        Assert.IsEmpty(Directory.GetFiles(
            Path.GetDirectoryName(result.Deployments[0].DestinationPath)!,
            "*.tmp"));
    }

    [TestMethod]
    public async Task MissingPackageReturnsARecoverablePerTerminalFailure()
    {
        File.Delete(_source);

        var result = await new Mt4ExpertInstaller(_source).DeployAsync([Installation()]);

        Assert.IsEmpty(result.Deployments);
        Assert.HasCount(1, result.Failures);
        Assert.AreEqual("mt4_ea_package_not_found", result.Failures[0].ErrorCode);
    }

    private Mt4Installation Installation() => new(
        _dataPath,
        Path.Combine(_directory, "Broker MT4"),
        "test",
        IsRunning:false);
}
