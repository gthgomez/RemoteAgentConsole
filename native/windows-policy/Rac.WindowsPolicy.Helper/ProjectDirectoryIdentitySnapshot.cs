namespace Rac.WindowsPolicy.Helper;

/// <summary>
/// Minimal, bounded directory identity receipt. It contains only what a caller
/// needs to compare a registered project root's canonical path, fixed volume and
/// directory file identity. It deliberately contains no file bytes, ACLs, SIDs,
/// security fingerprints, process state or approval decision.
/// </summary>
internal sealed record ProjectDirectoryIdentitySnapshot(
    int SchemaVersion,
    string Status,
    string Mode,
    string DirectoryPath,
    VolumeSnapshot Volume,
    ProjectDirectorySnapshot Directory,
    string Identity);

internal sealed record ProjectDirectorySnapshot(
    string IdHex,
    int ComponentCount);
