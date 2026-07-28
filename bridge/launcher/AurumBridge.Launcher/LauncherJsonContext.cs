using System.Text.Json.Serialization;

namespace AurumBridge.Launcher;

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.Unspecified,
    GenerationMode = JsonSourceGenerationMode.Metadata)]
[JsonSerializable(typeof(VersionPointer))]
[JsonSerializable(typeof(LauncherUpdateState))]
internal partial class LauncherJsonContext : JsonSerializerContext;
