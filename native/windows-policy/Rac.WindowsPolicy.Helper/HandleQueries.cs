using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Rac.WindowsPolicy.Helper;

internal sealed record FileIdentity(ulong VolumeSerialNumber, string FileIdHex);

internal static class HandleQueries
{
    private const uint DirectoryAccess =
        NativeMethods.FileTraverse
        | NativeMethods.FileReadAttributes
        | NativeMethods.ReadControl
        | NativeMethods.Synchronize;

    private const uint LeafAccess =
        NativeMethods.FileReadData
        | NativeMethods.FileReadAttributes
        | NativeMethods.ReadControl
        | NativeMethods.Synchronize;

    private const uint InspectAccess =
        NativeMethods.FileReadAttributes
        | NativeMethods.ReadControl
        | NativeMethods.Synchronize;

    private const uint DirectoryOptions =
        NativeMethods.FileDirectoryFile
        | NativeMethods.FileOpenReparsePoint
        | NativeMethods.FileSynchronousIoNonAlert;

    private const uint LeafOptions =
        NativeMethods.FileNonDirectoryFile
        | NativeMethods.FileOpenReparsePoint
        | NativeMethods.FileSynchronousIoNonAlert
        | NativeMethods.FileOpenNoRecall;

    private const uint InspectOptions =
        NativeMethods.FileOpenReparsePoint
        | NativeMethods.FileSynchronousIoNonAlert;

    internal static SafeFileHandle OpenDriveRoot(string driveRoot)
    {
        var driveType = NativeMethods.GetDriveType(driveRoot);
        if (driveType != NativeMethods.DriveFixed)
        {
            throw Denied("volume-not-local-fixed");
        }

        var raw = NativeMethods.CreateFileW(
            driveRoot,
            DirectoryAccess,
            NativeMethods.FileShareRead,
            IntPtr.Zero,
            NativeMethods.OpenExisting,
            NativeMethods.FileFlagBackupSemantics
            | NativeMethods.FileFlagOpenReparsePoint
            | NativeMethods.FileFlagOpenNoRecall,
            IntPtr.Zero);

        if (raw == IntPtr.Zero || raw == new IntPtr(-1))
        {
            throw Denied("volume-root-open-failed");
        }

        return new SafeFileHandle(raw, ownsHandle: true);
    }

    /// <summary>
    /// Opens one path component relative to an already-held directory handle.
    /// This is the primary anti-reparse/anti-race primitive: the name is never
    /// resolved through a path that the caller could have swapped underneath us.
    /// </summary>
    internal static SafeFileHandle? TryOpenRelative(
        SafeFileHandle parent,
        string name,
        uint desiredAccess,
        uint createOptions,
        out int ntStatus)
    {
        var nameBuffer = Marshal.StringToHGlobalUni(name);
        var unicodeBuffer = Marshal.AllocHGlobal(Marshal.SizeOf<NativeMethods.UnicodeString>());
        var attributesBuffer = Marshal.AllocHGlobal(Marshal.SizeOf<NativeMethods.ObjectAttributes>());
        try
        {
            var unicode = new NativeMethods.UnicodeString
            {
                Length = checked((ushort)(name.Length * 2)),
                MaximumLength = checked((ushort)((name.Length * 2) + 2)),
                Buffer = nameBuffer,
            };
            Marshal.StructureToPtr(unicode, unicodeBuffer, fDeleteOld: false);

            var attributes = new NativeMethods.ObjectAttributes
            {
                Length = Marshal.SizeOf<NativeMethods.ObjectAttributes>(),
                RootDirectory = parent.DangerousGetHandle(),
                ObjectName = unicodeBuffer,
                Attributes = NativeMethods.ObjCaseInsensitive,
                SecurityDescriptor = IntPtr.Zero,
                SecurityQualityOfService = IntPtr.Zero,
            };
            Marshal.StructureToPtr(attributes, attributesBuffer, fDeleteOld: false);

            ntStatus = NativeMethods.NtCreateFile(
                out var raw,
                desiredAccess,
                attributesBuffer,
                out _,
                IntPtr.Zero,
                0,
                NativeMethods.FileShareRead,
                NativeMethods.FileOpen,
                createOptions,
                IntPtr.Zero,
                0);

            if (ntStatus >= 0 && raw != IntPtr.Zero && raw != new IntPtr(-1))
            {
                return new SafeFileHandle(raw, ownsHandle: true);
            }

            return null;
        }
        finally
        {
            Marshal.FreeHGlobal(attributesBuffer);
            Marshal.FreeHGlobal(unicodeBuffer);
            Marshal.FreeHGlobal(nameBuffer);
        }
    }

    internal static SafeFileHandle OpenDirectoryComponent(SafeFileHandle parent, string name)
    {
        var handle = TryOpenRelative(parent, name, DirectoryAccess, DirectoryOptions, out var status);
        if (handle is not null)
        {
            return handle;
        }

        // The primary open can fail before attributes are available (for
        // example a junction opened with FILE_DIRECTORY_FILE). Open the object
        // itself without following it and classify the refusal precisely.
        var inspect = TryOpenRelative(parent, name, InspectAccess, InspectOptions, out _);
        if (inspect is not null)
        {
            try
            {
                var attributes = GetAttributeTag(inspect, "component-open-failed");
                if ((attributes.FileAttributes & NativeMethods.FileAttributeReparsePoint) != 0
                    || attributes.ReparseTag != 0)
                {
                    throw Denied("component-reparse");
                }

                if ((attributes.FileAttributes & NativeMethods.FileAttributeDirectory) == 0)
                {
                    throw Denied("component-not-directory");
                }
            }
            finally
            {
                inspect.Dispose();
            }
        }

        _ = status;
        throw Denied("component-open-failed");
    }

