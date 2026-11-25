#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace RemoteAgentConsole.WindowsLaunch;

/// <summary>
/// One private local named-pipe pair for cancelable stdio. The parent end is opened with
/// <c>FILE_FLAG_OVERLAPPED</c>; the child end is a synchronous, inheritable client handle
/// that the child uses like any standard pipe. The pipe name is a fresh unpredictable
/// <see cref="Guid"/>, the create call uses <c>FILE_FLAG_FIRST_PIPE_INSTANCE</c>, the DACL
/// is protected and grants only the current process user, exactly one instance exists, and
/// <c>PIPE_REJECT_REMOTE_CLIENTS</c> is set. The controlled parent process opens the only
/// client handle before handoff and verifies the exact connected peer and roles with
/// <c>GetNamedPipeInfo</c>, <c>GetNamedPipeClientProcessId</c> and
/// <c>GetNamedPipeServerProcessId</c>; a GUID, DACL or role string alone is not accepted as
/// proof. Any failure is fatal for the launch; there is no anonymous-pipe or inherit-all
/// fallback.
/// </summary>
internal sealed class CancelableStdioPipe : IDisposable
{
    /// <summary>
    /// Small, explicit pipe buffer. A send larger than this cannot complete while the
    /// child is not reading, which is what makes pending I/O observable.
    /// </summary>
    internal const uint PipeBufferSize = 4096;

    private SafeFileHandle? _parent;
    private SafeFileHandle? _child;
    private bool _disposed;

    private CancelableStdioPipe(SafeFileHandle parent, SafeFileHandle child, bool parentWrites)
    {
        _parent = parent;
        _child = child;
        ParentWrites = parentWrites;
    }

    internal bool ParentWrites { get; }

    internal IntPtr ChildHandle =>
        (_child ?? throw new InvalidOperationException("The child pipe handle was already closed."))
        .DangerousGetHandle();

    internal SafeFileHandle TakeParentHandle()
    {
        var parent = _parent ?? throw new InvalidOperationException("The parent pipe handle was already transferred.");
        _parent = null;
        return parent;
    }

    internal void CloseChildEnd()
    {
        _child?.Dispose();
        _child = null;
    }

    internal static CancelableStdioPipe Create(bool parentWrites)
    {
        var sid = WindowsIdentity.GetCurrent().User?.Value;
        if (string.IsNullOrWhiteSpace(sid))
        {
            throw Failure(
                0,
                "The current process user SID is unavailable, so a narrow pipe DACL cannot be built.");
        }

        if (!NativeMethods.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                "D:P(A;;GA;;;" + sid + ")",
                NativeMethods.SddlRevision1,
                out var descriptor,
                out _))
        {
            throw Failure(
                Marshal.GetLastWin32Error(),
                "ConvertStringSecurityDescriptorToSecurityDescriptorW failed; no pipe was created.");
        }

        try
        {
            var name = @"\\.\pipe\rac-windows-launch-" + Guid.NewGuid().ToString("N");
            var serverAttributes = new NativeMethods.SecurityAttributes
            {
                Length = Marshal.SizeOf<NativeMethods.SecurityAttributes>(),
                SecurityDescriptor = descriptor,
                InheritHandle = 0,
            };

            // FILE_FLAG_OVERLAPPED makes only the parent end cancelable/overlapped.
            // FILE_FLAG_FIRST_PIPE_INSTANCE fails the create if any instance of this
            // unpredictable name already exists; PIPE_REJECT_REMOTE_CLIENTS and one
            // maximum instance bound the endpoint. The server handle is duplex so
            // GetNamedPipeInfo/GetNamedPipe*ProcessId can verify both end roles (the
            // parent still uses only the one direction the channel needs, and the child
            // client handle is opened with only the data access it needs).
            var openMode = NativeMethods.PipeAccessDuplex
                | NativeMethods.FileFlagOverlapped
                | NativeMethods.FileFlagFirstPipeInstance;
            var pipeMode = NativeMethods.PipeTypeByte
                | NativeMethods.PipeReadmodeByte
                | NativeMethods.PipeWait
                | NativeMethods.PipeRejectRemoteClients;

            var parent = NativeMethods.CreateNamedPipeW(
                name,
                openMode,
                pipeMode,
                maximumInstances: 1,
                PipeBufferSize,
                PipeBufferSize,
                defaultTimeout: 0,
                ref serverAttributes);
            if (parent.IsInvalid)
            {
                throw Failure(
                    Marshal.GetLastWin32Error(),
                    "CreateNamedPipeW failed; no process was created and no anonymous-pipe fallback is attempted.");
            }

            SafeFileHandle? child = null;
            try
            {
                var clientAttributes = new NativeMethods.SecurityAttributes
                {
                    Length = Marshal.SizeOf<NativeMethods.SecurityAttributes>(),
                    SecurityDescriptor = descriptor,
                    InheritHandle = 1,
                };

                // The parent opens the sole client handle. nMaxInstances=1 then guarantees
                // that no other client can connect, and the DACL denies every other user.
                child = NativeMethods.CreateFileW(
                    name,
                    (parentWrites ? NativeMethods.GenericRead : NativeMethods.GenericWrite)
                        | NativeMethods.FileReadAttributes,
                    shareMode: 0,
                    ref clientAttributes,
                    NativeMethods.OpenExisting,
                    flagsAndAttributes: 0,
                    IntPtr.Zero);
                if (child.IsInvalid)
                {
                    throw Failure(
                        Marshal.GetLastWin32Error(),
                        "CreateFileW on the private pipe failed; no process was created.");
                }

                if (!NativeMethods.SetHandleInformation(child, NativeMethods.HandleFlagInherit, NativeMethods.HandleFlagInherit))
                {
                    throw Failure(
                        Marshal.GetLastWin32Error(),
                        "SetHandleInformation(child pipe inheritable) failed; the pipe was closed.");
                }

                if (!NativeMethods.SetHandleInformation(parent, NativeMethods.HandleFlagInherit, 0))
                {
                    throw Failure(
                        Marshal.GetLastWin32Error(),
                        "SetHandleInformation(parent pipe non-inheritable) failed; the pipe was closed.");
                }

                Connect(parent);
                VerifyPeerBinding(parent, child);

                var pair = new CancelableStdioPipe(parent, child, parentWrites);
                parent = null!;
                child = null;
                return pair;
            }
            finally
            {
                child?.Dispose();
                parent?.Dispose();
            }
        }
        finally
        {
            _ = NativeMethods.LocalFree(descriptor);
        }
    }

    /// <summary>
    /// The parent already opened the only client handle, so ConnectNamedPipe observes
    /// <c>ERROR_PIPE_CONNECTED</c> without submitting I/O. If the OS still reports a pending
    /// connect, this path cancels the exact operation and harvests it; if it still does not
    /// settle, the pending allocation is retained (never freed) and the launch fails closed.
    /// </summary>
    private static void Connect(SafeFileHandle parent)
    {
        var connect = new PendingOverlappedIo(1);
        try
        {
            if (NativeMethods.ConnectNamedPipe(parent, connect.Overlapped))
            {
                connect.MarkSubmitted();
                connect.MarkCompleted();
                return;
            }

            var error = Marshal.GetLastWin32Error();
            if (error == NativeMethods.ErrorPipeConnected)
            {
                // The sole client was already connected; no pending operation was submitted.
                return;
            }

            if (error != NativeMethods.ErrorIoPending)
            {
                throw Failure(
                    error,
                    "ConnectNamedPipe failed for the private pipe; the launch fails closed.");
            }

            connect.MarkSubmitted();

            bool signaled;
            try
            {
                signaled = connect.Completion.WaitOne(2000);
            }
            catch (ObjectDisposedException)
            {
                signaled = false;
            }

            if (!signaled)
            {
                var cancelError = 0;
                try
                {
                    if (!NativeMethods.CancelIoEx(parent, connect.Overlapped))
                    {
                        cancelError = Marshal.GetLastWin32Error();
                    }
                }
                catch (ObjectDisposedException)
                {
                    cancelError = NativeMethods.ErrorInvalidHandle;
                }

                try
                {
                    signaled = connect.Completion.WaitOne(2000);
                }
                catch (ObjectDisposedException)
                {
                    signaled = false;
                }

                if (!signaled)
                {
                    connect.Abandon();
                    throw Failure(
                        cancelError == 0 ? NativeMethods.ErrorSemTimeout : cancelError,
                        "The private pipe connect did not settle; the pending OVERLAPPED and event were retained and the launch fails closed.");
                }
            }

            try
            {
                if (NativeMethods.GetOverlappedResult(parent, connect.Overlapped, out _, wait: false))
                {
                    connect.MarkCompleted();
                    return;
                }

                var resultError = Marshal.GetLastWin32Error();
                if (resultError == NativeMethods.ErrorPipeConnected
                    || resultError == NativeMethods.ErrorOperationAborted)
                {
                    connect.MarkCompleted();
                    throw Failure(
                        resultError,
                        "The private pipe connect completed with a connection/abort result; the launch fails closed.");
                }

                // IO_INCOMPLETE, invalid handle or any other connect failure is not
                // positive proof of completion. Leave the operation unmarked so the
                // finally retains its allocation instead of freeing it.
                throw Failure(
                    resultError,
                    "The private pipe connect did not prove completion; the pending allocation is retained and the launch fails closed.");
            }
            catch (ObjectDisposedException)
            {
                throw Failure(
                    NativeMethods.ErrorInvalidHandle,
                    "The private pipe connect handle was closed before completion was proven; the allocation is retained and the launch fails closed.");
            }
        }
        finally
        {
            // No-op when the pending operation was retained.
            connect.Dispose();
        }
    }

    /// <summary>
    /// Verifies the exact peer and end roles of the pair before the child handle is handed
    /// off. Both halves were opened by this controlled process, so the connected client
    /// process ID and both end roles must be ours.
    /// </summary>
    private static void VerifyPeerBinding(SafeFileHandle server, SafeFileHandle client)
    {
        var processId = NativeMethods.GetCurrentProcessId();

        if (!NativeMethods.GetNamedPipeInfo(server, out var serverFlags, out _, out _, out _)
            || (serverFlags & NativeMethods.PipeServerEnd) == 0)
        {
            throw Failure(
                Marshal.GetLastWin32Error(),
                "The parent handle did not report the named-pipe server end; the launch fails closed.");
        }

        if (!NativeMethods.GetNamedPipeInfo(client, out var clientFlags, out _, out _, out _)
            || (clientFlags & NativeMethods.PipeServerEnd) != 0)
        {
            throw Failure(
                Marshal.GetLastWin32Error(),
                "The child handle did not report the named-pipe client end; the launch fails closed.");
        }

        if (!NativeMethods.GetNamedPipeClientProcessId(server, out var clientProcessId)
            || clientProcessId != processId)
        {
            throw Failure(
                Marshal.GetLastWin32Error(),
                $"The connected pipe client is not this controlled process (observed {clientProcessId}, expected {processId}); the launch fails closed.");
        }

        if (!NativeMethods.GetNamedPipeServerProcessId(server, out var serverProcessId)
            || serverProcessId != processId)
        {
            throw Failure(
                Marshal.GetLastWin32Error(),
                $"The pipe server end is not this controlled process (observed {serverProcessId}, expected {processId}); the launch fails closed.");
        }

        // Cross-check the same topology from the client handle, so the pair itself is
        // verified rather than only one end's view.
        if (!NativeMethods.GetNamedPipeClientProcessId(client, out var clientViewClientProcessId)
            || clientViewClientProcessId != processId)
        {
            throw Failure(
                Marshal.GetLastWin32Error(),
                $"The client handle did not report this controlled process as the client (observed {clientViewClientProcessId}, expected {processId}); the launch fails closed.");
        }

        if (!NativeMethods.GetNamedPipeServerProcessId(client, out var clientViewServerProcessId)
            || clientViewServerProcessId != processId)
        {
            throw Failure(
                Marshal.GetLastWin32Error(),
                $"The client handle did not report this controlled process as the server (observed {clientViewServerProcessId}, expected {processId}); the launch fails closed.");
        }
    }

    private static LaunchFailureException Failure(int error, string message) =>
        new(
            LaunchStage.CreateStdio,
            error,
            $"{message} No process was created and no fallback pipe transport was attempted.",
            cleanup: null,
            unsupported: false);

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        CloseChildEnd();
        _parent?.Dispose();
        _parent = null;
    }
}

