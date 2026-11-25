#nullable enable

using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RemoteAgentConsole.WindowsLaunch;

/// <summary>
/// Minimal <c>kernel32</c> surface used by the launcher. Every entry point is
/// Unicode-explicit and operates on handles, never on process IDs or image names.
/// </summary>
internal static class NativeMethods
{
    internal const uint CreateSuspended = 0x00000004;
    internal const uint CreateUnicodeEnvironment = 0x00000400;
    internal const uint CreateDetachedProcess = 0x00000008;
    internal const uint ExtendedStartupInfoPresent = 0x00080000;
    internal const uint StartfUseStdHandles = 0x00000100;
    internal const uint HandleFlagInherit = 0x00000001;

    internal static readonly IntPtr ProcThreadAttributeJobList = (IntPtr)0x0002000D;
    internal static readonly IntPtr ProcThreadAttributeHandleList = (IntPtr)0x00020002;

    internal const uint JobObjectLimitKillOnJobClose = 0x00002000;
    internal const uint JobObjectLimitBreakawayOk = 0x00000800;
    internal const uint JobObjectLimitSilentBreakawayOk = 0x00001000;

    internal const uint WaitObject0 = 0x00000000;
    internal const uint WaitTimeout = 0x00000102;
    internal const uint StillActive = 259;

    // Cancelable parent-side stdio: the parent end of each private pipe is a
    // FILE_FLAG_OVERLAPPED named-pipe server handle; the child receives a synchronous,
    // inheritable client handle, so child reads/writes stay ordinary blocking pipe I/O.
    internal const uint FileFlagOverlapped = 0x40000000;
    internal const uint FileFlagFirstPipeInstance = 0x00080000;
    internal const uint PipeAccessInbound = 0x00000001;
    internal const uint PipeAccessOutbound = 0x00000002;
    internal const uint PipeAccessDuplex = 0x00000003;
    internal const uint PipeServerEnd = 0x00000001;
    internal const uint FileReadAttributes = 0x00000080;
    internal const uint PipeTypeByte = 0x00000000;
    internal const uint PipeReadmodeByte = 0x00000000;
    internal const uint PipeWait = 0x00000000;
    internal const uint PipeRejectRemoteClients = 0x00000008;
    internal const uint PipeAcceptRemoteClients = 0x00000000;
    internal const uint GenericRead = 0x80000000;
    internal const uint GenericWrite = 0x40000000;
    internal const uint OpenExisting = 3;
    internal const int SddlRevision1 = 1;

    internal const int JobObjectBasicAccountingInformationClass = 1;
    internal const int JobObjectBasicProcessIdListClass = 3;
    internal const int JobObjectExtendedLimitInformationClass = 9;

