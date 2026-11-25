#nullable enable

using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace RemoteAgentConsole.WindowsLaunch.StdioProbe;

/// <summary>
/// Harmless synthetic child for bounded pipe custody tests. It performs one fixed ASCII
/// request/response, writes a distinct stderr marker, handles EOF, and reports whether
/// an unrelated inheritable sentinel handle leaked into this process. It is not an agent.
/// </summary>
internal static class StdioProbe
{
    public static int Main(string[] args)
    {
        string? sentinelOutput = null;
        var sentinelHandle = 0L;
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
                default:
                    Console.Error.WriteLine("STDIO_PROBE_USAGE [--sentinel-out <path> --sentinel-handle <decimal>]");
                    return 2;
            }
        }

        try
        {
            if (!string.IsNullOrWhiteSpace(sentinelOutput))
            {
                var present = sentinelHandle != 0
                    && GetHandleInformation((IntPtr)sentinelHandle, out _);
                var directory = Path.GetDirectoryName(sentinelOutput);
                if (!string.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                File.WriteAllText(sentinelOutput, present ? "present" : "absent", Encoding.ASCII);
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

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetHandleInformation(IntPtr handle, out uint flags);
}