/// <summary>
/// One bounded overlapped pipe operation: the unmanaged data buffer, the unmanaged
/// <c>OVERLAPPED</c> bytes, and its manual-reset completion event. The managed objects
/// own these allocations until the operation is harvested or deliberately abandoned.
/// </summary>
internal sealed class PendingOverlappedIo : IDisposable
{
    private static readonly int OverlappedSize = Marshal.SizeOf<NativeMethods.NativeOverlapped>();
    private static readonly int EventOffset =
        Marshal.OffsetOf<NativeMethods.NativeOverlapped>("EventHandle").ToInt32();

    private readonly ManualResetEvent _completion = new(false);
    private int _submitted;
    private int _completed;
    private bool _abandoned;
    private bool _disposed;

    internal PendingOverlappedIo(int size)
    {
        Length = size;
        Buffer = Marshal.AllocHGlobal(size <= 0 ? 1 : size);
        Overlapped = Marshal.AllocHGlobal(OverlappedSize);
        Prepare();
    }

    internal IntPtr Buffer { get; }

    internal IntPtr Overlapped { get; }

    internal int Length { get; }

    internal ManualResetEvent Completion => _completion;

    /// <summary>
    /// Resets the <c>OVERLAPPED</c> header and installs the stable completion event. Called
    /// once per submission; the kernel writes the result fields afterwards.
    /// </summary>
    internal void Prepare()
    {
        // Zero exactly the structure size in 4-byte units. The x86 layout is 20 bytes, so
        // an 8-byte stride would overrun the allocation by 4 bytes; the x64 layout is 32
        // bytes. The event offset is the runtime's exact field offset, not a constant.
        for (var offset = 0; offset < OverlappedSize; offset += sizeof(int))
        {
            Marshal.WriteInt32(Overlapped, offset, 0);
        }

        Marshal.WriteIntPtr(Overlapped, EventOffset, _completion.SafeWaitHandle.DangerousGetHandle());
        _completion.Reset();
    }

    /// <summary>
    /// Marks that a native operation may be in flight. From this point the OVERLAPPED and
    /// buffer are freed only after a positively observed completion.
    /// </summary>
    internal void MarkSubmitted() => Volatile.Write(ref _submitted, 1);

    /// <summary>
    /// Marks a positively observed completion. Only <c>GetOverlappedResult</c> success or a
    /// definitive pipe/abort error may call this; handle closure, IO_INCOMPLETE and an
    /// unobserved cancellation may not.
    /// </summary>
    internal void MarkCompleted() => Volatile.Write(ref _completed, 1);

    /// <summary>
    /// Transfers this still-pending operation to process-lifetime retention. The buffers
    /// and the event handle are never freed, because the kernel may still write into them
    /// after the pipe handle is closed.
    /// </summary>
    internal void Abandon()
    {
        if (_abandoned || _disposed)
        {
            return;
        }

        _abandoned = true;
        AbandonedOverlappedIo.Retain(this);
    }

    public void Dispose()
    {
        if (_disposed || _abandoned)
        {
            return;
        }

        if (Volatile.Read(ref _submitted) != 0 && Volatile.Read(ref _completed) == 0)
        {
            // A native operation may still own this buffer. Never free it based on a handle
            // close, a timeout or a cancellation request alone.
            Abandon();
            return;
        }

        _disposed = true;
        Marshal.FreeHGlobal(Overlapped);
        Marshal.FreeHGlobal(Buffer);
        _completion.Dispose();
    }
}

/// <summary>
/// Process-lifetime retention for abandoned in-flight operations. The admission cap lets a
/// reusable host process refuse new cancelable launches once the retained set reaches a
/// bound, instead of growing it forever; the correct response at the cap is process
/// recycling, not freeing memory the kernel may still reference.
/// </summary>
internal static class AbandonedOverlappedIo
{
    internal const int MaximumRetained = 8;

