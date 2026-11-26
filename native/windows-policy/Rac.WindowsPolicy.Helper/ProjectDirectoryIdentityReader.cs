using System.Globalization;
using Microsoft.Win32.SafeHandles;

namespace Rac.WindowsPolicy.Helper;

/// <summary>
/// One-shot identity probe for an already-qualified local project directory. It
/// reuses the strict path shape and handle-relative directory queries but does not
/// read files, list directories, evaluate ACLs, retain handles after output, or make
/// an approval/ACL/dispatch decision. The caller may compare the returned identity
/// with its own bound value; this receipt is not sufficient for admission by itself.
/// </summary>
internal static class ProjectDirectoryIdentityReader
{
    private const int SchemaVersion = 1;
    private const string Mode = "project-directory-identity";

    internal static ProjectDirectoryIdentitySnapshot Read(string input)
    {
        using var lease = Capture(input);
        return lease.Snapshot;
    }

    /// <summary>Retain the verified local directory and its ancestor chain.</summary>
    internal static ProjectDirectoryLease Capture(string input)
    {
        var shape = PolicyPath.Parse(input);
        var handles = new List<SafeFileHandle>();
        try
        {
            var root = HandleQueries.OpenDriveRoot(shape.DriveRoot);
            handles.Add(root);
            var rootIdentity = VerifyRoot(root, shape.DriveRoot, out var volumeGuid);

            var current = root;
            for (var index = 0; index < shape.Components.Length; index++)
            {
                var directory = HandleQueries.OpenDirectoryComponent(current, shape.Components[index]);
                handles.Add(directory);
                VerifyDirectory(directory, rootIdentity);
                current = directory;
            }

            var identityBefore = HandleQueries.GetIdentity(current, "directory-identity-unavailable");
            var standardBefore = HandleQueries.GetStandardInfo(current, "directory-identity-unavailable");
            var basicBefore = HandleQueries.GetBasicInfo(current, "directory-identity-unavailable");
            var finalPath = HandleQueries.GetFinalDosPath(current, "directory-path-unavailable");
            RequireExactCanonicalPath(finalPath, shape.NormalizedPath, "input-ambiguous");

            var finalVolumeGuid = HandleQueries.GetVolumeGuidPath(current, "volume-identity-unavailable");
            if (!string.Equals(finalVolumeGuid, volumeGuid, StringComparison.OrdinalIgnoreCase))
            {
                throw Denied("volume-identity-mismatch");
            }

            // Re-query the directory state before handing the held chain to the
            // caller. The one-shot probe still releases it before reporting.
            var identityAfter = HandleQueries.GetIdentity(current, "directory-changed");
            var standardAfter = HandleQueries.GetStandardInfo(current, "directory-changed");
            var basicAfter = HandleQueries.GetBasicInfo(current, "directory-changed");
            var finalPathAfter = HandleQueries.GetFinalDosPath(current, "directory-changed");
            if (!string.Equals(
                    NormalizeDriveLetter(finalPathAfter),
                    NormalizeDriveLetter(finalPath),
                    StringComparison.Ordinal))
            {
                throw Denied("directory-changed");
            }

            if (identityAfter != identityBefore
                || standardAfter.EndOfFile != standardBefore.EndOfFile
                || standardAfter.NumberOfLinks != standardBefore.NumberOfLinks
                || standardAfter.DeletePending != 0
                || standardAfter.Directory == 0
                || basicAfter.CreationTime != basicBefore.CreationTime
                || basicAfter.LastWriteTime != basicBefore.LastWriteTime
                || basicAfter.ChangeTime != basicBefore.ChangeTime
                || basicAfter.FileAttributes != basicBefore.FileAttributes)
            {
                throw Denied("directory-changed");
            }

            if (identityAfter.VolumeSerialNumber != rootIdentity.VolumeSerialNumber)
            {
                throw Denied("directory-volume-mismatch");
            }

            var snapshot = new ProjectDirectoryIdentitySnapshot(
                SchemaVersion: SchemaVersion,
                Status: "ok",
                Mode: Mode,
                DirectoryPath: finalPath,
                Volume: new VolumeSnapshot(
                    Guid: volumeGuid,
                    SerialNumberHex: rootIdentity.VolumeSerialNumber.ToString("x16", CultureInfo.InvariantCulture)),
                Directory: new ProjectDirectorySnapshot(
                    IdHex: identityAfter.FileIdHex,
                    ComponentCount: shape.Components.Length),
                Identity: ComposeIdentity(volumeGuid, identityAfter.FileIdHex));
            return new ProjectDirectoryLease(snapshot, handles);
        }
        catch
        {
            for (var index = handles.Count - 1; index >= 0; index--)
            {
                handles[index].Dispose();
            }
            throw;
        }
    }

