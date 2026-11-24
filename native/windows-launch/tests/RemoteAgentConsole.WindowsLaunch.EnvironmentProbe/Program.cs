#nullable enable

using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace RemoteAgentConsole.WindowsLaunch.EnvironmentProbe;

/// <summary>
/// Synthetic child that records exactly the environment block it received. It is a
/// qualification helper, not a product component and not an agent.
/// </summary>
internal static class EnvironmentProbe
{
    public static int Main(string[] args)
    {
        if (args.Length != 2 || args[0] != "--out" || string.IsNullOrWhiteSpace(args[1]))
        {
            Console.Error.WriteLine("ENVIRONMENT_PROBE_USAGE --out <absolute-path>");
            return 2;
        }

        try
        {
            var output = Path.GetFullPath(args[1]);
            var directory = Path.GetDirectoryName(output);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var variables = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            {
                if (entry.Key is string key)
                {
                    variables[key] = entry.Value as string ?? string.Empty;
                }
            }

            File.WriteAllText(
                output,
                JsonSerializer.Serialize(variables, new JsonSerializerOptions { WriteIndented = true }));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"ENVIRONMENT_PROBE_ERROR {error.GetType().Name}: {error.Message}");
            return 2;
        }
    }
}