    private static readonly object Gate = new();
    private static readonly List<PendingOverlappedIo> Retained = new();

    internal static void Retain(PendingOverlappedIo operation)
    {
        lock (Gate)
        {
            Retained.Add(operation);
        }
    }

    internal static int RetainedCount
    {
        get
        {
            lock (Gate)
            {
                return Retained.Count;
            }
        }
    }

}

/// <summary>
/// One active cancelable stdio owner per process. The lease is acquired atomically at
/// launch, before any pipe is created, and is released only when the owner finishes with
/// no newly retained operation. A retained operation therefore pins the lease until the
/// process is recycled; a second owner cannot be created concurrently, so the hard bound
/// is one owner's channels rather than an unbounded number of launched owners.
/// </summary>
internal static class CancelableOwnerLease
{
    private static int _held;


    internal static bool TryAcquire(out int retainedAtStart)
    {
        retainedAtStart = AbandonedOverlappedIo.RetainedCount;
        if (retainedAtStart >= AbandonedOverlappedIo.MaximumRetained)
        {
            return false;
        }

        if (Interlocked.CompareExchange(ref _held, 1, 0) != 0)
        {
            return false;
        }

        retainedAtStart = AbandonedOverlappedIo.RetainedCount;
        return true;
    }

    internal static void ReleaseIfClean(int retainedAtStart)
    {
        if (AbandonedOverlappedIo.RetainedCount == retainedAtStart)
        {
            Interlocked.Exchange(ref _held, 0);
        }
    }

    internal static bool Held => Volatile.Read(ref _held) != 0;
}

/// <summary>
/// Defers owner-lease release until both read pumps have exited. A pump can outlive the
/// facade disposal timeout and retain an operation on the way out; releasing the lease
/// earlier would let a second owner start while the first can still retain.
/// </summary>
internal sealed class DeferredLeaseRelease
{
    private readonly object _gate = new();
    private readonly int _startRetained;
    private int _pendingPumps;
    private bool _finalizeRequested;
    private bool _released;

    internal DeferredLeaseRelease(int startRetained, int pendingPumps)
    {
        _startRetained = startRetained;
        _pendingPumps = pendingPumps;
    }

    internal void PumpExited()
    {
        var release = false;
        lock (_gate)
        {
            _pendingPumps--;
            release = TryTake();
        }

        if (release)
        {
            CancelableOwnerLease.ReleaseIfClean(_startRetained);
        }
    }

    internal void FinalizeRequested()
    {
        var release = false;
        lock (_gate)
        {
            _finalizeRequested = true;
            release = TryTake();
        }

        if (release)
        {
            CancelableOwnerLease.ReleaseIfClean(_startRetained);
        }
    }

    private bool TryTake()
    {
        if (!_finalizeRequested || _pendingPumps != 0 || _released)
        {
            return false;
        }

        _released = true;
        return true;
    }
}

/// <summary>
/// The three cancelable pipe pairs for one launch. Child ends stay inheritable only for
/// the bounded create window; parent ends become owned by <see cref="CancelableChildStdio"/>
/// when the launch succeeds. Any preparation failure closes everything and fails closed.
/// </summary>
internal sealed class CancelableStdioPipes : IDisposable
{
    private CancelableStdioPipe? _standardInput;
    private CancelableStdioPipe? _standardOutput;
    private CancelableStdioPipe? _standardError;
    private bool _disposed;
    private bool _leaseHeld;
    private int _leaseStartRetained;

    internal IntPtr[] ChildHandles { get; private set; } = Array.Empty<IntPtr>();

    internal static CancelableStdioPipes Create()
    {
        if (!Environment.Is64BitProcess)
        {
            throw new LaunchFailureException(
                LaunchStage.CreateStdio,
                NativeMethods.ErrorNotSupported,
                "The cancelable overlapped stdio mode is qualified for 64-bit Windows only; no process was created and no fallback transport was attempted.",
                cleanup: null,
                unsupported: true);
        }

        // One owner per process, reserved atomically before any pipe exists. A retained
        // operation keeps the lease until process recycle, so already-launched owners
        // cannot multiply the retained bound.
        if (!CancelableOwnerLease.TryAcquire(out var leaseStartRetained))
        {
            throw new LaunchFailureException(
                LaunchStage.CreateStdio,
                NativeMethods.ErrorNotSupported,
                "A cancelable stdio owner is already active in this process, or the retained-operation threshold is reached. Only one owner per process is supported; recycle the launcher process after a retained operation. No process was created and no fallback transport was attempted.",
                cleanup: null,
                unsupported: false);
        }

        var pipes = new CancelableStdioPipes
        {
            _leaseHeld = true,
            _leaseStartRetained = leaseStartRetained,
        };
        try
        {
            pipes._standardInput = CancelableStdioPipe.Create(parentWrites: true);
            pipes._standardOutput = CancelableStdioPipe.Create(parentWrites: false);
            pipes._standardError = CancelableStdioPipe.Create(parentWrites: false);
            pipes.ChildHandles = new[]
            {
                pipes._standardInput.ChildHandle,
                pipes._standardOutput.ChildHandle,
                pipes._standardError.ChildHandle,
            };

            return pipes;
        }
        catch
        {
            pipes.Dispose();
            throw;
        }
    }

    internal void CloseChildEnds()
    {
        _standardInput?.CloseChildEnd();
        _standardOutput?.CloseChildEnd();
        _standardError?.CloseChildEnd();
        ChildHandles = Array.Empty<IntPtr>();
    }

    internal CancelableChildStdio CreateStreams()
    {
        var input = _standardInput
            ?? throw new InvalidOperationException("The cancelable stdin pipe is unavailable.");
        var output = _standardOutput
            ?? throw new InvalidOperationException("The cancelable stdout pipe is unavailable.");
        var error = _standardError
            ?? throw new InvalidOperationException("The cancelable stderr pipe is unavailable.");

        var standardInput = input.TakeParentHandle();
        var standardOutput = output.TakeParentHandle();
        var standardError = error.TakeParentHandle();

        OverlappedWriteChannel? inputChannel = null;
        OverlappedReadChannel? outputChannel = null;
        OverlappedReadChannel? errorChannel = null;
        DeferredLeaseRelease? lease = null;
        var constructedReadChannels = 0;
        try
        {
            inputChannel = new OverlappedWriteChannel(standardInput);
            lease = new DeferredLeaseRelease(_leaseStartRetained, pendingPumps: 2);
            outputChannel = new OverlappedReadChannel(standardOutput, "rac-stdout-pump", lease);
            constructedReadChannels = 1;
            errorChannel = new OverlappedReadChannel(standardError, "rac-stderr-pump", lease);
            constructedReadChannels = 2;

            // Handles and the owner lease transfer to the facade constructor. It disposes
            // its own channels on an exceptional start; this method must not dispose a
            // transferred handle or release the lease while a started pump can retain.
            _leaseHeld = false;
            return new CancelableChildStdio(inputChannel, outputChannel, errorChannel, lease);
        }
        catch (Exception failure)
        {
            if (_leaseHeld)
            {
                // The facade never took ownership. Dispose every constructed channel and
                // account read channels that were never constructed so the lease can be
                // released only after all pump slots are known.
                inputChannel?.Dispose();
                outputChannel?.Dispose();
                errorChannel?.Dispose();
                if (lease is not null)
                {
                    for (var index = constructedReadChannels; index < 2; index++)
                    {
                        lease.PumpExited();
                    }

                    lease.FinalizeRequested();
                }
                else
                {
                    standardInput.Dispose();
                    standardOutput.Dispose();
                    standardError.Dispose();
                }
            }

            if (failure is LaunchFailureException launchFailure)
            {
                throw launchFailure;
            }

            throw new LaunchFailureException(
                LaunchStage.CreateStdio,
                0,
                $"Cancelable stdio custody failed during startup: {failure.GetType().Name}: {failure.Message} The child was never resumed.",
                cleanup: null,
                unsupported: false);
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        CloseChildEnds();
        _standardInput?.Dispose();
        _standardOutput?.Dispose();
        _standardError?.Dispose();
        _standardInput = null;
        _standardOutput = null;
        _standardError = null;
        if (_leaseHeld)
        {
            CancelableOwnerLease.ReleaseIfClean(_leaseStartRetained);
            _leaseHeld = false;
        }
    }
}

internal sealed record ReadChannelSettlement(
    bool PumpExited,
    StdioIoStatus PendingOutcome,
    int PendingError,
    long PendingBytes,
    StdioIoStatus Terminal,
    int TerminalError,
    long SubmittedReads,
    long CompletedReads,
    long CanceledReads,
    long BytesRead);

/// <summary>
/// A single parent-side read channel with at most one bounded overlapped read in flight
/// and a bounded one-chunk buffer between the native completion and the caller. A read
/// timeout never cancels or frees the pending native operation; only an explicit stop
/// issues <c>CancelIoEx</c>, and an operation that does not settle within the remaining
/// bound is classified <see cref="StdioIoStatus.UnknownPending"/> and retained. Timeline
/// events are disposed only after the pump has exited and no admitted reader remains.
/// </summary>
internal sealed class OverlappedReadChannel : IDisposable
{
    internal const int ChunkSize = 8192;
    private const int PostCancelSettlementMilliseconds = 1000;
    private const int ForcedShutdownMilliseconds = 1000;

