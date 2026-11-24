#nullable enable

using System;
using System.IO;
using System.Threading;

namespace RemoteAgentConsole.WindowsLaunch;

/// <summary>Optional standard-stream custody for a launched child.</summary>
public enum ChildStdioMode
{
    /// <summary>No standard handles are wired and no handles are inherited (default).</summary>
    None = 0,

    /// <summary>
    /// Create exactly one stdin, stdout and stderr pipe. The child receives only those
    /// three explicit handles through <c>PROC_THREAD_ATTRIBUTE_HANDLE_LIST</c>.
    /// </summary>
    Pipes = 1,
}

/// <summary>
/// Parent-side custody of a child's standard streams. The standard input stream is
/// writable by the parent; output and error streams are readable. Output and error are
/// always distinct pipes and are never merged.
/// </summary>
public sealed class ChildStandardStreams : IDisposable
{
    private int _disposed;

    internal ChildStandardStreams(Stream standardInput, Stream standardOutput, Stream standardError)
    {
        StandardInput = standardInput;
        StandardOutput = standardOutput;
        StandardError = standardError;
    }

    /// <summary>
    /// Writable parent end for the child's stdin. Closing/disposing it delivers EOF;
    /// graceful shutdown is EOF, bounded wait/settlement, then owner/stream disposal.
    /// </summary>
    public Stream StandardInput { get; }

    /// <summary>Readable parent end for the child's stdout.</summary>
    public Stream StandardOutput { get; }

    /// <summary>Readable parent end for the child's stderr. Never merged with stdout.</summary>
    public Stream StandardError { get; }

    /// <summary>Closes all three parent-side pipe handles.</summary>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        try
        {
            StandardInput.Dispose();
        }
        finally
        {
            try
            {
                StandardOutput.Dispose();
            }
            finally
            {
                StandardError.Dispose();
            }
        }
    }
}
