using AurumBridge.UI;

namespace AurumBridge;

internal static class Program
{
    [STAThread]
    public static void Main()
    {
        ApplicationConfiguration.Initialize();
        try
        {
            Application.Run(new BridgeApplicationContext());
        }
        catch (Exception error)
        {
            MessageBox.Show(
                BridgeUiText.DescribeError(error),
                "AURUM Bridge 无法启动",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }
}