    private readonly SafeFileHandle _handle;
    private readonly AutoResetEvent _stateChanged = new(false);
    private readonly AutoResetEvent _spaceAvailable = new(false);
    private readonly ManualResetEvent _stopRequested = new(false);
    private readonly object _gate = new();
    private readonly object _lifetimeGate = new();
    private readonly DeferredLeaseRelease? _leaseRelease;
    private readonly Thread _pump;

    private byte[] _stash = new byte[ChunkSize];
    private int _stashOffset;
    private int _stashCount;
    private StdioIoStatus? _terminal;
    private int _terminalError;
    private StdioIoStatus? _pendingReadOutcome;
    private int _pendingReadError;
    private long _pendingReadBytes;
    private int _stopFlag;
    private int _pumpExited;
    private int _started;
    private int _disposed;
    private int _readers;
    private int _disposeRequested;
    private int _eventsDisposed;
    private long _submittedReads;
    private long _completedReads;
    private long _canceledReads;
    private long _bytesRead;

    internal OverlappedReadChannel(SafeFileHandle handle, string name, DeferredLeaseRelease? leaseRelease = null)
    {
        _handle = handle;
        _leaseRelease = leaseRelease;
        _pump = new Thread(Pump)
        {
            IsBackground = true,
            Name = name,
        };
    }

    /// <summary>
    /// Starts the read pump. Construction and start are deliberately separate so a partial
    /// multi-stream startup can hand custody back to the facade before any child code runs.
    /// </summary>
    internal void Start()
    {
        _pump.Start();
        Volatile.Write(ref _started, 1);
    }

    internal bool PumpExited => Volatile.Read(ref _pumpExited) != 0;

    internal bool StopRequested => Volatile.Read(ref _stopFlag) != 0;

    internal SafeFileHandle Handle => _handle;

    internal long SubmittedReads => Interlocked.Read(ref _submittedReads);

    internal long CompletedReads => Interlocked.Read(ref _completedReads);

    internal long CanceledReads => Interlocked.Read(ref _canceledReads);

    internal long BytesRead => Interlocked.Read(ref _bytesRead);

    internal StdioReadResult Read(Span<byte> destination, TimeSpan timeout)
    {
        if (destination.Length == 0)
        {
            return new StdioReadResult(StdioIoStatus.Faulted, 0, NativeMethods.ErrorInvalidParameter, OperationRetained: false);
        }

        lock (_lifetimeGate)
        {
            if (Volatile.Read(ref _disposeRequested) != 0)
            {
                return new StdioReadResult(StdioIoStatus.Rejected, 0, 0, OperationRetained: false);
            }

            _readers++;
        }

        try
        {
            return ReadCore(destination, timeout);
        }
        finally
        {
            ReleaseReader();
        }
    }

    private StdioReadResult ReadCore(Span<byte> destination, TimeSpan timeout)
    {
        var stopwatch = Stopwatch.StartNew();
        while (true)
        {
            lock (_gate)
            {
                if (_stashCount > 0)
                {
                    var count = Math.Min(destination.Length, _stashCount);
                    new ReadOnlySpan<byte>(_stash, _stashOffset, count).CopyTo(destination);
                    _stashOffset += count;
                    _stashCount -= count;
                    if (_stashCount == 0)
                    {
                        _stashOffset = 0;
                        _spaceAvailable.Set();
                    }

                    return new StdioReadResult(StdioIoStatus.Completed, count, 0, OperationRetained: false);
                }

                if (_terminal is StdioIoStatus terminal)
                {
                    return new StdioReadResult(
                        terminal,
                        0,
                        _terminalError,
                        OperationRetained: terminal == StdioIoStatus.UnknownPending);
                }

                if (Volatile.Read(ref _stopFlag) != 0)
                {
                    return new StdioReadResult(StdioIoStatus.Rejected, 0, 0, OperationRetained: false);
                }

                if (Volatile.Read(ref _pumpExited) != 0)
                {
                    return new StdioReadResult(StdioIoStatus.UnknownPending, 0, _terminalError, OperationRetained: false);
                }
            }

            var remaining = timeout - stopwatch.Elapsed;
            if (remaining <= TimeSpan.Zero)
            {
                // The bounded caller wait expired. The native read is untouched and still
                // owned by the channel; a later read observes its completion.
                return new StdioReadResult(StdioIoStatus.TimedOut, 0, 0, OperationRetained: true);
            }

            if (!_stateChanged.WaitOne(ToMilliseconds(remaining)))
            {
                return new StdioReadResult(StdioIoStatus.TimedOut, 0, 0, OperationRetained: true);
            }
        }
    }

    internal void RequestStop()
    {
        // Linearized with the pump's stop check + submit under the same gate: once this
        // returns, no new native read can be issued.
        lock (_gate)
        {
            Interlocked.Exchange(ref _stopFlag, 1);
        }

        lock (_lifetimeGate)
        {
            if (_eventsDisposed != 0)
            {
                return;
            }

            _stopRequested.Set();
            _stateChanged.Set();
        }
    }

    internal ReadChannelSettlement StopAndSettle(TimeSpan timeout)
    {
        RequestStop();
        var joined = _pump.Join(ToMilliseconds(timeout));

        lock (_gate)
        {
            return new ReadChannelSettlement(
                PumpExited: PumpExited && joined,
                PendingOutcome: _pendingReadOutcome ?? StdioIoStatus.NotInFlight,
                PendingError: _pendingReadError,
                PendingBytes: Interlocked.Read(ref _pendingReadBytes),
                Terminal: _terminal ?? StdioIoStatus.UnknownPending,
                TerminalError: _terminalError,
                SubmittedReads: Interlocked.Read(ref _submittedReads),
                CompletedReads: Interlocked.Read(ref _completedReads),
                CanceledReads: Interlocked.Read(ref _canceledReads),
                BytesRead: Interlocked.Read(ref _bytesRead));
        }
    }

    /// <summary>Closes the parent read handle only when the pump no longer owns an operation.</summary>
    internal bool CloseIfSettled()
    {
        if (!PumpExited)
        {
            return false;
        }

        _handle.Dispose();
        return _handle.IsClosed;
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        lock (_lifetimeGate)
        {
            Volatile.Write(ref _disposeRequested, 1);
        }

        RequestStop();

        if (Volatile.Read(ref _started) == 0)
        {
            // No pump ever owned the handle. Close it here and account the lease pump slot
            // so a failed multi-stream startup can release only when all slots are known.
            Volatile.Write(ref _pumpExited, 1);
            _handle.Dispose();
            TryDisposeEvents();
            _leaseRelease?.PumpExited();
            return;
        }

        if (!_pump.Join(ForcedShutdownMilliseconds))
        {
            // The pump may still be inside CancelAndHarvest with this handle. Never close
            // it from here: the pump owns the handle until it exits and will close it after
            // the pending OVERLAPPED has been harvested or retained.
            return;
        }

        _handle.Dispose();
        TryDisposeEvents();
    }

