// Minimal Win32/NT surface used by the policy snapshot helper.
//
// The helper deliberately contains no service host, no process enumeration,
// no network calls, no privilege enabling, and no policy interpretation beyond
// the bounded bytes returned to the caller. Everything here is a read-only
// query against handles opened relative to a held drive-root directory handle.

using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Rac.WindowsPolicy.Helper;

internal static class NativeMethods
{
    // Access rights.
    internal const uint FileReadData = 0x0000_0001;
    internal const uint FileListDirectory = 0x0000_0001;
    internal const uint FileTraverse = 0x0000_0020;
    internal const uint FileDeleteChild = 0x0000_0040;
    internal const uint FileReadAttributes = 0x0000_0080;
    internal const uint Delete = 0x0001_0000;
    internal const uint ReadControl = 0x0002_0000;
    internal const uint WriteDac = 0x0004_0000;
    internal const uint WriteOwner = 0x0008_0000;
    internal const uint Synchronize = 0x0010_0000;
    internal const uint AccessSystemSecurity = 0x0100_0000;
    internal const uint MaximumAllowed = 0x0200_0000;
    internal const uint GenericAll = 0x1000_0000;
    internal const uint GenericWrite = 0x4000_0000;

    // Share modes. FILE_SHARE_READ without FILE_SHARE_WRITE/DELETE means a
    // concurrent writer must already be present to cause a sharing violation,
    // and no new write/rename/delete can be granted while the handle is held.
    internal const uint FileShareRead = 0x0000_0001;
    internal const uint FileShareWrite = 0x0000_0002;
    internal const uint FileShareDelete = 0x0000_0004;

    internal const uint OpenExisting = 3;

    internal const uint FileFlagOpenReparsePoint = 0x0020_0000;
    internal const uint FileFlagBackupSemantics = 0x0200_0000;
    internal const uint FileFlagOpenNoRecall = 0x0010_0000;

    // CreateFile create options that are shared with NtCreateFile.
    internal const uint FileDirectoryFile = 0x0000_0001;
    internal const uint FileSynchronousIoNonAlert = 0x0000_0020;
    internal const uint FileNonDirectoryFile = 0x0000_0040;
    internal const uint FileOpenReparsePoint = 0x0020_0000;
    internal const uint FileOpenNoRecall = 0x0040_0000;
    internal const uint FileOpen = 1;

    internal const uint ObjCaseInsensitive = 0x0000_0040;

    // File attributes.
    internal const uint FileAttributeDirectory = 0x0000_0010;
    internal const uint FileAttributeDevice = 0x0000_0040;
    internal const uint FileAttributeReparsePoint = 0x0000_0400;
    internal const uint FileAttributeOffline = 0x0000_1000;
    internal const uint FileAttributeRecallOnOpen = 0x0004_0000;
    internal const uint FileAttributeRecallOnDataAccess = 0x0040_0000;

    // Drive types.
    internal const uint DriveUnknown = 0;
    internal const uint DriveNoRootDir = 1;
    internal const uint DriveRemovable = 2;
    internal const uint DriveFixed = 3;
    internal const uint DriveRemote = 4;
    internal const uint DriveCdrom = 5;
    internal const uint DriveRamdisk = 6;

    // FILE_INFO_BY_HANDLE_CLASS.
    internal const int FileBasicInfoClass = 0;
    internal const int FileStandardInfoClass = 1;
    internal const int FileAttributeTagInfoClass = 9;
    internal const int FileIdInfoClass = 18;

    // Security bits.
    internal const uint OwnerSecurityInformation = 0x0000_0001;
    internal const uint DaclSecurityInformation = 0x0000_0004;
    internal const int SeFileObject = 1;
    internal const ushort SeDaclPresent = 0x0004;
    internal const ushort SeDaclProtected = 0x1000;
    internal const byte InheritOnlyAce = 0x08;

    // ACE types that can appear in a DACL.
    internal const byte AccessAllowedAceType = 0;
    internal const byte AccessDeniedAceType = 1;
    internal const byte SystemMandatoryLabelAceType = 17;
    internal const byte SystemResourceAttributeAceType = 18;
    internal const byte SystemScopedPolicyIdAceType = 19;
    internal const byte SystemAccessFilterAceType = 21;

