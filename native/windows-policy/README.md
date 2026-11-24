# Windows owner-only policy read/identity helper

This directory contains a one-shot, local Windows helper used to read a
restricted-deployment policy file and return a bounded snapshot plus stable
volume/file/directory identity. It is a helper only: it does not host a
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
New-Item -ItemType Directory -Path $scratch | Out-Null
Copy-Item native/windows-policy/Rac.WindowsPolicy.Helper -Destination (Join-Path $scratch 'source') -Recurse
pwsh -NoProfile -File native/windows-policy/publish-artifact.ps1 `
  -SourceRoot (Join-Path $scratch 'source') `
  -OutputDir (Join-Path $scratch 'artifact') `
  -DotnetPath 'C:\Program Files\dotnet\dotnet.exe'
```

The script writes exactly one file, `rac-windows-policy-helper.exe`, plus a
hashable result object. It does not sign the artifact. The fixture publishes
twice and fails if the hashes differ; the current build is reproducible across
those publications and source-copy paths.

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
  pending delete handle, replacement identity changes, in-place hash changes,
  protected ACL fingerprint drift, exact canonical spelling, depth/component
  bounds, runtime-environment hardening, unsupported deny ACEs, invalid
  inputs, and sensitive-output suppression;
- exits nonzero on any failed case and prints a JSON summary with artifact/source
  SHA-256 values, publish inputs, reproducibility state and coverage gaps.

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
managed Main; the launcher must clear them before launch. The helper's rejection
is a post-host-start assertion, not a substitute for a clean launch environment.

This closes NB-1 as a mandatory activation condition by removing native
extraction, rather than relying on an extraction environment the apphost does not
consume. It does not activate or production-bind the helper.

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
component spelling of the policy path; the helper normalizes only the drive-letter
case.

## One-shot invocation contract

Use a fixed absolute helper path, not a `PATH`/environment lookup. The caller
must treat the helper package as part of the trusted package: pin the SHA-256 of
the emitted single-file `.exe` and the pinned source/publish inputs against the
package manifest, and keep the package directory non-writable by other users.
If a framework-dependent build is ever used for development, pin the `.dll`,
`.deps.json` and `.runtimeconfig.json` as well; the apphost `.exe` alone does not
bind the code. A helper that can be replaced can lie about every field below.
Package trust binding, project-directory identity and effect-lifetime TOCTOU
remain downstream of this helper.

Recommended minimal contract:

1. Clear inherited `DOTNET_*`/`COREHOST_*`/`COMPLUS_*` and native-loading
   overrides, then start the helper with `shell:false`, exactly one argument
   (the canonical policy path), a short timeout (for example 15 seconds), and a
   bounded stdout capture (for example 1 MiB). No extraction directory is used.
2. Require exit code `0`, empty stderr, one JSON object on stdout, and
   `status: "ok"`.
3. Parse `bytesBase64` and validate the policy schema in the privileged caller.
   Never log the snapshot bytes or the policy path from an error response.
4. Bind `identities.volume`, `identities.file`, `identities.directory`,
   `protection.fileFingerprint`, `protection.directoryFingerprint`, and `sha256`,
   plus `file.size`, at startup.
5. Before every Windows admission, run the helper again against the same path.
   Require `status: "ok"` and exact equality of the bound identity, protection
   fingerprint and hash fields. Any change, any failure, any malformed response,
   or any timeout is a denial. Do not rebind automatically after an identity or
   protection change.
6. Pass the exact canonical component spelling. The helper normalizes only the
   drive-letter case; a case-only mismatch is `input-case-mismatch`. Do not
   lowercase, shorten, or re-resolve the path with Node before invoking it.
7. Do not use Node `realpathSync`, `lstatSync`, Unix mode bits, or copied ACL
   text as the Windows authority. Use the helper's canonical path and identity
   fields. The helper's identity format is
   `\\?\volume{guid}#<32-hex-file-id>`; it is not Node's `dev:ino` string.

A full re-read per admission is the minimal safe recheck because the helper is
one-shot and holds no state. It is bounded at 256 KiB and is appropriate for a
low-rate local control plane. A future identity-only recheck mode would still
need held handles, reparse and DACL checks, protection fingerprints and the same
fixed-package binding; it is intentionally not part of this change.

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
`component-volume-mismatch`, `directory-*`, `parent-owner-untrusted`,
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
- **Sensitive failures.** All failures are stable codes. The helper does not
  write the path, SID, ACL, or exception to stdout/stderr.

## Known gaps and boundary

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
  drift plus a pending delete handle are covered. Ancestor owner/DACL is checked
  before the leaf read but is not re-read at the end; only the leaf and immediate
  directory are re-read.
- Case-sensitive NTFS directories are not probed. The helper instead requires
  exact canonical component spelling and rejects case-only mismatches, so it
  does not depend on case-sensitive siblings behaving like aliases.
- The emitted single-file artifact is self-contained, non-extracting and
  unsigned. Production signing, fixed-path installation, package trust binding,
  project-directory identity and effect-lifetime TOCTOU remain downstream. No
  signature is pretended here.
- If native extraction is reintroduced in a future publish, protected extraction
  and runtime-dependency bytes become a new mandatory launch boundary; artifact
  hash validation alone would not attest previously extracted components.
- The project is built for x64. ARM64 Windows is not exercised.
- The helper does not validate the policy JSON. The caller remains responsible
  for schema validation, project identity binding, and policy semantics.