    private void ReleaseReader()
    {
        lock (_lifetimeGate)
        {
            _readers--;
        }

        TryDisposeEvents();
    }

    private void TryDisposeEvents()
    {
        var dispose = false;
        lock (_lifetimeGate)
        {
            if (Volatile.Read(ref _disposeRequested) != 0
                && Volatile.Read(ref _pumpExited) != 0
                && _readers == 0
                && _eventsDisposed == 0)
            {
                _eventsDisposed = 1;
                dispose = true;
            }
        }

        if (!dispose)
        {
            return;
        }

        _stateChanged.Dispose();
        _spaceAvailable.Dispose();
        _stopRequested.Dispose();
    }

    private void Pump()
    {
        try
        {
            while (true)
            {
                PendingOverlappedIo operation;
                var issued = false;
                var submitError = 0;

                // The stop check and the native submit share this gate with RequestStop, so
                // no read is submitted after stop becomes visible.
                lock (_gate)
                {
                    if (Volatile.Read(ref _stopFlag) != 0)
                    {
                        RecordTerminal(StdioIoStatus.Canceled, 0);
                        break;
                    }

                    operation = new PendingOverlappedIo(ChunkSize);
                    Interlocked.Increment(ref _submittedReads);
                    issued = NativeMethods.ReadFile(
                        _handle,
                        operation.Buffer,
                        (uint)ChunkSize,
                        IntPtr.Zero,
                        operation.Overlapped);
                    if (!issued)
                    {
                        submitError = Marshal.GetLastWin32Error();
                    }

                    if (issued || submitError == NativeMethods.ErrorIoPending)
                    {
                        operation.MarkSubmitted();
                    }
                }

                try
                {
                    var submitted = issued || submitError == NativeMethods.ErrorIoPending;

                    if (LaunchDiagnostics.ReadPumpPaused is { } paused)
                    {
                        // Deterministic qualification seam: pause after a possible native
                        // submit so teardown can be gated at the dangerous window. This is a
                        // test delay, not evidence of a real cancellation failure.
                        paused.Set();
                        LaunchDiagnostics.ReadPumpResume?.Wait(TimeSpan.FromSeconds(10));
                    }

                    if (submitted && Volatile.Read(ref _stopFlag) != 0)
                    {
                        // Stop arrived while the gated/normal submit window was open. Cancel
                        // the exact operation instead of harvesting an incomplete result.
                        HandleStopOutcome(CancelAndHarvest(operation), operation);
                        break;
                    }

                    if (!issued)
                    {
                        if (submitError != NativeMethods.ErrorIoPending)
                        {
                            RecordTerminal(ClassifyReadError(submitError), IsEndOfStreamError(submitError) ? 0 : submitError);
                            break;
                        }

                        if (WaitHandle.WaitAny(new WaitHandle[] { operation.Completion, _stopRequested }) != 0)
                        {
                            HandleStopOutcome(CancelAndHarvest(operation), operation);
                            break;
                        }
                    }

                    if (!Harvest(operation, out var bytes, out var harvestError))
                    {
                        RecordTerminal(harvestError.Status, harvestError.Error);
                        if (harvestError.Status == StdioIoStatus.Canceled)
                        {
                            Interlocked.Increment(ref _canceledReads);
                            RecordPending(StdioIoStatus.Canceled, harvestError.Error, 0);
                        }

                        break;
                    }

                    Interlocked.Increment(ref _completedReads);
                    if (bytes == 0)
                    {
                        // A successful zero-byte pipe read is EOF, never a Completed result.
                        RecordTerminal(StdioIoStatus.EndOfStream, 0);
                        break;
                    }

                    Interlocked.Add(ref _bytesRead, bytes);
                    Stash(operation, bytes);
                    _stateChanged.Set();

                    if (WaitHandle.WaitAny(new WaitHandle[] { _spaceAvailable, _stopRequested }) != 0)
                    {
                        RecordTerminal(StdioIoStatus.Canceled, 0);
                        break;
                    }
                }
                finally
                {
                    operation.Dispose();
                }
            }
        }
        catch (ObjectDisposedException)
        {
            RecordTerminal(StdioIoStatus.Faulted, NativeMethods.ErrorInvalidHandle);
        }
        catch (InvalidOperationException)
        {
            RecordTerminal(StdioIoStatus.Faulted, NativeMethods.ErrorInvalidHandle);
        }
        finally
        {
            // Set the final wake before declaring the pump exited: TryDisposeEvents only
            // disposes after _pumpExited is visible, so no signaler can touch a disposed
            // event.
            try
            {
                _stateChanged.Set();
            }
            catch (ObjectDisposedException)
            {
                // Defensive: only a faulty lifecycle can dispose this early.
            }

            Volatile.Write(ref _pumpExited, 1);

            // Channel disposal may have timed out waiting for this pump. Closing the handle
            // here is safe: the pump has harvested or retained the pending OVERLAPPED and
            // will not touch the handle again.
            if (Volatile.Read(ref _disposeRequested) != 0)
            {
                _handle.Dispose();
            }

            TryDisposeEvents();
            _leaseRelease?.PumpExited();
        }
    }

    private CancelOutcome CancelAndHarvest(PendingOverlappedIo operation)
    {
        var cancelError = 0;
        if (LaunchDiagnostics.CancelIoExFailure is int injected)
        {
            // Fault seam: simulate a cancel-boundary failure. The real CancelIoEx call is
            // not made; the operation is only classified from what the kernel reports.
            cancelError = injected;
        }
        else
        {
            try
            {
                if (!NativeMethods.CancelIoEx(_handle, operation.Overlapped))
                {
                    cancelError = Marshal.GetLastWin32Error();
                }
            }
            catch (ObjectDisposedException)
            {
                cancelError = NativeMethods.ErrorInvalidHandle;
            }
        }

        // Even when cancellation was requested the completion event is authoritative: the
        // operation may have completed between submission and the cancel call.
        bool completed;
        try
        {
            completed = operation.Completion.WaitOne(PostCancelSettlementMilliseconds);
        }
        catch (ObjectDisposedException)
        {
            completed = false;
            cancelError = NativeMethods.ErrorInvalidHandle;
        }

        if (!completed)
        {
            return new CancelOutcome(
                StdioIoStatus.UnknownPending,
                cancelError == 0 ? NativeMethods.ErrorSemTimeout : cancelError,
                0);
        }

        if (Harvest(operation, out var bytes, out var harvest))
        {
            if (bytes > 0)
            {
                Interlocked.Add(ref _bytesRead, bytes);
            }

            return new CancelOutcome(StdioIoStatus.Completed, 0, bytes);
        }

        return harvest.Status == StdioIoStatus.Faulted
            ? new CancelOutcome(StdioIoStatus.Faulted, harvest.Error, 0)
            : new CancelOutcome(
                harvest.Status,
                harvest.Error != 0 ? harvest.Error : cancelError,
                0);
    }

    private void HandleStopOutcome(CancelOutcome outcome, PendingOverlappedIo operation)
    {
        if (outcome.Status == StdioIoStatus.Completed)
        {
            Interlocked.Increment(ref _completedReads);
            RecordPending(StdioIoStatus.Completed, outcome.Error, outcome.Bytes);
            if (outcome.Bytes == 0)
            {
                // A successful zero-byte pipe read is EOF; never report Completed/0.
                RecordTerminal(StdioIoStatus.EndOfStream, 0);
                return;
            }

            // The native read completed before cancellation. Keep the already-read bytes
            // visible to a drain call, then report the stop as the terminal state so no
            // zero-byte Completed is synthesized.
            Stash(operation, outcome.Bytes);
            _stateChanged.Set();
            RecordTerminal(StdioIoStatus.Canceled, 0);
            return;
        }

        RecordPending(outcome.Status, outcome.Error, 0);
        RecordTerminal(outcome.Status, outcome.Error);
        if (outcome.Status == StdioIoStatus.Canceled)
        {
            Interlocked.Increment(ref _canceledReads);
        }
        else if (outcome.Status == StdioIoStatus.UnknownPending)
        {
            operation.Abandon();
        }
    }

