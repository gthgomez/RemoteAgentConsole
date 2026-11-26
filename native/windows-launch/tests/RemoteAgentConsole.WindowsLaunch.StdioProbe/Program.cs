#nullable enable

using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace RemoteAgentConsole.WindowsLaunch.StdioProbe;

/// <summary>
/// Harmless synthetic child for bounded pipe custody tests. It performs one fixed ASCII
/// request/response, writes a distinct stderr marker, handles EOF, and reports whether
/// an unrelated inheritable sentinel handle leaked into this process. Additional modes
/// stay silent or deliberately do not read stdin so the parent can observe a pending
/// native read or write. It is not an agent.
/// </summary>
internal static class StdioProbe
{
    public static int Main(string[] args)
    {
        string? sentinelOutput = null;
        string? sentinelPath = null;
        string? startedWitness = null;
        var sentinelHandle = 0L;
        var mode = "echo";
        var silentMilliseconds = 2500;
        var stayMilliseconds = 5000;
        var marker = "LATE";
        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--sentinel-out" when index + 1 < args.Length:
                    sentinelOutput = Path.GetFullPath(args[++index]);
                    break;
                case "--sentinel-handle" when index + 1 < args.Length:
                    sentinelHandle = long.Parse(args[++index], CultureInfo.InvariantCulture);
                    break;
                case "--sentinel-path" when index + 1 < args.Length:
                    sentinelPath = Path.GetFullPath(args[++index]);
                    break;
                case "--mode" when index + 1 < args.Length:
                    mode = args[++index];
                    break;
                case "--started-witness" when index + 1 < args.Length:
                    startedWitness = Path.GetFullPath(args[++index]);
                    break;
                case "--silent-ms" when index + 1 < args.Length:
                    silentMilliseconds = int.Parse(args[++index], CultureInfo.InvariantCulture);
                    break;
                case "--stay-ms" when index + 1 < args.Length:
                    stayMilliseconds = int.Parse(args[++index], CultureInfo.InvariantCulture);
                    break;
                case "--marker" when index + 1 < args.Length:
                    marker = args[++index];
                    break;
                default:
                    Console.Error.WriteLine(
                        "STDIO_PROBE_USAGE [--mode echo|silent|no-read] [--silent-ms n] [--stay-ms n] [--marker text] [--sentinel-out <path> --sentinel-handle <decimal> [--sentinel-path <path>]]");
                    return 2;
            }
        }

        try
        {
            if (startedWitness is not null)
            {
                File.WriteAllText(startedWitness, "entered-main", Encoding.ASCII);
            }
            if (!string.IsNullOrWhiteSpace(sentinelOutput))
            {
                // A numeric handle check can collide with an unrelated child handle (for
                // example an inherited pipe). When a sentinel path is supplied, resolve the
                // handle's actual object path and compare it: a pipe or other colliding
                // handle cannot masquerade as the inherited sentinel file, and the inherited
                // sentinel file cannot masquerade as absent.
                var present = sentinelHandle != 0
                    && (!string.IsNullOrWhiteSpace(sentinelPath)
                        ? IsHandleToPath((IntPtr)sentinelHandle, sentinelPath)
                        : GetHandleInformation((IntPtr)sentinelHandle, out _));
                var directory = Path.GetDirectoryName(sentinelOutput);
                if (!string.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                File.WriteAllText(sentinelOutput, present ? "present" : "absent", Encoding.ASCII);
            }

            if (mode == "silent")
            {
                // Never read stdin and stay quiet on both streams for the requested span,
                // so the parent can observe a native read that is genuinely pending while
                // this process is still alive.
                Thread.Sleep(Math.Max(silentMilliseconds, 0));
                using var lateOutput = new StreamWriter(Console.OpenStandardOutput(), Encoding.ASCII)
                {
                    AutoFlush = true,
                    NewLine = "\n",
                };
                lateOutput.WriteLine(marker);
                return 0;
            }

            if (mode == "no-read")
            {
                // Announce liveness, then never read stdin. A parent write larger than the
                // pipe buffer stays pending until it is cancelled.
                using var readyOutput = new StreamWriter(Console.OpenStandardOutput(), Encoding.ASCII)
                {
                    AutoFlush = true,
                    NewLine = "\n",
                };
                readyOutput.WriteLine("READY");
                Thread.Sleep(Math.Max(stayMilliseconds, 0));
                return 0;
            }

            if (!string.Equals(mode, "echo", StringComparison.Ordinal))
            {
                Console.Error.WriteLine($"STDIO_PROBE_UNKNOWN_MODE {mode}");
                return 2;
            }

            using var input = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
            using var output = new StreamWriter(Console.OpenStandardOutput(), Encoding.ASCII)
            {
                AutoFlush = true,
                NewLine = "\n",
            };
            using var error = new StreamWriter(Console.OpenStandardError(), Encoding.ASCII)
            {
                AutoFlush = true,
                NewLine = "\n",
            };

            while (true)
            {
                var line = input.ReadLine();
                if (line is null)
                {
                    output.WriteLine("EOF");
                    return 0;
                }

                if (line.Length > 128)
                {
                    error.WriteLine("TOO-LONG");
                    return 2;
                }

                if (line == "PING")
                {
                    output.WriteLine("PONG");
                    error.WriteLine("STDERR-MARKER");
                    continue;
                }

                if (line == "BYE")
                {
                    output.WriteLine("BYE-OK");
                    return 0;
                }

                error.WriteLine("UNKNOWN");
                return 2;
            }
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"STDIO_PROBE_ERROR {exception.GetType().Name}: {exception.Message}");
            return 2;
        }
    }

    private static bool IsHandleToPath(IntPtr handle, string expectedPath)
    {
        var buffer = new StringBuilder(1024);
        var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity)
        {
            return false;
        }

        static string Normalize(string value) =>
            value.StartsWith(@"\\?\ ", StringComparison.Ordinal)
                ? value.Substring(4)
                : value.StartsWith(@"\\?", StringComparison.Ordinal)
                    ? value.Substring(4)
                    : value;

        return string.Equals(
            Normalize(buffer.ToString()),
            Normalize(Path.GetFullPath(expectedPath)),
            StringComparison.OrdinalIgnoreCase);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetHandleInformation(IntPtr handle, out uint flags);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint GetFinalPathNameByHandleW(
        IntPtr handle,
        StringBuilder path,
        uint pathLength,
        uint flags);
}