    private static FileIdentity VerifyRoot(
        SafeFileHandle root,
        string driveRoot,
        out string volumeGuid)
    {
        var attributes = HandleQueries.GetAttributeTag(root, "volume-root-open-failed");
        if ((attributes.FileAttributes & NativeMethods.FileAttributeReparsePoint) != 0
            || attributes.ReparseTag != 0)
        {
            throw Denied("volume-root-reparse");
        }

        if ((attributes.FileAttributes & NativeMethods.FileAttributeDirectory) == 0)
        {
            throw Denied("volume-root-not-directory");
        }

        var standard = HandleQueries.GetStandardInfo(root, "volume-root-open-failed");
        if (standard.Directory == 0 || standard.DeletePending != 0)
        {
            throw Denied("volume-root-open-failed");
        }

        var finalPath = HandleQueries.GetFinalDosPath(root, "volume-root-identity-unavailable");
        RequireExactCanonicalPath(finalPath, driveRoot, "volume-root-identity-mismatch");

        var identity = HandleQueries.GetIdentity(root, "volume-root-identity-unavailable");
        volumeGuid = HandleQueries.GetVolumeGuidPath(root, "volume-identity-unavailable");
        return identity;
    }

    private static void VerifyDirectory(SafeFileHandle directory, FileIdentity rootIdentity)
    {
        var attributes = HandleQueries.GetAttributeTag(directory, "component-open-failed");
        if ((attributes.FileAttributes & NativeMethods.FileAttributeReparsePoint) != 0
            || attributes.ReparseTag != 0)
        {
            throw Denied("component-reparse");
        }

        if ((attributes.FileAttributes & NativeMethods.FileAttributeDirectory) == 0
            || (attributes.FileAttributes & NativeMethods.FileAttributeDevice) != 0)
        {
            throw Denied("component-not-directory");
        }

        if ((attributes.FileAttributes & (NativeMethods.FileAttributeOffline
                | NativeMethods.FileAttributeRecallOnOpen
                | NativeMethods.FileAttributeRecallOnDataAccess)) != 0)
        {
            throw Denied("component-offline");
        }

        var standard = HandleQueries.GetStandardInfo(directory, "component-open-failed");
        if (standard.Directory == 0 || standard.DeletePending != 0)
        {
            throw Denied("component-open-failed");
        }

        var identity = HandleQueries.GetIdentity(directory, "component-identity-unavailable");
        if (identity.VolumeSerialNumber != rootIdentity.VolumeSerialNumber)
        {
            throw Denied("component-volume-mismatch");
        }
    }

    private static string ComposeIdentity(string volumeGuid, string fileIdHex) =>
        $"{volumeGuid}#{fileIdHex}";

    private static void RequireExactCanonicalPath(string actual, string expected, string mismatchCode)
    {
        // Compare the drive letter case-insensitively, but require exact component
        // spelling. Whole-path OrdinalIgnoreCase would accept a case-only alias.
        var normalizedActual = NormalizeDriveLetter(actual);
        var normalizedExpected = NormalizeDriveLetter(expected);
        if (string.Equals(normalizedActual, normalizedExpected, StringComparison.Ordinal))
        {
            return;
        }

        if (string.Equals(normalizedActual, normalizedExpected, StringComparison.OrdinalIgnoreCase))
        {
            throw Denied("input-case-mismatch");
        }

        throw Denied(mismatchCode);
    }

    private static string NormalizeDriveLetter(string path) =>
        path.Length >= 2 && path[1] == ':'
            ? char.ToUpperInvariant(path[0]) + path[2..]
            : path;

    private static PolicyFailureException Denied(string code) => new(code, 3);
}

/// <summary>Pin one directory chain; not an enrollment or sandbox decision.</summary>
internal sealed class ProjectDirectoryLease(
    ProjectDirectoryIdentitySnapshot snapshot,
    List<SafeFileHandle> handles) : IDisposable
{
    internal ProjectDirectoryIdentitySnapshot Snapshot { get; } = snapshot;

    internal SafeFileHandle OpenRegularFile(string name)
    {
        ObjectDisposedException.ThrowIf(handles.Count == 0, this);
        if (string.IsNullOrEmpty(name) || name != Path.GetFileName(name))
            throw new ArgumentException("A local component is required.", nameof(name));
        var path = PolicyPath.Parse(Path.Combine(Snapshot.DirectoryPath, name)).NormalizedPath;
        var file = HandleQueries.OpenLeafComponent(handles[^1], name);
        try
        {
            var attributes = HandleQueries.GetAttributeTag(file, "image-identity");
            if ((attributes.FileAttributes & (NativeMethods.FileAttributeReparsePoint
                    | NativeMethods.FileAttributeDirectory | NativeMethods.FileAttributeDevice
                    | NativeMethods.FileAttributeOffline | NativeMethods.FileAttributeRecallOnOpen
                    | NativeMethods.FileAttributeRecallOnDataAccess)) != 0
                || attributes.ReparseTag != 0
                || !string.Equals(path, HandleQueries.GetFinalDosPath(file, "image-identity"), StringComparison.Ordinal)
                || HandleQueries.GetStandardInfo(file, "image-identity").DeletePending != 0)
                throw new IOException("The requested file is not a stable regular file.");
            return file;
        }
        catch
        {
            file.Dispose();
            throw;
        }
    }

    public void Dispose()
    {
        for (var index = handles.Count - 1; index >= 0; index--)
            handles[index].Dispose();
        handles.Clear();
    }
}