    // NT status values used for fallback classification only.
    internal const int StatusFileIsADirectory = unchecked((int)0xC000_00BA);
    internal const int StatusNotADirectory = unchecked((int)0xC000_0103);

    internal const uint TokenQuery = 0x0000_0008;
    internal const int TokenUserClass = 1;

    internal const uint FileNameNormalized = 0x0000_0000;
    internal const uint VolumeNameDos = 0x0000_0000;
    internal const uint VolumeNameGuid = 0x0000_0001;

    // A policy-file snapshot is bounded at 256 KiB, matching the TypeScript
    // source policy limit. The helper refuses to allocate beyond this range.
    internal const int MaxPolicyBytes = 256 * 1024;

    [StructLayout(LayoutKind.Sequential)]
    internal struct UnicodeString
    {
        internal ushort Length;
        internal ushort MaximumLength;
        internal IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ObjectAttributes
    {
        internal int Length;
        internal IntPtr RootDirectory;
        internal IntPtr ObjectName;
        internal uint Attributes;
        internal IntPtr SecurityDescriptor;
        internal IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IoStatusBlock
    {
        internal IntPtr Status;
        internal IntPtr Information;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FileAttributeTagInfo
    {
        internal uint FileAttributes;
        internal uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FileStandardInfo
    {
        internal long AllocationSize;
        internal long EndOfFile;
        internal uint NumberOfLinks;
        internal byte DeletePending;
        internal byte Directory;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FileBasicInfo
    {
        internal long CreationTime;
        internal long LastAccessTime;
        internal long LastWriteTime;
        internal long ChangeTime;
        internal uint FileAttributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FileIdInfo
    {
        internal ulong VolumeSerialNumber;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        internal byte[] FileId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct AclSizeInformation
    {
        internal uint AceCount;
        internal uint AclBytesInUse;
        internal uint AclBytesFree;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct AceHeader
    {
        internal byte AceType;
        internal byte AceFlags;
        internal ushort AceSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SidAndAttributes
    {
        internal IntPtr Sid;
        internal uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct TokenUser
    {
        internal SidAndAttributes User;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetFileInformationByHandleEx(
        SafeFileHandle hFile,
        int fileInformationClass,
        IntPtr lpFileInformation,
        uint dwBufferSize);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern uint GetFinalPathNameByHandle(
        SafeFileHandle hFile,
        [Out] System.Text.StringBuilder lpszFilePath,
        uint cchFilePath,
        uint dwFlags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    internal static extern uint GetDriveType(string lpRootPathName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ReadFile(
        SafeFileHandle hFile,
        [Out] byte[] lpBuffer,
        uint nNumberOfBytesToRead,
        out uint lpNumberOfBytesRead,
        IntPtr lpOverlapped);

    [DllImport("kernel32.dll")]
    internal static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    internal static extern IntPtr LocalFree(IntPtr hMem);

    [DllImport("ntdll.dll")]
    internal static extern int NtCreateFile(
        out IntPtr fileHandle,
        uint desiredAccess,
        IntPtr objectAttributes,
        out IoStatusBlock ioStatusBlock,
        IntPtr allocationSize,
        uint fileAttributes,
        uint shareAccess,
        uint createDisposition,
        uint createOptions,
        IntPtr eaBuffer,
        uint ealength);

    [DllImport("advapi32.dll", SetLastError = true)]
    internal static extern uint GetSecurityInfo(
        IntPtr handle,
        int objectType,
        uint securityInfo,
        out IntPtr ownerSid,
        out IntPtr groupSid,
        out IntPtr dacl,
        out IntPtr sacl,
        out IntPtr securityDescriptor);

    [DllImport("advapi32.dll", SetLastError = true)]
    internal static extern uint GetSecurityDescriptorLength(IntPtr securityDescriptor);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetSecurityDescriptorControl(
        IntPtr securityDescriptor,
        out ushort control,
        out uint revision);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetAclInformation(
        IntPtr acl,
        out AclSizeInformation aclInformation,
        uint aclInformationLength,
        int aclInformationClass);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetAce(IntPtr acl, uint aceIndex, out IntPtr ace);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr stringSid);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetTokenInformation(
        IntPtr tokenHandle,
        int tokenInformationClass,
        IntPtr tokenInformation,
        uint tokenInformationLength,
        out uint returnLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    internal static extern uint GetLengthSid(IntPtr sid);
}
