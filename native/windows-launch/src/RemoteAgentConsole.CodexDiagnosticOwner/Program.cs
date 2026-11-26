using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Threading.Tasks;
using RemoteAgentConsole.WindowsLaunch;

// Local witness only: no listener, owner IPC server, command selector, live home
// or production profile. Child stdout stays data; child stderr is discarded.
// The diagnostic owner's stderr is a separate, fixed ASCII control stream.
internal static class Program
{
    // ROG-14's installed 0.172.0 matched the official platform package byte for byte.
    private const string CodexDigest = "3F42B12274B353ECB3EC555E6C8D0A43F6C6CB29C3A546179BC12DEE4855DEB6";
    private const int MaxPayload = 1024 * 1024;
    private const int SegmentSize = 64 * 1024;
    private static readonly TimeSpan IoBound = TimeSpan.FromMilliseconds(200);

    public static async Task<int> Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess || args.Length != 2)
                return 2;
            return await Run(args[0], args[1]).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Never dump paths, configuration, protocol bytes or exception text.
            return 3;
        }
    }

    private static async Task<int> Run(string codex, string root)
    {
        if (!Path.IsPathFullyQualified(codex) || !Path.IsPathFullyQualified(root)
            || !string.Equals(Path.GetFileName(codex), "codex.exe", StringComparison.OrdinalIgnoreCase))
            return 2;

        // Retain a deny-write/delete file handle for this diagnostic launch. This
        // does not attest ancestor custody or qualify a production executable.
        using var image = new FileStream(codex, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (Convert.ToHexString(SHA256.HashData(image)) != CodexDigest) return 2;
        var project = Path.Combine(root, "project");
        var home = Path.Combine(root, "home");
        var temp = Path.Combine(root, "temp");
        if (!Directory.Exists(Path.Combine(project, ".git")) || !Directory.Exists(home)
            || !Directory.Exists(temp) || Directory.GetFileSystemEntries(home).Length != 0)
            return 2;

        var system = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["SystemRoot"] = system, ["WINDIR"] = system,
            ["PATH"] = Path.Combine(system, "System32"),
            ["CODEX_HOME"] = home, ["HOME"] = home, ["USERPROFILE"] = home,
            ["APPDATA"] = home, ["LOCALAPPDATA"] = home, ["TEMP"] = temp, ["TMP"] = temp,
            ["HTTP_PROXY"] = "http://127.0.0.1:1", ["HTTPS_PROXY"] = "http://127.0.0.1:1",
            ["ALL_PROXY"] = "http://127.0.0.1:1", ["NO_COLOR"] = "1",
        };
        var contract = LaunchContract.Create(codex, project,
            ["--disable", "plugins", "--disable", "apps", "--disable", "remote_plugin",
                "app-server", "--listen", "stdio://"], environment);

        using var owner = WindowsProcessOwner.Launch(contract, TimeSpan.FromSeconds(3), ChildStdioMode.CancelablePipes);
        var streams = owner.CancelableStreams ?? throw new InvalidOperationException();
        using var input = Console.OpenStandardInput();
        using var output = Console.OpenStandardOutput();
        Console.Error.WriteLine("R");
        var outbound = Task.Run(() => Pump(streams, output, error: false));
        var discard = Task.Run(() => Pump(streams, Stream.Null, error: true));
        var inbound = Task.Run(() => Receive(streams, input));
        // A reader or writer boundary can stop the session independently. Never
        // issue another write or mistake this for a provider terminal result.
        await Task.WhenAny(outbound, inbound).ConfigureAwait(false);
        var io = streams.Shutdown(TimeSpan.FromSeconds(3));
        var graceful = owner.TrySettle(TimeSpan.FromSeconds(1));
        var kill = graceful ? null : owner.KillAndSettle(TimeSpan.FromSeconds(3));
        var rootExited = graceful || kill?.RootExitConfirmed == true;
        var jobEmpty = graceful || kill?.JobEmptyConfirmed == true;
        // An outbound write to our caller is not part of the child's native I/O
        // receipt. A failed reader cannot keep the owner alive past this bound.
        var pumps = Task.WhenAll(outbound, discard);
        await Task.WhenAny(pumps, Task.Delay(1000)).ConfigureAwait(false);
        var inputOk = !inbound.IsCompleted || inbound.IsCompletedSuccessfully && inbound.Result;
        Console.Error.WriteLine(string.Create(CultureInfo.InvariantCulture,
            $"S {(rootExited ? 1 : 0)} {(jobEmpty ? 1 : 0)} {(io.Complete ? 1 : 0)} {io.SubmittedWrites}"));
        return rootExited && jobEmpty && io.Complete && inputOk && pumps.IsCompletedSuccessfully ? 0 : 4;
    }

    private static void Pump(CancelableChildStdio streams, Stream sink, bool error)
    {
        var buffer = new byte[16384];
        for (;;)
        {
            var result = error ? streams.ReadError(buffer, IoBound) : streams.ReadOutput(buffer, IoBound);
            if (result.Status == StdioIoStatus.TimedOut) continue;
            if (result.Status != StdioIoStatus.Completed) return;
            sink.Write(buffer, 0, result.BytesRead);
        }
    }

    private static async Task<bool> Receive(CancelableChildStdio streams, Stream source)
    {
        var header = new byte[4];
        var buffer = new byte[MaxPayload];
        for (;;)
        {
            var count = await source.ReadAtLeastAsync(header, header.Length, false).ConfigureAwait(false);
            if (count == 0) return true;
            var length = BinaryPrimitives.ReadInt32LittleEndian(header);
            if (count != header.Length || length is <= 0 or > MaxPayload)
                return false;
            await source.ReadExactlyAsync(buffer.AsMemory(0, length)).ConfigureAwait(false);
            if (buffer[length - 1] != (byte)'\n' || buffer.AsSpan(0, length - 1).Contains((byte)'\n'))
                return false;
            for (var offset = 0; offset < length;)
            {
                var slice = Math.Min(length - offset, SegmentSize);
                var result = streams.Send(buffer.AsSpan(offset, slice), TimeSpan.FromSeconds(2));
                if (result.Status != StdioIoStatus.Completed || result.BytesTransferred != slice)
                {
                    var knownUnsent = offset == 0 && result.Delivery == StdioDelivery.None
                        && (result.StopObservedBeforeSubmit || result.Status == StdioIoStatus.Backpressure);
                    Console.Error.WriteLine(knownUnsent ? "N" : "U");
                    return false;
                }
                offset += slice;
            }
            Console.Error.WriteLine("W");
        }
    }
}
