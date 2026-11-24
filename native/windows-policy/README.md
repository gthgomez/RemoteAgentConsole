# Windows owner-only policy read/identity helper

This directory contains a one-shot, local Windows helper used to read a
restricted-deployment policy file and return a bounded snapshot plus stable
volume/file/directory identity, or to return a minimal directory identity for an
already-qualified local project root through an explicit opt-in mode. It is a helper only: it does not host a
service, parse the policy, load a live policy, discover processes, listen on a
socket, enable privileges, or act as a controller.

The TypeScript Windows policy path in `patches/happier/` remains fail-closed
until a trusted fixed package binding for this helper is reviewed. No patch in
this change invokes the helper.

## Build and qualification artifact

The qualification artifact is a pinned, self-contained Windows x64 single-file
publish. It does not require a globally installed .NET runtime. The publish script
pins SDK `9.0.321` and runtime framework `8.0.34`; either a mismatch or an
unavailable runtime pack is a hard failure. Pass `-DotnetPath` to bind an explicit
trusted `dotnet.exe`; otherwise the resolved `dotnet` on the build host is used.

Provenance warning: the SDK path/version pin identifies the toolchain, not the
source or build host. The artifact SHA-256 identifies emitted bytes, not source
authenticity. Source/build-host trust and package trust binding remain external.
No production binding is claimed here.

Build from a scratch copy so the repository stays free of `bin/` and `obj/`:

```powershell
$scratch = Join-Path $env:LOCALAPPDATA ('rac-policy-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $scratch 'source') | Out-Null
Get-ChildItem -LiteralPath native/windows-policy/Rac.WindowsPolicy.Helper -File |
  Copy-Item -Destination (Join-Path $scratch 'source')
pwsh -NoProfile -File native/windows-policy/publish-artifact.ps1 `
  -SourceRoot (Join-Path $scratch 'source') `
  -OutputDir (Join-Path $scratch 'artifact') `
  -DotnetPath 'C:\Program Files\dotnet\dotnet.exe'