    internal static SafeFileHandle OpenLeafComponent(SafeFileHandle parent, string name)
    {
        var handle = TryOpenRelative(parent, name, LeafAccess, LeafOptions, out _);
        if (handle is not null)
        {
            return handle;
        }

        var inspect = TryOpenRelative(parent, name, InspectAccess, InspectOptions, out _);
        if (inspect is null)
        {
            // A directory commonly rejects FILE_NON_DIRECTORY_FILE. Re-open the
            // object itself as a directory solely to classify the refusal.
            inspect = TryOpenRelative(parent, name, DirectoryAccess, DirectoryOptions, out _);
        }

        if (inspect is not null)
        {
            try
            {
                var attributes = GetAttributeTag(inspect, "file-open-failed");
                if ((attributes.FileAttributes & NativeMethods.FileAttributeReparsePoint) != 0
                    || attributes.ReparseTag != 0)
                {
                    throw Denied("file-reparse");
                }

                if ((attributes.FileAttributes & (NativeMethods.FileAttributeDirectory | NativeMethods.FileAttributeDevice)) != 0)
                {
                    throw Denied("file-not-regular");
                }
            }
            finally
            {
                inspect.Dispose();
            }
        }

        throw Denied("file-open-failed");
    }

    internal static T Query<T>(SafeFileHandle handle, int informationClass, string failureCode)
        where T : struct
    {
        var size = Marshal.SizeOf<T>();
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!NativeMethods.GetFileInformationByHandleEx(handle, informationClass, buffer, (uint)size))
            {
                throw Denied(failureCode);
            }

            return Marshal.PtrToStructure<T>(buffer);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    internal static NativeMethods.FileAttributeTagInfo GetAttributeTag(SafeFileHandle handle, string failureCode) =>
        Query<NativeMethods.FileAttributeTagInfo>(handle, NativeMethods.FileAttributeTagInfoClass, failureCode);

    internal static NativeMethods.FileStandardInfo GetStandardInfo(SafeFileHandle handle, string failureCode) =>
        Query<NativeMethods.FileStandardInfo>(handle, NativeMethods.FileStandardInfoClass, failureCode);

    internal static NativeMethods.FileBasicInfo GetBasicInfo(SafeFileHandle handle, string failureCode) =>
        Query<NativeMethods.FileBasicInfo>(handle, NativeMethods.FileBasicInfoClass, failureCode);

    internal static FileIdentity GetIdentity(SafeFileHandle handle, string failureCode)
    {
        var info = Query<NativeMethods.FileIdInfo>(handle, NativeMethods.FileIdInfoClass, failureCode);
        if (info.FileId is null
            || info.FileId.Length != 16
            || info.VolumeSerialNumber == 0
            || info.FileId.All(value => value == 0))
        {
            throw Denied(failureCode);
        }

        return new FileIdentity(info.VolumeSerialNumber, Convert.ToHexString(info.FileId).ToLowerInvariant());
    }

    internal static string GetFinalDosPath(SafeFileHandle handle, string failureCode)
    {
        var path = GetFinalPath(handle, NativeMethods.VolumeNameDos, failureCode);
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
        {
            throw Denied("path-not-local");
        }

        if (path.StartsWith(@"\\?\", StringComparison.Ordinal))
        {
            path = path[4..];
        }

        if (!IsDrivePath(path))
        {
            throw Denied(failureCode);
        }

        return path;
    }

    internal static string GetVolumeGuidPath(SafeFileHandle handle, string failureCode)
    {
        var path = GetFinalPath(handle, NativeMethods.VolumeNameGuid, failureCode);
        if (!path.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase))
        {
            throw Denied(failureCode);
        }

        var closingBrace = path.IndexOf('}');
        if (closingBrace < 0)
        {
            throw Denied(failureCode);
        }

        return path[..(closingBrace + 1)].ToLowerInvariant();
    }

    private static string GetFinalPath(SafeFileHandle handle, uint flags, string failureCode)
    {
        for (var capacity = 512; capacity <= 65_536; capacity *= 2)
        {
            var builder = new StringBuilder(capacity);
            var length = NativeMethods.GetFinalPathNameByHandle(handle, builder, (uint)capacity, flags);
            if (length == 0)
            {
                throw Denied(failureCode);
            }

            if (length < capacity)
            {
                return builder.ToString();
            }
        }

        throw Denied(failureCode);
    }

    internal static byte[] ReadBounded(SafeFileHandle handle, long length)
    {
        if (length <= 0 || length > NativeMethods.MaxPolicyBytes)
        {
            throw Denied(length == 0 ? "file-empty" : "file-oversize");
        }

        var result = new byte[checked((int)length)];
        var offset = 0;
        var chunk = new byte[Math.Min(16 * 1024, result.Length)];
        while (offset < result.Length)
        {
            var requested = Math.Min(chunk.Length, result.Length - offset);
            if (!NativeMethods.ReadFile(handle, chunk, (uint)requested, out var read, IntPtr.Zero))
            {
                throw Denied("read-failed");
            }

            if (read == 0)
            {
                throw Denied("file-changed");
            }

            Buffer.BlockCopy(chunk, 0, result, offset, checked((int)read));
            offset += checked((int)read);
        }

        return result;
    }

    internal static string? FileTimeToUtc(long fileTime)
    {
        if (fileTime == 0)
        {
            return null;
        }

        try
        {
            return DateTime.FromFileTimeUtc(fileTime).ToString("O", CultureInfo.InvariantCulture);
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private static bool IsDrivePath(string path) =>
        path.Length >= 3
        && path[0] is >= 'A' and <= 'Z' or >= 'a' and <= 'z'
        && path[1] == ':'
        && path[2] == '\\';

    private static PolicyFailureException Denied(string code) => new(code, 3);
}
