using AurumBridge.UI;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeBrandIconTests
{
    [TestMethod]
    public void BrandIconIsEmbeddedAndLoadable()
    {
        var resourceNames = typeof(BridgeBrandIcon).Assembly.GetManifestResourceNames();

        CollectionAssert.Contains(resourceNames, BridgeBrandIcon.ResourceName);
        Assert.IsNotNull(BridgeBrandIcon.ApplicationIcon);
        Assert.IsTrue(BridgeBrandIcon.ApplicationIcon.Width >= 16);
        Assert.IsTrue(BridgeBrandIcon.ApplicationIcon.Height >= 16);
    }
}