```

The script writes exactly one file, `rac-windows-policy-helper.exe`, plus a
hashable result object. It does not sign the artifact. It parses the actual
HostWriter bundle manifest from the emitted bytes (marker, header, flags, entry
types) rather than inferring extraction from the publish flag. Any entry that
would require extraction is a hard failure. This artifact measured: header 6.0,
flags 0, 169 assemblies, one deps JSON, one runtimeconfig JSON, zero entries
requiring extraction.

The fixture publishes twice and fails if hashes or measured manifests differ. This
is same-host determinism across two source-copy paths, not a claim of cross-host
reproducibility.

Prerequisite if the publish is blocked: .NET SDK `9.0.321` and
`Microsoft.NETCore.App.Runtime.win-x64` `8.0.34` (plus the matching host pack)
must be restorable from the configured NuGet source. Do not substitute
framework-dependent output as a packaged artifact.

## Native verification

```powershell
pwsh -NoProfile -File qualification/windows/policy-file-fixture.ps1
```

The fixture:

- treats the supplied `-ScratchRoot` as a **parent**, refuses a parent or ancestor
  that is a reparse point or canonical alias where detectable, reserves a unique
  `RacWindowsPolicyFixture-*` child, writes an ownership marker, and removes only
  that owned child;
- publishes the self-contained non-extracting single-file artifact twice,
  requires identical hashes, and runs every case against the emitted artifact;
- uses only synthetic policy files and synthetic ACLs;
- covers Unicode/space paths, protected owner-only ACLs, unsafe file/directory
  ACLs, unprotected DACLs, unsafe ancestors, create-only/delete-child/
  change-permissions ancestor rights, leaf and ancestor junctions, non-regular
  leaves, empty/oversize/maximum-size files, hard links, an existing writer, a
  delete-capable handle sharing denial, replacement identity changes, in-place hash changes,
  protected ACL fingerprint drift, exact canonical spelling, depth/component
  bounds, runtime-environment hardening, unsupported deny ACEs, invalid
  inputs, and sensitive-output suppression;
- exits nonzero on any failed case and prints a JSON summary with artifact/source
  SHA-256 values, publish inputs, measured bundle manifest, binding commit/tree,
  scoped dirty state, `dotnet.exe` hash, same-host reproducibility state and
  coverage gaps.

The default scratch parent is `%LOCALAPPDATA%`; the fixture creates and removes
only its unique child. Do not point it at a shared-write tree unless that tree's
ancestor chain is trusted: the helper deliberately rejects an ancestor owned by,
or deletable/ACL-reassignable by, an untrusted principal. If `%LOCALAPPDATA%` is
itself redirected through a junction or another reparse point, pass a direct
`-ScratchRoot` below a non-reparse directory.

## Launch boundary (mandatory activation condition)

The qualification artifact is published with
`IncludeNativeLibrariesForSelfExtract=false`. It is a self-contained single-file
executable with no application native libraries and no native extraction
directory. `DOTNET_BUNDLE_EXTRACT_BASE_DIR` is not used; setting it (or any other
`DOTNET_*`, `COREHOST_*`, `COMPLUS_*`, `NATIVE_DLL_SEARCH_DIRECTORIES` or
`CLR_LOADER_OPTIMIZATION` override) is rejected with `runtime-env-untrusted`.
The launcher must clear those inherited variables. Default or inherited TEMP is
not used for extraction. `COREHOST_*`/`DOTNET_*` effects occur in the host before
managed Main; the launcher must clear them before launch. `LaunchEnvironment`
validation is **post-Main defense-in-depth**, not a pre-Main or pre-host fence,
and is not a substitute for a clean launch environment.

The measured bundle manifest is the extraction property; no extraction is
claimed from the publish flag alone. This is a launch precondition, not an
activation or production binding.

If a future publish reintroduces native extraction, an installer-provisioned
fixed absolute owner-only non-reparse extraction directory, cleanup/protection of
extracted runtime bytes, and separate launch-boundary attestation are mandatory.
Hash validation of the artifact alone does not attest previously extracted native
components. Runtime dependency bytes are inside this emitted artifact; trust in
the source/build host remains external.

Fixture setup failures are JSON with an explicit `errorCode`, for example
`fixture-custody-parent-drive-root`, `fixture-custody-parent-reparse`,
`fixture-custody-parent-alias`, `fixture-custody-ancestor-reparse`,
`fixture-source-copy-failed`, `fixture-artifact-sdk-mismatch`,
`fixture-artifact-publish-failed`, `fixture-artifact-not-single-file` and
`fixture-artifact-not-reproducible`. Per-case failures carry a `code` field;
helper denial codes remain in the case detail.

## Provisioning note

The helper does not create or repair ACLs. Provision a protected DACL containing
only the owner SID. For a newly created object, a starting point is:

```powershell
icacls <path> /inheritance:r /grant:r "*<ownerSid>:(F)"
```

Verify the resulting DACL; Windows can add explicit logon-session ACEs when a
file is replaced, and `/grant:r` does not remove unrelated explicit ACEs. The
fixture uses `FileSystemAclExtensions` to build exact owner-only descriptors and
to remove such extra ACEs after replacement. The owner must be the process token
user SID; a policy file owned by Administrators or SYSTEM is rejected even if its
DACL is otherwise private. The caller must also retain the exact canonical
component spelling of the policy or project-directory path; the helper normalizes
only the drive-letter case.

## One-shot invocation contract

Use a fixed absolute helper path, not a `PATH`/environment lookup. The caller
must treat the helper package as part of the trusted package: pin the SHA-256 of
the emitted single-file `.exe` and the pinned source/publish inputs against the
package manifest, and keep the package directory non-writable by other users.
If a framework-dependent build is ever used for development, pin the `.dll`,
`.deps.json` and `.runtimeconfig.json` as well; the apphost `.exe` alone does not
bind the code. A helper that can be replaced can lie about every field below.
Package trust binding, project-directory approval/admission and effect-lifetime
TOCTOU remain downstream of this helper. The opt-in directory-identity mode returns
only comparison material; it does not approve a project or bind policy semantics.

Recommended minimal contract:

1. Clear inherited `DOTNET_*`/`COREHOST_*`/`COMPLUS_*` and native-loading
   overrides, then start the helper with `shell:false`, a short timeout (for
   example 15 seconds), and a bounded stdout capture (for example 1 MiB). Use
   either exactly one argument (the canonical policy path) or exactly
   `--project-directory-identity <canonical directory path>` for the opt-in
   project-root identity receipt. No extraction directory is used.
2. Require exit code `0`, empty stderr, one JSON object on stdout, and
   `status: "ok"`.
3. In policy mode, parse `bytesBase64` and validate the policy schema in the
   privileged caller. In directory-identity mode, read only the bounded identity
   receipt; it contains no policy bytes. Never log snapshot bytes or the path from
   an error response.
4. In policy mode, bind `identities.volume`, `identities.file`,
   `identities.directory`, `protection.fileFingerprint`,
   `protection.directoryFingerprint`, and `sha256`, plus `file.size`, at startup.
5. Before every Windows admission, run the helper again against the same path.
   In policy mode require exact equality of the bound identity, protection
   fingerprint and hash fields. In directory-identity mode require exact equality
   of the bound canonical path, fixed volume and directory identity. Any change,
   any failure, any malformed response, or any timeout is a denial. Do not rebind
   automatically after a change. Directory identity alone is not sufficient for
   dispatch admission.
6. Pass the exact canonical component spelling. The helper normalizes only the
   drive-letter case; a case-only mismatch is `input-case-mismatch`. Do not
   lowercase, shorten, or re-resolve the path with Node before invoking it.
7. Do not use Node `realpathSync`, `lstatSync`, Unix mode bits, or copied ACL
   text as the Windows authority. Use the helper's canonical path and identity
   fields. The helper's identity format is
   `\\?\volume{guid}#<32-hex-file-id>`; it is not Node's `dev:ino` string.