    private void Stash(PendingOverlappedIo operation, uint bytes)
    {
        lock (_gate)
        {
            _stash = EnsureStashCapacity(_stash, (int)bytes);
            Marshal.Copy(operation.Buffer, _stash, 0, (int)bytes);
            _stashOffset = 0;
            _stashCount = (int)bytes;
        }
    }

    private bool Harvest(PendingOverlappedIo operation, out uint bytes, out CancelOutcome failure)
    {
        bytes = 0;
        try
        {
            if (NativeMethods.GetOverlappedResult(_handle, operation.Overlapped, out bytes, wait: false))
            {
                operation.MarkCompleted();
                failure = default;
                return true;
            }
        }
        catch (ObjectDisposedException)
        {
            // The handle was closed without a positively observed completion. The pump's
            // ownership path retains the OVERLAPPED instead of freeing it.
            failure = new CancelOutcome(StdioIoStatus.UnknownPending, NativeMethods.ErrorInvalidHandle, 0);
            return false;
        }

        var error = Marshal.GetLastWin32Error();
        if (error == NativeMethods.ErrorIoIncomplete || error == NativeMethods.ErrorInvalidHandle)
        {
            failure = new CancelOutcome(StdioIoStatus.UnknownPending, error, 0);
            return false;
        }

        if (error == NativeMethods.ErrorOperationAborted)
        {
            operation.MarkCompleted();
            failure = new CancelOutcome(StdioIoStatus.Canceled, error, 0);
            return false;
        }

        if (IsEndOfStreamError(error))
        {
            operation.MarkCompleted();
            failure = new CancelOutcome(StdioIoStatus.EndOfStream, error, 0);
            return false;
        }

        operation.MarkCompleted();
        failure = new CancelOutcome(StdioIoStatus.Faulted, error, 0);
        return false;
    }

    private void RecordPending(StdioIoStatus status, int error, uint bytes)
    {
        lock (_gate)
        {
            _pendingReadOutcome = status;
            _pendingReadError = error;
            Interlocked.Exchange(ref _pendingReadBytes, bytes);
        }
    }

    private void RecordTerminal(StdioIoStatus status, int error)
    {
        lock (_gate)
        {
            _terminal ??= status;
            if (_terminalError == 0)
            {
                _terminalError = error;
            }
        }
    }

    private static byte[] EnsureStashCapacity(byte[] stash, int required) =>
        stash.Length >= required ? stash : new byte[Math.Max(required, stash.Length * 2)];

    internal static bool IsEndOfStreamError(int error) =>
        error is NativeMethods.ErrorBrokenPipe
            or NativeMethods.ErrorNoData
            or NativeMethods.ErrorHandleEof
            or NativeMethods.ErrorPipeNotConnected;

    private static StdioIoStatus ClassifyReadError(int error) =>
        IsEndOfStreamError(error) ? StdioIoStatus.EndOfStream : StdioIoStatus.Faulted;

    internal static int ToMilliseconds(TimeSpan value)
    {
        if (value <= TimeSpan.Zero)
        {
            return 0;
        }

        var milliseconds = Math.Ceiling(value.TotalMilliseconds);
        return milliseconds >= int.MaxValue ? int.MaxValue : (int)milliseconds;
    }

    private readonly record struct CancelOutcome(StdioIoStatus Status, int Error, uint Bytes);
}

internal sealed record WriteChannelSettlement(
    StdioIoStatus PendingOutcome,
    int PendingError,
    StdioDelivery PendingDelivery,
    StdioIoStatus LastWriteStatus,
    int LastWriteError,
    StdioDelivery LastWriteDelivery,
    bool Settled,
    bool HandleClosed,
    long SubmittedWrites,
    long CompletedWrites,
    long CanceledWrites,
    long BytesWritten);

/// <summary>
/// A single parent-side write channel with at most one bounded overlapped write in
/// flight. Every operation has a stable identity, exactly one authoritative observer, and
/// one completion result; concurrent observers are refused before any effect instead of
/// mis-attributing another operation. Stop, harvest and handle close linearize under the
/// same gate as submission. A send after stop has no native effect and a cancelled or
/// in-flight write is reported as possibly delivered.
/// </summary>
internal sealed class OverlappedWriteChannel : IDisposable
{
    internal const int MaximumSendBytes = 64 * 1024;
    private const int GracefulSettleMilliseconds = 250;
    private const int PostCancelSettlementMilliseconds = 2000;
    private const int ForcedShutdownMilliseconds = 1000;

    private readonly SafeFileHandle _handle;
    private readonly object _gate = new();
    private readonly object _teardownLock = new();
    private WriteOperation? _pending;
    private StdioSendResult? _lastCompletion;
    private StdioIoStatus? _pendingWriteOutcome;
    private int _pendingWriteError;
    private int _stopFlag;
    private int _closed;
    private int _disposed;
    private long _submittedWrites;
    private long _completedWrites;
    private long _canceledWrites;
    private long _bytesWritten;

    internal OverlappedWriteChannel(SafeFileHandle handle)
    {
        _handle = handle;
    }

    internal bool StopRequested => Volatile.Read(ref _stopFlag) != 0;

    internal bool HandleClosed => Volatile.Read(ref _closed) != 0;

    internal SafeFileHandle Handle => _handle;

    internal long SubmittedWrites => Interlocked.Read(ref _submittedWrites);

    internal long CompletedWrites => Interlocked.Read(ref _completedWrites);

    internal long CanceledWrites => Interlocked.Read(ref _canceledWrites);

    internal long BytesWritten => Interlocked.Read(ref _bytesWritten);

    internal bool HasPendingWrite
    {
        get
        {
            lock (_gate)
            {
                return _pending is not null;
            }
        }
    }

    /// <summary>
    /// The most recent authoritative write result, independent of whether a caller or
    /// closer harvested it. This preserves causal history when a concurrent observer
    /// clears the pending operation before input close.
    /// </summary>
    internal StdioSendResult? LastCompletion
    {
        get
        {
            lock (_gate)
            {
                return _lastCompletion;
            }
        }
    }

    internal StdioSendResult Send(ReadOnlySpan<byte> payload, TimeSpan completionBound)
    {
        if (payload.Length > MaximumSendBytes)
        {
            return new StdioSendResult(
                StdioIoStatus.Rejected,
                payload.Length,
                0,
                NativeMethods.ErrorInvalidParameter,
                StopObservedBeforeSubmit: false,
                Delivery: StdioDelivery.None,
                OperationRetained: false);
        }

        WriteOperation operation;
        int length;
        lock (_gate)
        {
            if (Volatile.Read(ref _stopFlag) != 0 || Volatile.Read(ref _closed) != 0 || Volatile.Read(ref _disposed) != 0)
            {
                return new StdioSendResult(
                    StdioIoStatus.Rejected,
                    payload.Length,
                    0,
                    0,
                    StopObservedBeforeSubmit: true,
                    Delivery: StdioDelivery.None,
                    OperationRetained: false);
            }

            if (_pending is not null)
            {
                // A completed prior operation is harvested for evidence, but a second
                // observer does not wait; a still-pending operation is backpressure.
                if (TryHarvestLocked(_pending) is null)
                {
                    return new StdioSendResult(
                        StdioIoStatus.Backpressure,
                        payload.Length,
                        0,
                        0,
                        StopObservedBeforeSubmit: false,
                        Delivery: StdioDelivery.None,
                        OperationRetained: true);
                }
            }

            if (payload.Length == 0)
            {
                return new StdioSendResult(
                    StdioIoStatus.Completed,
                    0,
                    0,
                    0,
                    StopObservedBeforeSubmit: false,
                    Delivery: StdioDelivery.None,
                    OperationRetained: false);
            }

            length = payload.Length;
            operation = new WriteOperation(length);
            if (!operation.TryAcquireObserver())
            {
                operation.Release();
                return new StdioSendResult(
                    StdioIoStatus.Backpressure,
                    payload.Length,
                    0,
                    0,
                    StopObservedBeforeSubmit: false,
                    Delivery: StdioDelivery.None,
                    OperationRetained: _pending is not null);
            }

            operation.AddRef();
            try
            {
                var bytes = payload.ToArray();
                Marshal.Copy(bytes, 0, operation.Io.Buffer, bytes.Length);
                operation.Io.Prepare();
                _pending = operation;
                Interlocked.Increment(ref _submittedWrites);

                var issued = NativeMethods.WriteFile(_handle, operation.Io.Buffer, (uint)length, IntPtr.Zero, operation.Io.Overlapped);
                if (!issued)
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error != NativeMethods.ErrorIoPending)
                    {
                        _pending = null;
                        var status = OverlappedReadChannel.IsEndOfStreamError(error)
                            ? StdioIoStatus.EndOfStream
                            : StdioIoStatus.Faulted;
                        var failed = new StdioSendResult(
                            status,
                            length,
                            0,
                            error,
                            StopObservedBeforeSubmit: false,
                            Delivery: StdioDelivery.None,
                            OperationRetained: false);
                        operation.Result = failed;
                        _lastCompletion = failed;
                        operation.ReleaseObserver();
                        operation.Release();
                        operation.Release();
                        return failed;
                    }
                }

                operation.Io.MarkSubmitted();
            }
            catch
            {
                _pending = null;
                operation.ReleaseObserver();
                operation.Release();
                operation.Release();
                throw;
            }
        }

