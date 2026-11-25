#nullable enable

using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RemoteAgentConsole.WindowsLaunch;

/// <summary>
/// One anonymous-pipe set for a child's stdin/stdout/stderr. Child ends are made
/// inheritable only for the create call and are closed in the parent immediately after
/// the process exists. Parent ends are never inheritable.
/// </summary>
internal sealed class StdioPipes : IDisposable
{
    /// <summary>
    /// Serializes pipe-enabled launches in this OS process across the bounded interval
    /// in which inheritable child ends and the explicit handle list exist. Other
    /// process-spawning code must not run concurrently in a dedicated owner launcher.
    /// </summary>
    internal static object InheritanceWindow { get; } = new();

    private SafeFileHandle? _childStdinRead;
    private SafeFileHandle? _childStdoutWrite;
    private SafeFileHandle? _childStderrWrite;
    private SafeFileHandle? _parentStdinWrite;
    private SafeFileHandle? _parentStdoutRead;
    private SafeFileHandle? _parentStderrRead;
    private bool _disposed;

    private StdioPipes()
    {
    }

    internal IntPtr[] ChildHandles { get; private set; } = Array.Empty<IntPtr>();

    internal static StdioPipes Create()
    {
        var pipes = new StdioPipes();
        try
        {
            var stdin = CreatePipe(childReads: true);
            pipes._childStdinRead = stdin.Child;
            pipes._parentStdinWrite = stdin.Parent;

            var stdout = CreatePipe(childReads: false);
            pipes._childStdoutWrite = stdout.Child;
            pipes._parentStdoutRead = stdout.Parent;

            var stderr = CreatePipe(childReads: false);
            pipes._childStderrWrite = stderr.Child;
            pipes._parentStderrRead = stderr.Parent;

            pipes.ChildHandles = new[]
            {
                pipes._childStdinRead.DangerousGetHandle(),
                pipes._childStdoutWrite.DangerousGetHandle(),
                pipes._childStderrWrite.DangerousGetHandle(),
            };

            return pipes;
        }
        catch
        {
            pipes.Dispose();
            throw;
        }
    }

    internal ChildStandardStreams CreateParentStreams()
    {
        FileStream? standardInput = null;
        FileStream? standardOutput = null;
        FileStream? standardError = null;
        try
        {
            // FileStream takes ownership of each parent safe handle.
            standardInput = new FileStream(_parentStdinWrite!, FileAccess.Write, bufferSize: 4096, isAsync: false);
            _parentStdinWrite = null;
            standardOutput = new FileStream(_parentStdoutRead!, FileAccess.Read, bufferSize: 4096, isAsync: false);
            _parentStdoutRead = null;
            standardError = new FileStream(_parentStderrRead!, FileAccess.Read, bufferSize: 4096, isAsync: false);
            _parentStderrRead = null;
            return new ChildStandardStreams(standardInput, standardOutput, standardError);
        }
        catch
        {
            standardInput?.Dispose();
            standardOutput?.Dispose();
            standardError?.Dispose();
            throw;
        }
    }

    internal void CloseChildEnds()
    {
        _childStdinRead?.Dispose();
        _childStdinRead = null;
        _childStdoutWrite?.Dispose();
        _childStdoutWrite = null;
        _childStderrWrite?.Dispose();
        _childStderrWrite = null;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        CloseChildEnds();
        _parentStdinWrite?.Dispose();
        _parentStdinWrite = null;
        _parentStdoutRead?.Dispose();
        _parentStdoutRead = null;
        _parentStderrRead?.Dispose();
        _parentStderrRead = null;
    }

    private static (SafeFileHandle Child, SafeFileHandle Parent) CreatePipe(bool childReads)
    {
        var attributes = new NativeMethods.SecurityAttributes
        {
            Length = Marshal.SizeOf<NativeMethods.SecurityAttributes>(),
            InheritHandle = 0,
        };

        if (!NativeMethods.CreatePipe(out var readHandle, out var writeHandle, ref attributes, 0))
        {
            throw new LaunchFailureException(
                LaunchStage.CreateStdio,
                Marshal.GetLastWin32Error(),
                "CreatePipe failed; no process was created and no unguarded inheritance was attempted.");
        }

        SafeFileHandle? read = null;
        SafeFileHandle? write = null;
        try
        {
            read = new SafeFileHandle(readHandle, ownsHandle: true);
            write = new SafeFileHandle(writeHandle, ownsHandle: true);
            var child = childReads ? read : write;
            var parent = childReads ? write : read;

            if (!NativeMethods.SetHandleInformation(child, NativeMethods.HandleFlagInherit, NativeMethods.HandleFlagInherit))
            {
                throw new LaunchFailureException(
                    LaunchStage.CreateStdio,
                    Marshal.GetLastWin32Error(),
                    "SetHandleInformation(child inheritable) failed; the pipe was closed.");
            }

            if (!NativeMethods.SetHandleInformation(parent, NativeMethods.HandleFlagInherit, 0))
            {
                throw new LaunchFailureException(
                    LaunchStage.CreateStdio,
                    Marshal.GetLastWin32Error(),
                    "SetHandleInformation(parent non-inheritable) failed; the pipe was closed.");
            }

            return (child, parent);
        }
        catch
        {
            if (read is not null)
            {
                read.Dispose();
            }
            else
            {
                _ = NativeMethods.CloseHandle(readHandle);
            }

            if (write is not null)
            {
                write.Dispose();
            }
            else
            {
                _ = NativeMethods.CloseHandle(writeHandle);
            }

            throw;
        }
    }
}