A full re-read per admission is the minimal safe recheck because the helper is
one-shot and holds no state. Policy mode is bounded at 256 KiB and is appropriate
for a low-rate local control plane. The opt-in project-directory mode is a fresh
handle-relative identity probe: it releases its handles before writing output,
does not read or list files, does not evaluate ACLs/SIDs, and is not a retained
handle across check/use or a dispatch-admission decision. A policy identity-only
recheck with held handles remains intentionally out of scope.

### Output schema (success)

```json
{
  "schemaVersion": 1,
  "status": "ok",
  "path": "C:\\Users\\me\\AppData\\Local\\Rac\\policy\\policy.json",
  "directoryPath": "C:\\Users\\me\\AppData\\Local\\Rac\\policy",
  "bytesBase64": "...",
  "byteLength": 1234,
  "sha256": "<64 lowercase hex>",
  "volume": {
    "guid": "\\\\?\\volume{...}",
    "serialNumberHex": "<16 lowercase hex>"
  },
  "file": {
    "idHex": "<32 lowercase hex>",
    "size": 1234,
    "numberOfLinks": 1,
    "lastWriteTimeUtc": "2026-11-24T...Z",
    "changeTimeUtc": "2026-11-24T...Z"
  },
  "directory": {
    "path": "C:\\Users\\me\\AppData\\Local\\Rac\\policy",
    "idHex": "<32 lowercase hex>"
  },
  "identities": {
    "volume": "\\\\?\\volume{...}",
    "file": "\\\\?\\volume{...}#<32 hex>",
    "directory": "\\\\?\\volume{...}#<32 hex>"
  },
  "protection": {
    "ownerSidVerified": true,
    "daclProtected": true,
    "daclOwnerOnly": true,
    "parentChainSafe": true,
    "fileFingerprint": "<64 lowercase hex>",
    "directoryFingerprint": "<64 lowercase hex>"
  }
}
```

`fileFingerprint` and `directoryFingerprint` are SHA-256 hashes of the
self-relative owner/DACL security descriptors read from the leaf and the held
immediate-directory handles. They are re-read and compared immediately before
the handles are released. They are not a substitute for rechecking after the
helper exits.

The file bytes, file identity, and file state come from the same open leaf
handle. The directory identity comes from the held parent-directory handle. The
volume GUID comes from the same leaf handle and is checked against the held
drive-root handle.
Policy mode's `directoryPath`/`directory` identity is the policy file's immediate
parent, not the registered project root. Use the opt-in directory mode when the
registered project root must be identified independently.

### Project-directory identity schema (success)

```json
{
  "schemaVersion": 1,
  "status": "ok",
  "mode": "project-directory-identity",
  "directoryPath": "C:\\work\\project",
  "volume": {
    "guid": "\\\\?\\volume{...}",
    "serialNumberHex": "<16 lowercase hex>"
  },
  "directory": {
    "idHex": "<32 lowercase hex>",
    "componentCount": 3
  },
  "identity": "\\\\?\\volume{...}#<32 lowercase hex>"
}
```

This receipt is deliberately bounded to canonical path, fixed-volume GUID/serial,
directory file ID and component count. It contains no policy bytes, file entries,
ACLs, SIDs, security fingerprints or approval result. A successful probe means the
component chain was local fixed, non-reparse directories with an exact canonical
spelling and a stable directory identity across the final re-query; it does not
mean the project is approved, ACL-safe, policy-bound or eligible for dispatch. This
is a qualification/library probe, not a production path or host binding. The handles
are released before the receipt is written, so this is not a retained-handle across
check/use; callers must run it again and compare the bound fields.

### Errors