    internal const int ErrorAccessDenied = 5;
    internal const int ErrorInvalidHandle = 6;
    internal const int ErrorNotSupported = 50;
    internal const int ErrorInvalidParameter = 87;
    internal const int ErrorCallNotImplemented = 120;
    internal const int ErrorInsufficientBuffer = 122;
    internal const int ErrorHandleEof = 38;
    internal const int ErrorBrokenPipe = 109;
    internal const int ErrorNoData = 232;
    internal const int ErrorPipeConnected = 535;
    internal const int ErrorPipeNotConnected = 233;
    internal const int ErrorIoIncomplete = 996;
    internal const int ErrorIoPending = 997;
    internal const int ErrorOperationAborted = 995;
    internal const int ErrorNotFound = 1168;
    internal const int ErrorSemTimeout = 121;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern SafeJobHandle CreateJobObjectW(IntPtr jobAttributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetInformationJobObject(
        SafeJobHandle job,
        int informationClass,
        ref JobObjectExtendedLimitInformation information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryInformationJobObjectExtended(
        SafeJobHandle job,
        int informationClass,
        out JobObjectExtendedLimitInformation information,
        uint informationLength,
        out uint returnLength);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryInformationJobObjectAccounting(
        SafeJobHandle job,
        int informationClass,
        out JobObjectBasicAccountingInformation information,
        uint informationLength,
        out uint returnLength);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryInformationJobObjectProcessIdList(
        SafeJobHandle job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        out uint returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreatePipe(
        out IntPtr readPipe,
        out IntPtr writePipe,
        ref SecurityAttributes pipeAttributes,
        uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetHandleInformation(
        SafeFileHandle handle,
        uint mask,
        uint flags);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern SafeFileHandle CreateNamedPipeW(
        string pipeName,
        uint openMode,
        uint pipeMode,
        uint maximumInstances,
        uint outboundBufferSize,
        uint inboundBufferSize,
        uint defaultTimeout,
        ref SecurityAttributes pipeAttributes);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        ref SecurityAttributes fileAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ConnectNamedPipe(SafeFileHandle pipe, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetNamedPipeInfo(
        SafeFileHandle pipe,
        out uint flags,
        out uint outboundBufferSize,
        out uint inboundBufferSize,
        out uint maximumInstances);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetNamedPipeClientProcessId(SafeFileHandle pipe, out uint clientProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetNamedPipeServerProcessId(SafeFileHandle pipe, out uint serverProcessId);

    [DllImport("kernel32.dll")]
    internal static extern uint GetCurrentProcessId();

    /// <summary>
    /// Issues overlapped <c>ReadFile</c>. <paramref name="bytesRead"/> must be
    /// <see cref="IntPtr.Zero"/>; the count is collected with <c>GetOverlappedResult</c>.
    /// </summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ReadFile(
        SafeFileHandle handle,
        IntPtr buffer,
        uint bytesToRead,
        IntPtr bytesRead,
        IntPtr overlapped);

    /// <summary>
    /// Issues overlapped <c>WriteFile</c>. <paramref name="bytesWritten"/> must be
    /// <see cref="IntPtr.Zero"/>; the count is collected with <c>GetOverlappedResult</c>.
    /// </summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool WriteFile(
        SafeFileHandle handle,
        IntPtr buffer,
        uint bytesToWrite,
        IntPtr bytesWritten,
        IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetOverlappedResult(
        SafeFileHandle handle,
        IntPtr overlapped,
        out uint bytesTransferred,
        [MarshalAs(UnmanagedType.Bool)] bool wait);

    /// <summary>
    /// Cancels the exact overlapped operation identified by <paramref name="overlapped"/>.
    /// <c>ERROR_NOT_FOUND</c> means the operation had already completed.
    /// </summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CancelIoEx(SafeFileHandle handle, IntPtr overlapped);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string stringSecurityDescriptor,
        uint revision,
        out IntPtr securityDescriptor,
        out uint securityDescriptorSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("kernel32.dll")]
    internal static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsProcessInJob(
        SafeProcessHandle process,
        SafeJobHandle job,
        [MarshalAs(UnmanagedType.Bool)] out bool inJob);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateJobObject(SafeJobHandle job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateProcessW(
        string? applicationName,
        IntPtr commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string? currentDirectory,
        ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateProcess(SafeProcessHandle process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint WaitForSingleObject(SafeProcessHandle handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint ResumeThread(SafeThreadHandle thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    internal struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr SecurityDescriptor;
        internal int InheritHandle;
    }

    /// <summary>
    /// The <c>OVERLAPPED</c> bytes for one bounded pipe operation. Only the completion
    /// event is written from managed code; the kernel owns the remaining fields.
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeOverlapped
    {
        internal IntPtr Internal;
        internal IntPtr InternalHigh;
        internal uint Offset;
        internal uint OffsetHigh;
        internal IntPtr EventHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ProcessInformation
    {
        internal IntPtr Process;
        internal IntPtr Thread;
        internal uint ProcessId;
        internal uint ThreadId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct StartupInfo
    {
        internal uint Size;
        internal string? Reserved;
        internal string? Desktop;
        internal string? Title;
        internal uint X;
        internal uint Y;
        internal uint XSize;
        internal uint YSize;
        internal uint XCountChars;
        internal uint YCountChars;
        internal uint FillAttribute;
        internal uint Flags;
        internal ushort ShowWindow;
        internal ushort Reserved2Size;
        internal IntPtr Reserved2;
        internal IntPtr StandardInput;
        internal IntPtr StandardOutput;
        internal IntPtr StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct StartupInfoEx
    {
        internal StartupInfo StartupInfo;
        internal IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectBasicLimitInformation
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IoCounters
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectExtendedLimitInformation
    {
        internal JobObjectBasicLimitInformation BasicLimitInformation;
        internal IoCounters IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectBasicAccountingInformation
    {
        internal long TotalUserTime;
        internal long TotalKernelTime;
        internal long ThisPeriodTotalUserTime;
        internal long ThisPeriodTotalKernelTime;
        internal uint TotalPageFaultCount;
        internal uint TotalProcesses;
        internal uint ActiveProcesses;
        internal uint TotalTerminatedProcesses;
    }

    internal static Win32Exception LastError(string operation)
    {
        var error = Marshal.GetLastWin32Error();
        return new Win32Exception(error, $"{operation} failed with Win32 error {error} ({new Win32Exception(error).Message}).");
    }
}

internal abstract class SafeKernelHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    protected SafeKernelHandle()
        : base(ownsHandle: true)
    {
    }

    protected SafeKernelHandle(IntPtr handle)
        : base(ownsHandle: true)
    {
        SetHandle(handle);
    }

    protected override bool ReleaseHandle() => NativeMethods.CloseHandle(handle);
}

internal sealed class SafeJobHandle : SafeKernelHandle
{
    internal SafeJobHandle()
    {
    }

    internal SafeJobHandle(IntPtr handle)
        : base(handle)
    {
    }
}

internal sealed class SafeProcessHandle : SafeKernelHandle
{
    internal SafeProcessHandle(IntPtr handle)
        : base(handle)
    {
    }
}

internal sealed class SafeThreadHandle : SafeKernelHandle
{
    internal SafeThreadHandle(IntPtr handle)
        : base(handle)
    {
    }
}
