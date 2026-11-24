// Synthetic Windows process-tree witness used by the native ownership suite.
// It is a finite helper, not an agent and not a process-killing utility.
//
// Start `tree-root --witness-dir <private-test-directory>`, assign that PID to
// the owner under test, then create `release-tree` in the witness directory.
// Start a separate `peer --witness-dir <same-directory>` outside the owner's
// containment boundary. The peer and owned descendants all report role
// "worker"; PID plus UTC process start ticks distinguish their identities.
// Create `stop-tree` to exercise the root's exact-child cleanup, or terminate
// the root through the native owner to exercise OS process-tree containment.

#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading;

internal static class ProcessTreeFixture
{
    private static readonly TimeSpan MaxLifetime = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(100);

    private sealed record Identity(
        int SchemaVersion,
        string Role,
        string Instance,
        int ProcessId,
        long StartTimeUtcTicks,
        int? ParentProcessId,
        long? ParentStartTimeUtcTicks,
        string ExecutablePath);

    private sealed record Heartbeat(
        int SchemaVersion,
        string Role,
        string Instance,
        int ProcessId,
        long StartTimeUtcTicks,
        long HeartbeatUtcTicks,
        int Sequence);

    private sealed record ShutdownEvidence(
        int SchemaVersion,
        int RootProcessId,
        long RootStartTimeUtcTicks,
        int? ChildProcessId,
        long? ChildStartTimeUtcTicks,
        bool ChildIdentityMatched,
        bool ChildTreeSettled,
        string Result);

