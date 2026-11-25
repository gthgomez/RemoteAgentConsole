#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using System.Threading;

namespace RemoteAgentConsole.WindowsLaunch.Tests;

internal sealed record FixtureIdentity(
    int SchemaVersion,
    string Role,
    string Instance,
    int ProcessId,
    long StartTimeUtcTicks,
    int? ParentProcessId,
    long? ParentStartTimeUtcTicks,
    string ExecutablePath);

internal sealed record FixtureHeartbeat(
    int SchemaVersion,
    string Role,
    string Instance,
    int ProcessId,
    long StartTimeUtcTicks,
    long HeartbeatUtcTicks,
    int Sequence);

internal sealed record FixtureShutdown(
    int SchemaVersion,
    int RootProcessId,
    long RootStartTimeUtcTicks,
    int? ChildProcessId,
    long? ChildStartTimeUtcTicks,
    bool ChildIdentityMatched,
    bool ChildTreeSettled,
    string Result);

/// <summary>Read-only client for the existing synthetic process-tree fixture.</summary>
internal sealed class FixtureControl
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    private readonly string _executablePath;
    private readonly string _executableDirectory;

    internal FixtureControl(string executablePath)
    {
        _executablePath = Path.GetFullPath(executablePath);
        _executableDirectory = Path.GetDirectoryName(_executablePath)
            ?? throw new ArgumentException("The fixture executable has no directory.", nameof(executablePath));
    }

    internal string ExecutablePath => _executablePath;

    internal string ExecutableDirectory => _executableDirectory;

    internal Process StartDetachedPeer(
        string witnessDirectory,
        out Task<string> standardOutput,
        out Task<string> standardError)
    {
        Directory.CreateDirectory(witnessDirectory);
        var startInfo = new ProcessStartInfo(_executablePath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = _executableDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add("peer");
        startInfo.ArgumentList.Add("--witness-dir");
        startInfo.ArgumentList.Add(witnessDirectory);
        var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("The synthetic peer did not start.");
        standardOutput = process.StandardOutput.ReadToEndAsync();
        standardError = process.StandardError.ReadToEndAsync();
        return process;
    }

    internal LaunchContract RootContract(string witnessDirectory, IReadOnlyDictionary<string, string> environment) =>
        LaunchContract.Create(
            _executablePath,
            _executableDirectory,
            new[] { "tree-root", "--witness-dir", witnessDirectory },
            environment);

    internal static void RequestStop(string witnessDirectory, string marker) =>
        File.WriteAllText(Path.Combine(witnessDirectory, marker), string.Empty);

    internal static FixtureIdentity ReadIdentity(string witnessDirectory, string instance)
    {
        var path = Path.Combine(witnessDirectory, instance + ".json");
        var identity = ReadJson<FixtureIdentity>(path);
        return identity;
    }

    internal static FixtureHeartbeat ReadHeartbeat(string witnessDirectory, string instance) =>
        ReadJson<FixtureHeartbeat>(Path.Combine(witnessDirectory, instance + ".heartbeat.json"));

    internal static FixtureShutdown ReadShutdown(string witnessDirectory) =>
        ReadJson<FixtureShutdown>(Path.Combine(witnessDirectory, "shutdown.json"));

    internal static bool WaitForFile(string path, TimeSpan timeout) =>
        WaitUntil(() => File.Exists(path), timeout);

    internal static bool IsExactIdentityAlive(FixtureIdentity identity)
    {
        try
        {
            using var process = Process.GetProcessById(identity.ProcessId);
            if (process.HasExited)
            {
                return false;
            }

            return process.StartTime.ToUniversalTime().Ticks == identity.StartTimeUtcTicks;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // Access-denied means the identity could not be disproved; treat as alive.
            return true;
        }
    }

    internal static bool WaitForDeath(FixtureIdentity identity, TimeSpan timeout) =>
        WaitUntil(() => !IsExactIdentityAlive(identity), timeout);

    internal static bool WaitUntil(Func<bool> condition, TimeSpan timeout, int pollMilliseconds = 50)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.Elapsed < timeout)
        {
            if (TryEvaluate(condition))
            {
                return true;
            }

            Thread.Sleep(pollMilliseconds);
        }

        return TryEvaluate(condition);
    }

    private static bool TryEvaluate(Func<bool> condition)
    {
        try
        {
            return condition();
        }
        catch (IOException)
        {
            return false;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    internal static T ReadJson<T>(string path)
    {
        // The writer replaces the file with an atomic move. Read with delete sharing so
        // observation never blocks that move, and retry briefly across the replacement.
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(5);
        while (true)
        {
            try
            {
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var reader = new StreamReader(stream);
                var text = reader.ReadToEnd();
                return JsonSerializer.Deserialize<T>(text, JsonOptions)
                    ?? throw new InvalidOperationException($"Fixture file '{path}' deserialized to null.");
            }
            catch (IOException) when (DateTime.UtcNow < deadline)
            {
                Thread.Sleep(25);
            }
        }
    }
}

/// <summary>Minimal assertion set that accumulates a scenario's failures.</summary>
internal sealed class Checks
{
    private readonly List<string> _failures = new();
    private readonly Dictionary<string, string> _evidence = new(StringComparer.Ordinal);

    internal IReadOnlyList<string> Failures => _failures;

    internal IReadOnlyDictionary<string, string> Evidence => _evidence;

    internal void Note(string name, string value) => _evidence[name] = value;

    internal void True(bool condition, string message)
    {
        if (!condition)
        {
            _failures.Add(message);
        }
    }

    internal void Equal<T>(T expected, T actual, string message)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            _failures.Add($"{message} (expected '{expected}', observed '{actual}')");
        }
    }

    internal void NotEmpty(string? value, string message) =>
        True(!string.IsNullOrWhiteSpace(value), message);

    internal void EmptyDirectory(string directory, string message)
    {
        var entries = Directory.EnumerateFileSystemEntries(directory).ToArray();
        True(entries.Length == 0, $"{message} (found: {string.Join(", ", entries.Select(Path.GetFileName))})");
    }
}