Errors are a single JSON object with `schemaVersion`, `status`
(`invalid`, `denied`, or `error`), and a stable `code`. They never include the
input path, SIDs, ACL text, exception messages, or stack traces.

Exit codes: `0` success, `2` invalid input/usage, `3` denied/security failure,
`4` unexpected I/O/internal failure.

Representative denial codes include:

`input-empty`, `input-too-long`, `input-too-deep`, `input-invalid`,
`input-not-drive-absolute`, `input-drive-root`, `input-alternate`,
`input-component-invalid`, `input-case-mismatch`, `volume-not-local-fixed`,
`volume-root-*`, `component-reparse`, `component-not-directory`,
`component-volume-mismatch`, `directory-*`, `directory-changed`,
`directory-path-unavailable`, `directory-identity-unavailable`,
`parent-owner-untrusted`,
`parent-dacl-unsafe`, `parent-dacl-unsupported`, `runtime-env-untrusted`,
`file-reparse`,
`file-not-regular`, `file-empty`, `file-oversize`, `file-hardlinked`,
`file-offline`, `file-delete-pending`, `file-owner-mismatch`,
`file-dacl-unprotected`, `file-dacl-unexpected-trustee`,
`file-dacl-unsupported`, `file-changed`, `file-security-changed`,
`directory-security-changed`, `read-failed`.

## Security decisions

- **Path shape and bounds.** Only an absolute local drive path with
  backslash-separated components is accepted. Drive roots, drive-relative paths,
  UNC/device/extended prefixes, forward slashes, ADS colons, `.`/`..`, trailing
  dots/spaces, reserved device names, and (via final canonical path comparison)
  short-name or other aliases are refused. A file directly in a drive root is
  also refused because the root cannot be a private owner-only immediate
  directory. Components are limited to 255 UTF-16 code units, the path to 8192
  characters and 64 components. Component spelling must exactly match the
  canonical path; only the drive-letter case is normalized. A case-only mismatch
  is `input-case-mismatch`, not an accepted alias. This avoids relying on
  ambiguous whole-path `OrdinalIgnoreCase` behavior on case-sensitive NTFS
  directories.
- **Volume.** `GetDriveType` must be `DRIVE_FIXED`; remote, removable, RAM,
  optical and unknown volumes fail closed. This is deliberately stricter than
  "local" and can be widened later if removable policy media are required.
- **Handle-relative resolution.** The helper opens the drive root, then each
  component relative to the already-held parent directory handle using
  `NtCreateFile`. No component name is re-resolved through a path that an
  attacker could swap. Every component is opened with
  `FILE_OPEN_REPARSE_POINT`, queried for reparse/directory/device/offline/recall
  attributes, and held with `FILE_SHARE_READ` only (no write/delete sharing).
- **Leaf.** The leaf must be a regular non-reparse file with one link, bounded
  size, no offline/recall/delete-pending state, and the same volume as the root.
  The helper reads exactly the opened handle's bytes, then re-queries identity,
  standard and basic information and refuses if anything changed. The held
  no-share-write/no-share-delete handle blocks new writes and replacement for the
  duration of the one-shot read. File sharing does **not** by itself fence
  `WRITE_DAC`; the helper re-reads and compares the leaf and immediate-directory
  owner/DACL fingerprints before releasing the handles. A mutation after that
  final comparison and before the caller acts is effect-lifetime TOCTOU and is
  downstream.
- **ACLs by SID.** The leaf and its immediate directory must have a protected
  DACL with only the current token user's SID in allow ACEs and an effective
  owner allow ACE. Owner/trustee comparisons use `ConvertSidToStringSid` and
  the process token user SID; Unix modes and ACL text are never consulted.
  Ancestors must be owned by the current user, SYSTEM, Administrators, or
  TrustedInstaller, and must not grant an untrusted SID delete,
  delete-child, change-permissions, take-ownership, generic-write/all, or
  system-security access.
- **Create-only ancestor assumption.** An ancestor ACE that grants only
  `FILE_ADD_FILE`/`FILE_ADD_SUBDIRECTORY` is intentionally allowed. It can create
  a new name in that directory but cannot delete, rename or replace an existing
  ancestor or the already-resolved policy name, and the immediate directory is
  still strict owner-only. A create-only directory could be used to pre-create a
  decoy path before provisioning; owner/DACL identity checks and the leaf owner
  check fail closed on a decoy. `GENERIC_WRITE` is still rejected conservatively
  because it can include attribute/EA writes. Read/execute sharing on ancestors
  is likewise not a replacement capability.