    public static int Main(string[] args)
    {
        try
        {
            var parsed = ParseArguments(args);
            var mode = parsed.Mode;
            var directory = Path.GetFullPath(parsed.Values["witness-dir"]);
            Directory.CreateDirectory(directory);

            if (mode == "tree-root" && Directory.EnumerateFileSystemEntries(directory).Any())
            {
                throw new InvalidOperationException("tree-root requires a fresh, empty witness directory");
            }

            return mode switch
            {
                "tree-root" => RunTreeRoot(directory),
                "peer" => RunWorker(directory, "unrelated-same-role", spawnGrandchild: false, parent: null),
                "worker" => RunWorker(directory, parsed.Values["instance"], parsed.SpawnGrandchild, parsed.Parent),
                _ => UsageError($"Unsupported fixture mode: {mode}"),
            };
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"PROCESS_TREE_FIXTURE_ERROR {error.GetType().Name}: {error.Message}");
            return 2;
        }
    }

    private static int RunTreeRoot(string directory)
    {
        var root = CurrentIdentity("tree-root", "owned-root", parent: null);
        WriteNewJson(Path.Combine(directory, "owned-root.json"), root);

        using Process self = Process.GetCurrentProcess();
        var deadline = DateTime.UtcNow + MaxLifetime;
        Process? child = null;
        Identity? childIdentity = null;
        string result = "root-timeout-before-release";

        try
        {
            while (DateTime.UtcNow < deadline && !File.Exists(Path.Combine(directory, "stop-tree")))
            {
                if (File.Exists(Path.Combine(directory, "release-tree")))
                {
                    child = StartSelf(directory,
                        "worker",
                        "--instance", "owned-child",
                        "--parent-pid", root.ProcessId.ToString(),
                        "--parent-start-ticks", root.StartTimeUtcTicks.ToString(),
                        "--spawn-grandchild");
                    childIdentity = WaitForIdentity(Path.Combine(directory, "owned-child.json"), child, TimeSpan.FromSeconds(10));
                    WaitForFile(Path.Combine(directory, "owned-descendants.json"), TimeSpan.FromSeconds(10));
                    WriteJson(Path.Combine(directory, "owned-tree.json"), new
                    {
                        schemaVersion = 1,
                        root = root,
                        child = childIdentity,
                        unrelatedInstance = "unrelated-same-role",
                    });
                    result = "owned-tree-running";
                    WaitForStopOrDeadline(directory, deadline);
                    result = File.Exists(Path.Combine(directory, "stop-tree"))
                        ? "shutdown-requested"
                        : "root-lifetime-expired";
                    break;
                }
                Thread.Sleep(PollInterval);
            }
        }
        finally
        {
            bool identityMatched = false;
            bool settled = child is null;
            if (child is not null && childIdentity is not null)
            {
                identityMatched = HasExactIdentity(child, childIdentity.StartTimeUtcTicks);
                if (identityMatched)
                {
                    child.Kill(entireProcessTree: true);
                    settled = WaitForOwnedTreeExit(childIdentity, directory, TimeSpan.FromSeconds(5));
                }
            }

            WriteJson(Path.Combine(directory, "shutdown.json"), new ShutdownEvidence(
                SchemaVersion: 1,
                RootProcessId: self.Id,
                RootStartTimeUtcTicks: self.StartTime.ToUniversalTime().Ticks,
                ChildProcessId: child?.Id,
                ChildStartTimeUtcTicks: childIdentity?.StartTimeUtcTicks,
                ChildIdentityMatched: identityMatched,
                ChildTreeSettled: settled,
                Result: !identityMatched && child is not null
                    ? "child-identity-mismatch-left-running"
                    : settled ? result : "owned-child-tree-did-not-settle"));
            child?.Dispose();
        }

        var shutdown = JsonSerializer.Deserialize<ShutdownEvidence>(File.ReadAllText(Path.Combine(directory, "shutdown.json")));
        return shutdown?.ChildTreeSettled == true && shutdown.Result != "root-timeout-before-release" ? 0 : 3;
    }

    private static int RunWorker(string directory, string instance, bool spawnGrandchild, Identity? parent)
    {
        if (string.IsNullOrWhiteSpace(instance))
        {
            return UsageError("worker mode requires --instance");
        }

        var identity = CurrentIdentity("worker", instance, parent);
        WriteNewJson(Path.Combine(directory, $"{instance}.json"), identity);
        using Process self = Process.GetCurrentProcess();
        Process? grandchild = null;
        Identity? grandchildIdentity = null;

        try
        {
            if (spawnGrandchild)
            {
                grandchild = StartSelf(directory,
                    "worker",
                    "--instance", "owned-grandchild",
                    "--parent-pid", identity.ProcessId.ToString(),
                    "--parent-start-ticks", identity.StartTimeUtcTicks.ToString());
                grandchildIdentity = WaitForIdentity(
                    Path.Combine(directory, "owned-grandchild.json"), grandchild, TimeSpan.FromSeconds(10));
                WriteJson(Path.Combine(directory, "owned-descendants.json"), new
                {
                    schemaVersion = 1,
                    child = identity,
                    grandchild = grandchildIdentity,
                });
            }

            var deadline = DateTime.UtcNow + MaxLifetime;
            var sequence = 0;
            var heartbeatPath = Path.Combine(directory, $"{instance}.heartbeat.json");
            while (DateTime.UtcNow < deadline && !File.Exists(Path.Combine(directory, $"{instance}.stop")))
            {
                WriteJson(heartbeatPath, new Heartbeat(
                    SchemaVersion: 1,
                    Role: identity.Role,
                    Instance: identity.Instance,
                    ProcessId: identity.ProcessId,
                    StartTimeUtcTicks: identity.StartTimeUtcTicks,
                    HeartbeatUtcTicks: DateTime.UtcNow.Ticks,
                    Sequence: sequence++));
                Thread.Sleep(PollInterval);
            }
        }
        finally
        {
            if (grandchild is not null && grandchildIdentity is not null
                && HasExactIdentity(grandchild, grandchildIdentity.StartTimeUtcTicks))
            {
                grandchild.Kill(entireProcessTree: true);
                grandchild.WaitForExit(milliseconds: 5_000);
            }
            grandchild?.Dispose();
        }

        return 0;
    }

    private static void WaitForStopOrDeadline(string directory, DateTime deadline)
    {
        while (DateTime.UtcNow < deadline && !File.Exists(Path.Combine(directory, "stop-tree")))
        {
            Thread.Sleep(PollInterval);
        }
    }

    private static void WaitForFile(string path, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (File.Exists(path)) return;
            Thread.Sleep(PollInterval);
        }
        throw new TimeoutException($"Fixture did not publish {Path.GetFileName(path)} within {timeout.TotalSeconds:0} seconds");
    }

    private static Process StartSelf(string directory, string mode, params string[] extraArguments)
    {
        var start = CreateSelfStartInfo();
        start.ArgumentList.Add(mode);
        start.ArgumentList.Add("--witness-dir");
        start.ArgumentList.Add(directory);
        foreach (var argument in extraArguments)
        {
            start.ArgumentList.Add(argument);
        }

        var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start fixture child");
        return process;
    }

    private static ProcessStartInfo CreateSelfStartInfo()
    {
        var processPath = Environment.ProcessPath
            ?? throw new InvalidOperationException("The current executable path is unavailable");
        var entryPath = Assembly.GetEntryAssembly()?.Location;
        var isDotnetHost = string.Equals(Path.GetFileNameWithoutExtension(processPath), "dotnet", StringComparison.OrdinalIgnoreCase);
        var start = new ProcessStartInfo(processPath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        if (isDotnetHost)
        {
            if (string.IsNullOrWhiteSpace(entryPath))
            {
                throw new InvalidOperationException("The fixture assembly path is unavailable under dotnet host");
            }
            start.ArgumentList.Add(entryPath);
        }
        return start;
    }

    private static Identity WaitForIdentity(string path, Process process, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (process.HasExited)
            {
                throw new InvalidOperationException($"Fixture child exited before publishing {Path.GetFileName(path)}");
            }
            if (File.Exists(path))
            {
                var identity = JsonSerializer.Deserialize<Identity>(File.ReadAllText(path));
                if (identity is not null && identity.ProcessId == process.Id
                    && HasExactIdentity(process, identity.StartTimeUtcTicks))
                {
                    return identity;
                }
            }
            Thread.Sleep(PollInterval);
        }
        throw new TimeoutException($"Fixture did not publish identity within {timeout.TotalSeconds:0} seconds");
    }

    private static Identity CurrentIdentity(string role, string instance, Identity? parent)
    {
        using Process self = Process.GetCurrentProcess();
        return new Identity(
            SchemaVersion: 1,
            Role: role,
            Instance: instance,
            ProcessId: self.Id,
            StartTimeUtcTicks: self.StartTime.ToUniversalTime().Ticks,
            ParentProcessId: parent?.ProcessId,
            ParentStartTimeUtcTicks: parent?.StartTimeUtcTicks,
            ExecutablePath: Environment.ProcessPath ?? string.Empty);
    }

    private static bool HasExactIdentity(Process process, long expectedStartTicks)
    {
        try
        {
            return !process.HasExited && process.StartTime.ToUniversalTime().Ticks == expectedStartTicks;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    private static bool WaitForOwnedTreeExit(Identity child, string directory, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        var descendantPath = Path.Combine(directory, "owned-grandchild.json");
        Identity? descendant = null;
        while (DateTime.UtcNow < deadline)
        {
            if (descendant is null && File.Exists(descendantPath))
            {
                descendant = JsonSerializer.Deserialize<Identity>(File.ReadAllText(descendantPath));
            }

            var childAlive = IsExactIdentityAlive(child.ProcessId, child.StartTimeUtcTicks);
            var descendantAlive = descendant is null
                ? File.Exists(Path.Combine(directory, "owned-descendants.json"))
                : IsExactIdentityAlive(descendant.ProcessId, descendant.StartTimeUtcTicks);
            if (childAlive == false && descendantAlive == false) return true;
            if (childAlive is null || descendantAlive is null) return false;
            Thread.Sleep(PollInterval);
        }
        return false;
    }

    private static bool? IsExactIdentityAlive(int processId, long expectedStartTicks)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            if (process.HasExited) return false;
            return process.StartTime.ToUniversalTime().Ticks == expectedStartTicks;
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
            return null;
        }
    }

    private static void WriteJson<T>(string path, T value)
    {
        var temporary = $"{path}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temporary, path, overwrite: true);
    }

    private static void WriteNewJson<T>(string path, T value)
    {
        var temporary = $"{path}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temporary, path, overwrite: false);
    }

    private sealed record ParsedArguments(string Mode, Dictionary<string, string> Values, bool SpawnGrandchild, Identity? Parent);

    private static ParsedArguments ParseArguments(string[] args)
    {
        if (args.Length == 0)
        {
            throw new ArgumentException("A fixture mode is required");
        }

        var mode = args[0];
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var spawnGrandchild = false;
        var parentPid = (int?)null;
        var parentStartTicks = (long?)null;
        for (var index = 1; index < args.Length; index++)
        {
            var option = args[index];
            if (option == "--spawn-grandchild")
            {
                spawnGrandchild = true;
                continue;
            }
            if (!option.StartsWith("--", StringComparison.Ordinal) || index + 1 >= args.Length)
            {
                throw new ArgumentException($"Invalid option: {option}");
            }
            var key = option[2..];
            if (!new[] { "witness-dir", "instance", "parent-pid", "parent-start-ticks" }
                .Contains(key, StringComparer.OrdinalIgnoreCase))
            {
                throw new ArgumentException($"Unsupported option: {option}");
            }
            var value = args[++index];
            if (!values.TryAdd(key, value))
            {
                throw new ArgumentException($"Duplicate option: {option}");
            }
            if (key.Equals("parent-pid", StringComparison.OrdinalIgnoreCase))
            {
                parentPid = int.Parse(value);
            }
            else if (key.Equals("parent-start-ticks", StringComparison.OrdinalIgnoreCase))
            {
                parentStartTicks = long.Parse(value);
            }
        }

        if (!values.ContainsKey("witness-dir"))
        {
            throw new ArgumentException("--witness-dir is required");
        }
        if (parentPid.HasValue != parentStartTicks.HasValue)
        {
            throw new ArgumentException("Parent PID and parent start time must be supplied together");
        }

        Identity? parent = parentPid.HasValue && parentStartTicks.HasValue
            ? ReadParentIdentity(parentPid.Value, parentStartTicks.Value)
            : null;
        return new ParsedArguments(mode, values, spawnGrandchild, parent);
    }

    private static Identity? ReadParentIdentity(int processId, long startTicks)
    {
        try
        {
            using var parent = Process.GetProcessById(processId);
            if (parent.StartTime.ToUniversalTime().Ticks != startTicks)
            {
                throw new InvalidOperationException("Parent PID was reused before fixture launch");
            }
            return new Identity(
                SchemaVersion: 1,
                Role: "worker",
                Instance: "parent",
                ProcessId: processId,
                StartTimeUtcTicks: startTicks,
                ParentProcessId: null,
                ParentStartTimeUtcTicks: null,
                ExecutablePath: parent.MainModule?.FileName ?? string.Empty);
        }
        catch (ArgumentException error)
        {
            throw new InvalidOperationException("Fixture parent process no longer exists", error);
        }
    }

    private static int UsageError(string message)
    {
        Console.Error.WriteLine($"PROCESS_TREE_FIXTURE_USAGE {message}");
        return 2;
    }
}