/// <summary>
/// The caller's approved synthetic environment policy. The library never reads the
/// ambient environment; this policy is frozen into the launch contract.
/// </summary>
internal static class EnvironmentPolicy
{
    internal const string MarkerName = "RAC_POLICY_MARKER";
    internal const string MarkerValue = "windows-launch-policy";

    internal static IReadOnlyDictionary<string, string> Minimal(string tempDirectory)
    {
        var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        if (string.IsNullOrWhiteSpace(windows))
        {
            throw new InvalidOperationException("The Windows directory is unavailable for the synthetic policy.");
        }

        Directory.CreateDirectory(tempDirectory);
        return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["SystemRoot"] = windows,
            [MarkerName] = MarkerValue,
            ["TEMP"] = tempDirectory,
            ["TMP"] = tempDirectory,
        };
    }
}

/// <summary>Starts another instance of the conformance runner (including supervisor mode).</summary>
internal static class SelfProcess
{
    internal static ProcessStartInfo CreateStartInfo()
    {
        var processPath = Environment.ProcessPath
            ?? throw new InvalidOperationException("The current executable path is unavailable.");
        var startInfo = new ProcessStartInfo(processPath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };

        if (string.Equals(Path.GetFileNameWithoutExtension(processPath), "dotnet", StringComparison.OrdinalIgnoreCase))
        {
            var entry = Assembly.GetEntryAssembly()?.Location;
            if (string.IsNullOrWhiteSpace(entry))
            {
                throw new InvalidOperationException("The runner assembly path is unavailable under the dotnet host.");
            }

            startInfo.ArgumentList.Add(entry);
        }

        return startInfo;
    }
}