        // Wait outside the gate so stop/teardown never waits on this caller's bound.
        var signaled = operation.Io.Completion.WaitOne(OverlappedReadChannel.ToMilliseconds(completionBound));
        StdioSendResult result;
        lock (_gate)
        {
            var harvested = TryHarvestLocked(operation);
            result = harvested ?? (signaled
                ? UnknownPendingOperation(operation)
                : SubmittedOperation(operation));
            operation.ReleaseObserver();
        }

        operation.Release();
        return result with { BytesRequested = length };
    }

    internal StdioSendResult WaitForSendCompletion(TimeSpan timeout)
    {
        WriteOperation? operation;
        lock (_gate)
        {
            operation = _pending;
            if (operation is null)
            {
                if (_lastCompletion is { } last)
                {
                    return last;
                }

                if (_pendingWriteOutcome is { } outcome && outcome != StdioIoStatus.NotInFlight)
                {
                    return new StdioSendResult(
                        outcome,
                        0,
                        0,
                        _pendingWriteError,
                        StopObservedBeforeSubmit: false,
                        Delivery: outcome is StdioIoStatus.Canceled or StdioIoStatus.UnknownPending or StdioIoStatus.Submitted
                            ? StdioDelivery.Unknown
                            : StdioDelivery.None,
                        OperationRetained: false);
                }

                return new StdioSendResult(
                    StdioIoStatus.NotInFlight,
                    0,
                    0,
                    0,
                    StopObservedBeforeSubmit: false,
                    Delivery: StdioDelivery.None,
                    OperationRetained: false);
            }

            // A completion that is already observable is returned with its true status even
            // when the submitting caller is still the observer.
            if (TryHarvestLocked(operation) is { } harvested)
            {
                return harvested;
            }

            if (!operation.TryAcquireObserver())
            {
                // Another admitted observer owns this operation; refuse before any wait or
                // effect instead of racing for the same completion.
                return SubmittedOperation(operation);
            }

            operation.AddRef();
        }

        var signaled = operation.Io.Completion.WaitOne(OverlappedReadChannel.ToMilliseconds(timeout));
        StdioSendResult result;
        lock (_gate)
        {
            var harvested = TryHarvestLocked(operation);
            result = harvested
                ?? (signaled ? UnknownPendingOperation(operation) : SubmittedOperation(operation));
            operation.ReleaseObserver();
        }

        operation.Release();
        return result with { BytesRequested = operation.Length };
    }

    /// <summary>
    /// Stops new sends, settles or cancels the in-flight write within the supplied bound,
    /// and closes the parent write handle so the child observes EOF. The handle is not
    /// closed while an operation is still unsettled. Teardown is serialized so a concurrent
    /// forced dispose cannot close the handle underneath a harvest.
    /// </summary>
    internal WriteChannelSettlement StopAndCloseEof(TimeSpan timeout)
    {
        if (Volatile.Read(ref _disposed) != 0)
        {
            return ForcedCloseSettlement();
        }

        lock (_teardownLock)
        {
            if (Volatile.Read(ref _disposed) != 0)
            {
                // A forced dispose won the teardown lock between the first check and here.
                // Do not touch CancelIoEx or the disposed write handle.
                return ForcedCloseSettlement();
            }

            Interlocked.Exchange(ref _stopFlag, 1);
            var stopwatch = Stopwatch.StartNew();

            WriteOperation? operation;
            lock (_gate)
            {
                // Keep the operation visible to concurrent waiters until it has a stored
                // result. Clearing _pending first let a waiter observe NotInFlight while
                // this teardown was still cancelling the same operation.
                operation = _pending;
                if (operation is not null)
                {
                    operation.AddRef();
                }
            }

            var pendingOutcome = StdioIoStatus.NotInFlight;
            var pendingError = 0;
            var pendingDelivery = StdioDelivery.None;
            var lastWriteStatus = StdioIoStatus.NotInFlight;
            var lastWriteError = 0;
            var lastWriteDelivery = StdioDelivery.None;
            var settled = true;

            lock (_gate)
            {
                if (_lastCompletion is { } previous)
                {
                    lastWriteStatus = previous.Status;
                    lastWriteError = previous.Win32Error;
                    lastWriteDelivery = previous.Delivery;
                }
            }

            if (operation is not null)
            {
                var grace = Min(timeout, TimeSpan.FromMilliseconds(GracefulSettleMilliseconds));
                var signaled = operation.Io.Completion.WaitOne(OverlappedReadChannel.ToMilliseconds(grace));
                if (!signaled)
                {
                    var remaining = timeout - stopwatch.Elapsed;
                    var cancelError = 0;
                    CancelExact(operation, ref cancelError);
                    var postCancel = Min(
                        remaining > TimeSpan.Zero ? remaining : TimeSpan.Zero,
                        TimeSpan.FromMilliseconds(PostCancelSettlementMilliseconds));
                    signaled = operation.Io.Completion.WaitOne(OverlappedReadChannel.ToMilliseconds(postCancel));
                }

                lock (_gate)
                {
                    var harvested = TryHarvestLocked(operation);
                    if (harvested is { } value)
                    {
                        pendingOutcome = value.Status;
                        pendingError = value.Win32Error;
                        pendingDelivery = value.Delivery;
                        lastWriteStatus = value.Status;
                        lastWriteError = value.Win32Error;
                        lastWriteDelivery = value.Delivery;
                    }
                    else
                    {
                        settled = false;
                        pendingOutcome = StdioIoStatus.UnknownPending;
                        pendingError = NativeMethods.ErrorSemTimeout;
                        pendingDelivery = StdioDelivery.Unknown;
                        lastWriteStatus = StdioIoStatus.UnknownPending;
                        lastWriteError = pendingError;
                        lastWriteDelivery = StdioDelivery.Unknown;
                        operation.Result = new StdioSendResult(
                            StdioIoStatus.UnknownPending,
                            operation.Length,
                            0,
                            pendingError,
                            StopObservedBeforeSubmit: false,
                            Delivery: StdioDelivery.Unknown,
                            OperationRetained: true);
                        _lastCompletion = operation.Result;
                    }
                }

                if (!settled)
                {
                    operation.Io.Abandon();
                }

                operation.Release();
            }

            var handleClosed = false;
            if (settled)
            {
                _handle.Dispose();
                Interlocked.Exchange(ref _closed, 1);
                handleClosed = _handle.IsClosed;
            }

            lock (_gate)
            {
                _pendingWriteOutcome = pendingOutcome;
                _pendingWriteError = pendingError;
            }

            return new WriteChannelSettlement(
                pendingOutcome,
                pendingError,
                pendingDelivery,
                lastWriteStatus,
                lastWriteError,
                lastWriteDelivery,
                settled,
                handleClosed,
                SubmittedWrites,
                CompletedWrites,
                CanceledWrites,
                BytesWritten);
        }
    }

    internal void RequestStop() => Interlocked.Exchange(ref _stopFlag, 1);

    /// <summary>
    /// Truthful cached classification for a late caller after forced closure. It makes no
    /// EOF or settlement claim and never touches the disposed handle.
    /// </summary>
    private WriteChannelSettlement ForcedCloseSettlement()
    {
        lock (_gate)
        {
            var last = _lastCompletion;
            return new WriteChannelSettlement(
                StdioIoStatus.UnknownPending,
                NativeMethods.ErrorInvalidHandle,
                StdioDelivery.Unknown,
                last?.Status ?? StdioIoStatus.UnknownPending,
                last?.Win32Error ?? NativeMethods.ErrorInvalidHandle,
                last?.Delivery ?? StdioDelivery.Unknown,
                Settled: false,
                HandleClosed: _handle.IsClosed,
                SubmittedWrites,
                CompletedWrites,
                CanceledWrites,
                BytesWritten);
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        Interlocked.Exchange(ref _stopFlag, 1);

        // Teardown is serialized with the bounded close path. Channel disposal is deferred
        // by the facade until no public call remains, so this lock is acquired without
        // racing an admitted StopAndCloseEof; it still guarantees a single owner here.
        lock (_teardownLock)
        {
            WriteOperation? operation;
            lock (_gate)
            {
                // Keep the operation visible until its result is stored; a waiter may be
                // admitted concurrently with this forced path.
                operation = _pending;
                if (operation is not null)
                {
                    operation.AddRef();
                }
            }

            if (operation is not null)
            {
                if (!operation.Io.Completion.WaitOne(ForcedShutdownMilliseconds))
                {
                    _ = NativeMethods.CancelIoEx(_handle, operation.Io.Overlapped);
                    if (!operation.Io.Completion.WaitOne(ForcedShutdownMilliseconds))
                    {
                        lock (_gate)
                        {
                            operation.Result ??= new StdioSendResult(
                                StdioIoStatus.UnknownPending,
                                operation.Length,
                                0,
                                NativeMethods.ErrorSemTimeout,
                                StopObservedBeforeSubmit: false,
                                Delivery: StdioDelivery.Unknown,
                                OperationRetained: true);
                        }

                        operation.Io.Abandon();
                    }
                }

                if (!operation.Io.Completion.WaitOne(0))
                {
                    lock (_gate)
                    {
                        operation.Result ??= new StdioSendResult(
                            StdioIoStatus.UnknownPending,
                            operation.Length,
                            0,
                            NativeMethods.ErrorSemTimeout,
                            StopObservedBeforeSubmit: false,
                            Delivery: StdioDelivery.Unknown,
                            OperationRetained: true);
                    }
                }
                else
                {
                    lock (_gate)
                    {
                        _ = TryHarvestLocked(operation);
                    }
                }

                lock (_gate)
                {
                    operation.Result ??= new StdioSendResult(
                        StdioIoStatus.UnknownPending,
                        operation.Length,
                        0,
                        NativeMethods.ErrorSemTimeout,
                        StopObservedBeforeSubmit: false,
                        Delivery: StdioDelivery.Unknown,
                        OperationRetained: true);
                    _lastCompletion = operation.Result;
                }

                operation.Release();
            }

            // The operation was harvested or retained above; only now is closing the handle
            // safe. An uncompleted operation's Io.Dispose retains its OVERLAPPED.
            _handle.Dispose();
            Interlocked.Exchange(ref _closed, 1);
        }
    }

    /// <summary>
    /// Harvests a completed operation exactly once, under <see cref="_gate"/>, and stores
    /// its authoritative result on the operation. Never touches the handle after close,
    /// because a stored result is returned first.
    /// </summary>
    private StdioSendResult? TryHarvestLocked(WriteOperation operation)
    {
        if (operation.Result is { } existing)
        {
            // Publish the same authoritative result to late observers instead of
            // synthesizing NotInFlight after the operation was cleared from _pending.
            _lastCompletion = existing;
            return existing;
        }

        if (!operation.Io.Completion.WaitOne(0))
        {
            return null;
        }

        uint bytes = 0;
        bool succeeded;
        try
        {
            succeeded = NativeMethods.GetOverlappedResult(_handle, operation.Io.Overlapped, out bytes, wait: false);
        }
        catch (ObjectDisposedException)
        {
            // Handle closure is not a completion. Leave the operation uncompleted so the
            // refcounted release retains its buffer.
            return null;
        }

        StdioSendResult result;
        if (!succeeded)
        {
            var error = Marshal.GetLastWin32Error();
            if (error == NativeMethods.ErrorIoIncomplete || error == NativeMethods.ErrorInvalidHandle)
            {
                return null;
            }

            if (error == NativeMethods.ErrorOperationAborted)
            {
                operation.Io.MarkCompleted();
                Interlocked.Increment(ref _canceledWrites);
                result = new StdioSendResult(
                    StdioIoStatus.Canceled,
                    operation.Length,
                    (int)bytes,
                    error,
                    StopObservedBeforeSubmit: false,
                    Delivery: StdioDelivery.Unknown,
                    OperationRetained: false);
            }
            else
            {
                operation.Io.MarkCompleted();
                var status = OverlappedReadChannel.IsEndOfStreamError(error)
                    ? StdioIoStatus.EndOfStream
                    : StdioIoStatus.Faulted;
                result = new StdioSendResult(
                    status,
                    operation.Length,
                    (int)bytes,
                    error,
                    StopObservedBeforeSubmit: false,
                    Delivery: bytes > 0 ? StdioDelivery.Delivered : StdioDelivery.Unknown,
                    OperationRetained: false);
            }
        }
        else
        {
            operation.Io.MarkCompleted();
            Interlocked.Increment(ref _completedWrites);
            Interlocked.Add(ref _bytesWritten, bytes);
            result = new StdioSendResult(
                StdioIoStatus.Completed,
                operation.Length,
                (int)bytes,
                0,
                StopObservedBeforeSubmit: false,
                Delivery: bytes > 0 ? StdioDelivery.Delivered : StdioDelivery.None,
                OperationRetained: false);
        }

        operation.Result = result;
        _lastCompletion = result;
        if (ReferenceEquals(_pending, operation))
        {
            _pending = null;
            operation.Release();
        }

        return result;
    }

    private void CancelExact(WriteOperation operation, ref int cancelError)
    {
        if (LaunchDiagnostics.CancelIoExFailure is int injected)
        {
            cancelError = injected;
            return;
        }

        if (!NativeMethods.CancelIoEx(_handle, operation.Io.Overlapped))
        {
            cancelError = Marshal.GetLastWin32Error();
        }
    }

    private static StdioSendResult SubmittedOperation(WriteOperation operation) =>
        new(
            StdioIoStatus.Submitted,
            operation.Length,
            0,
            0,
            StopObservedBeforeSubmit: false,
            Delivery: StdioDelivery.Unknown,
            OperationRetained: true);

    private static StdioSendResult UnknownPendingOperation(WriteOperation operation) =>
        new(
            StdioIoStatus.UnknownPending,
            operation.Length,
            0,
            0,
            StopObservedBeforeSubmit: false,
            Delivery: StdioDelivery.Unknown,
            OperationRetained: true);

    private static TimeSpan Min(TimeSpan left, TimeSpan right) => left <= right ? left : right;

    private sealed class WriteOperation
    {
        private int _references = 1;
        private int _observer;

        internal WriteOperation(int length)
        {
            Length = length;
            Io = new PendingOverlappedIo(length);
        }

        internal PendingOverlappedIo Io { get; }

        internal int Length { get; }

        /// <summary>Written and read under the channel gate.</summary>
        internal StdioSendResult? Result { get; set; }

        internal bool TryAcquireObserver() => Interlocked.CompareExchange(ref _observer, 1, 0) == 0;

        internal void ReleaseObserver() => Interlocked.Exchange(ref _observer, 0);

        internal void AddRef() => Interlocked.Increment(ref _references);

        internal void Release()
        {
            if (Interlocked.Decrement(ref _references) == 0)
            {
                Io.Dispose();
            }
        }
    }
}