- **Project-directory identity mode.** The opt-in mode reuses the same strict
  drive-root and handle-relative `NtCreateFile` component walk, `FILE_OPEN_REPARSE_POINT`,
  fixed-volume, directory/device/offline and canonical-path checks as policy mode,
  but opens only directories and performs no file read or directory listing. It
  re-queries directory identity/standard/basic information after the canonical path
  check and fails with `directory-changed` if the object changed. It intentionally
  does not evaluate ACLs/SIDs, emit security fingerprints, retain handles after
  output, or decide project approval/dispatch admission.
- **Sensitive failures.** All failures are stable codes. The helper does not
  write the path, SID, ACL, or exception to stdout/stderr.

## Known gaps and boundary

- The project-directory identity mode is not an ACL, ownership, policy-content or
  project-approval determination. It returns only directory path/volume/file
  identity material. It is not a retained handle across check/use and is not
  sufficient for dispatch admission; the caller must bind and recheck it.
- Project-directory mode releases its handles before output, so replacement or
  ACL changes after the final identity query are effect-lifetime TOCTOU. The
  fixture covers stable/replaced directory identity, wrong kind, junction and
  short/case aliases, not a deterministic within-probe replacement race.
- The existing policy snapshot's `directory` is the policy file's immediate parent,
  not the registered project root. Using it as a project identity would be a shape
  error; use the opt-in directory mode for that purpose.
- Non-fixed/remote project volumes and short-name generation unavailability are
  system-dependent; policy mode already fails closed on non-fixed volumes, and
  the short-alias identity case is `UNSUPPORTED` when 8.3 names are unavailable.
- The shared strict path shape refuses a drive root as a project directory; a
  registered project root must be below the drive root. Drive-substitution aliases
  are not separately probed; short/case and junction aliases are covered.
- Directory identity mode checks each component when opened and re-reads the final
  directory identity/standard/basic state before release; earlier component handles
  are not re-read at the end. The final directory replacement test and canonical
  path checks cover the intended identity witness, not an all-component retained
  snapshot. A concurrent top-level file create, delete, or rename can change
  directory metadata and yield `directory-changed`. A fresh identity probe can
  be taken once the directory is stable; it does not retry an admitted effect.
- Administrator/SYSTEM can take ownership or use backup/restore privileges
  regardless of the DACL. "Owner-only" means owner-only under normal access
  checks, not a guarantee against a local administrator, and it does not
  isolate another process running as the same user.
- The ancestor rule is a conservative DACL heuristic, not a full effective
  access calculation. It deliberately ignores read-only sharing and create-only
  rights on ancestors, and rejects object/callback ACEs rather than interpreting
  them. The fixture exercises create-only allowed plus delete-child and
  change-permissions denied.
- A true file symlink fixture could not be created without
  `SeCreateSymbolicLinkPrivilege` in this environment. A directory junction
  covers the leaf-reparse refusal and a junction covers the ancestor case.
- If writing the fixture ownership marker fails, cleanup refuses to delete the
  unmarked child; the child may be leaked rather than risk deleting caller-owned
  data. This is deliberate.
- The leaf/immediate-directory strict ACL rejects DENY ACEs as unsupported; the
  ancestor check ignores DENY ACEs because they cannot grant replacement access.
  Ancestor DENY behavior is not separately exercised.
- Owner mismatch, non-fixed/remote volumes, ReFS 128-bit IDs, and long paths
  above the documented 8192-character/64-component bound are not exercised by
  the fixture. A deterministic within-read ACL or replacement race is not forced;
  the helper re-reads fingerprints before release, and cross-run fingerprint
  drift plus a delete-capable handle sharing denial are covered. Ancestor owner/DACL is checked
  before the leaf read but is not re-read at the end; only the leaf and immediate
  directory are re-read.
- Case-sensitive NTFS directories are not probed. The helper instead requires
  exact canonical component spelling and rejects case-only mismatches, so it
  does not depend on case-sensitive siblings behaving like aliases.
- The emitted single-file artifact is self-contained, non-extracting and
  unsigned. Production signing, fixed-path installation, package trust binding,
  project-directory approval/admission and effect-lifetime TOCTOU remain downstream.
  No signature is pretended here.
- If native extraction is reintroduced in a future publish, protected extraction
  and runtime-dependency bytes become a new mandatory launch boundary; artifact
  hash validation alone would not attest previously extracted components.
- The project is built for x64. ARM64 Windows is not exercised.
- The helper does not validate the policy JSON. The caller remains responsible
  for schema validation, project identity binding, and policy semantics.
