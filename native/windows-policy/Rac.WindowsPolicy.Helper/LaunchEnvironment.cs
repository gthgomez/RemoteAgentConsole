using System.Collections;

namespace Rac.WindowsPolicy.Helper;

/// <summary>
/// Launch-boundary checks for the emitted single-file artifact.
///
/// The qualification artifact is published with
/// IncludeNativeLibrariesForSelfExtract=false and has no application native
/// libraries. It does not use an extraction directory. The helper therefore
/// rejects inherited runtime/native-loading overrides, including any
/// DOTNET_BUNDLE_EXTRACT_* variable, rather than accepting a directory setting
/// that this artifact does not consume.
/// </summary>
internal static class LaunchEnvironment
{
    private static readonly string[] DeniedPrefixes =
    {
        "DOTNET_",
        "COREHOST_",
        "COMPLUS_",
    };

    private static readonly string[] DeniedNames =
    {
        "NATIVE_DLL_SEARCH_DIRECTORIES",
        "CLR_LOADER_OPTIMIZATION",
    };

    internal static void Validate()
    {
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            if (entry.Key is not string key)
            {
                continue;
            }

            if (DeniedNames.Any(name => string.Equals(key, name, StringComparison.OrdinalIgnoreCase))
                || DeniedPrefixes.Any(prefix => key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
            {
                throw Denied("runtime-env-untrusted");
            }
        }
    }

    private static PolicyFailureException Denied(string code) => new(code, 3);
}
