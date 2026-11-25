# Codex restricted JSONL byte reader (0009)

Source-bound, offline qualification of the additive restricted byte reader in
`patches/happier/0009-codex-restricted-jsonl.patch`.

**Labels: offline, source-bound, not-integrated, not-physical, not-wired.**

- *Offline*: no prompt, model, provider, auth, database, relay, listener, installed
  app, real Codex executable or network request is started.
- *Source-bound*: the pinned Happier Git objects and the already-applied five-patch
  candidate tree are read directly; the patch is applied only to a disposable
  extracted copy.
- *Not integrated*: no RAC host, relay, phone, profile, workflow or Windows launch
  path selects the new reader.
- *Not physical*: no device, pipe or process journey is exercised. All chunks are
  synthetic in-process `Uint8Array`/`Buffer` values.
- *Not wired*: this is an unregistered, additive API for future owned stdio work.

## Binding

| Item | Value |
| --- | --- |
| Prepared on RAC base | `c9151245933a1522d08bb3d8eeea65c23d595226` / tree `1e0f1331bc70496edbc66547076ac4cfda5f5d5d` |
| Happier commit | `e992e049ffa7a98ab60740ac60f94918f022ff24` |
| Happier source tree | `911bdc3c673608490b932bd939166d88f198066a` |
| Five-patch candidate tree | `c62fcb80464a0b7161efb4c09bdcbd8d9506bea4` |
| Patch | `patches/happier/0009-codex-restricted-jsonl.patch` |
| Patch SHA-256 | `173b465fc186fc0d1071c2357071253c9bad348cf28789a1226b7a10b2d29703` |
| Maintained source | `apps/cli/src/backends/codex/appServer/client/codexAppServerJsonLineReader.ts` |
| Source blob (pin and candidate) | `d29c56f888a11e1e7c131ee42ff3bbe27aaea7ec` (3011 bytes) |
| Patched blob | `26e11d56c3a65558a1b1c0b587bfbc49d7557999` (12271 bytes) |
| Patch bytes | 9943 |
| Node used | `v24.22.1` (`win32/x64`, enforced) |
| TypeScript compile | `tsc 5.9.3`, `@types/node 24.19.1`, exact one-file compile |

The patch is **not** listed in `patches/happier/series.json`. This track does not
change the active five-patch tree or order, the pin, profiles, workflows,
`0006`/`0007`/`0008`, or production reachability. It touches exactly one existing
file and only appends code after the maintained string reader.

### Repair note (TypeScript narrowing in `finish`)

The previous 0009 revision (`sha256 735a8594…`, patched blob `e07826c2…`) returned
`terminalStatus` after `if (terminalStatus !== null) return …` narrowed it to `null`.
TypeScript does not follow the assignment inside `fail('truncated_frame')`, so the
exact one-file compile failed:

```
error TS2322: Type '"clean" | null' is not assignable to type
'CodexAppServerRestrictedJsonLineFinishStatus'.
```

`finish()` now returns the literal `'truncated'` immediately after `fail()` and the
literal `'clean'` after the clean assignment. Idempotence and the existing test cases
are unchanged. The compile was reproduced failing on the previous module and passing
on the current module.

### Repair note (Buffer subview retention)

The first 0009 draft (`sha256 687bcb629145f9ebf1e037321dcf3836f1db21d1f44790fab82f4efe92b88758`,
patched blob `a9b9de07ba514cc7d93a25687a02bdc6f116a35c`) used `chunk.slice(start, end)`.
For a Node `Buffer` that returns a **view**, not a copy. Pushing a small Buffer
subview, mutating the larger allocation, then completing the frame delivered the
mutated bytes (`ZZZZZZZZ` instead of `abcdefgh`) and retained the caller's
allocation. The current patch replaces that with one reusable `Uint8Array` and a
real `set` copy from a short subarray view. The regression was executed during this
repair against both modules: the draft delivered `ZZZZZZZZ`, the qualified module
delivers `abcdefgh`. The delivered suite runs the qualified regression below.

## What 0009 adds

`createCodexAppServerRestrictedJsonLineReader(onLine, options)` in the same
maintained module, alongside the untouched string reader.

- **Raw bytes in.** `push` accepts `Uint8Array` chunks (`Buffer` is accepted as a
  `Uint8Array`); strings and arrays are rejected with `TypeError`.
- **Explicit finite cap with a defined ceiling.** `maxFrameBytes` is required, must
  be a positive safe integer, and must not exceed
  `codexAppServerRestrictedJsonLineMaxFrameBytes` (64 MiB), exported by the module.
  Anything else fails at construction with `RangeError`. The cap counts raw frame
  payload bytes, excluding the LF or CRLF terminator.
- **One reusable bounded buffer.** A frame is assembled in a single `Uint8Array` that
  starts at `min(maxFrameBytes + 1, 4 KiB)` and grows amortized only as needed, never
  beyond `maxFrameBytes + 1` (the extra byte can only be a CR awaiting its LF).
  Accepted bytes are copied with `set` from a short `subarray` view, so a caller's
  `Buffer` or `Uint8Array` allocation is not retained and later caller mutation
  cannot change a pending frame. The frame is decoded only after a complete
  terminator arrives. The buffer is reused, not wiped or zeroized; stale bytes may
  remain, and no peak-allocation or throughput bound is claimed.
- **Bounded pending scan.** The newline search stops at the remaining per-frame
  allowance, so an oversized adversarial chunk is rejected without scanning the rest
  of the allocation to its first newline.
- **Strict UTF-8.** `TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`
  rejects invalid, overlong, surrogate and truncated multibyte sequences.
  Multibyte sequences split across chunks are buffered and decode correctly. A BOM
  is retained as `U+FEFF` and left to the JSON layer.
- **LF / CRLF policy.** LF terminates a frame. Exactly one CR immediately before
  that LF is treated as part of the terminator and is not delivered. Any other CR
  is frame content. A CR alone at EOF is truncation, not a terminator. Empty frames
  (including a bare CRLF) are skipped; whitespace-only frames are delivered, because
  framing does not validate JSON.
- **Bounded first failure.** `onFailure` receives at most one
  `{ reason }` object with one of `frame_too_large`, `invalid_utf8` or
  `truncated_frame`. Diagnostics never include a payload, sample, captured stderr,
  or offset content. The reader is terminal after the first failure.
- **EOF classification.** `finish()` returns `clean`, `truncated` or `failed` and is
  idempotent. A non-empty partial frame at EOF is `truncated_frame`; a partial
  invalid sequence at EOF is classified as truncation before UTF-8 validation. The
  truncated/clean branches return literals so the narrowed state is type-sound under
  strict TypeScript.
- **No delivery after error/EOF.** After a failure or `finish()`, later
  `Uint8Array` pushes are ignored and no frame is delivered.
- **Owner contract (not enforced).** The reader is non-reentrant. The owner must
  serialize `push`/`finish` calls, must not call back into the reader from
  `onLine`/`onFailure`, and must treat a throw from `onLine` as terminal and stop
  using the reader before wiring. This contract is not enforced or part of the
  qualified framing proof.

The added block contains no `JSON.parse`, JSON-RPC method names, provider decision
logic, process/settlement handling, stderr capture, Node `Buffer` API dependency or
per-byte chunk accumulation.

## What was executed, and what was not

Executed (real execution, not stubs):

- the suite runs only on the pinned Node 24.22.1; any other Node is a hard blocker;
- the patched production module imported with the pinned Node 24.22.1 type stripper
  from the disposable patched copy;
- the **exact one-file TypeScript compile** of that patched module with `tsc 5.9.3`
  and installed `@types/node 24.19.1`, using the pinned flags:
  `--target ESNext --module ESNext --moduleResolution bundler --lib ES2020,ES2022
  --strict --noImplicitReturns --skipLibCheck --noEmit --types node`. The same
  compile fails on the previous module with `TS2322` at the `finish()` return and
  passes on the current module. This is not a full Happier program typecheck;
- **38 synthetic framing cases**: exact cap with LF and CRLF, cap + 1 and cap + 2,
  byte-vs-character accounting, 2-byte and 4-byte UTF-8, multibyte split across
  three chunks, split frames, multi-frame chunks, split CRLF, isolated and doubled
  CR, empty frames, mixed CRLF/LF, four invalid-UTF-8 shapes, no delivery after
  oversize/invalid/EOF, partial frames at EOF, BOM retention, whitespace delivery,
  one-byte chunks with buffer reuse, amortized growth to 5000 bytes, a 1 MiB
  no-newline adversarial chunk and diagnostics bounded to a fixed reason;
- the **Buffer subview regression**: a `Buffer.subarray` into a larger allocation,
  a partial push, mutation of the caller allocation, then completion; the original
  eight bytes are delivered. Against the superseded draft module the same case
  delivered the mutated `ZZZZZZZZ`; against the qualified module it delivers
  `abcdefgh`;
- the **bounded-scan regression**: a Proxy-instrumented 64 KiB `Uint8Array` with no
  newline and a cap of 8. The draft read every index (max 63 of 63 in a 64-byte
  probe); the qualified module reads up to index 8 (10 indexed reads) and fails with
  `frame_too_large`;
- the maintained string reader executed from both the unpatched and patched module
  over LF, CRLF, split-frame, char-cap/oversize and whitespace-skip cases; the
  delivered lines and oversize samples are identical, and the function source text
  is identical;
- source binding: commit/tree/candidate tree, adjacent patch-index receipt, source
  blob identity, byte size, patch digest, single touched path, patch application and
  the resulting patched blob by two independent hash computations;
- `git grep` binding: the restricted-factory search must be a clean no-match
  (`status === 1`, empty stderr and stdout), and the maintained reader must be
  actually imported and called by `createCodexAppServerClient.ts`, not merely
  declared in its own module;
- prefix preservation (the candidate source is an exact prefix of the patched
  source) and the absence of the restricted factory anywhere in the five-patch
  candidate tree;
- source-level separation checks against `JSON.parse`, stderr/sample capture, Node
  `Buffer.` APIs, `process.`, approval method names, `chunk.slice`, a chunk-list
  implementation and unbounded newline scanning in the added block.

Not run, explicitly:

- a full Happier workspace/program typecheck, install or build; only the exact
  patched single module is compiled;
- JSON-RPC validation, provider decisions, owned process settlement, pipe custody or
  any live Codex app-server;
- Happier vitest suites (no dependency install was attempted);
- heap/allocation profiling; cap and copy-before-retain are proven behaviorally and
  by pinned text, not by a profiler;
- any host, relay, profile, Windows launch, device or installed-product journey;
- non-Windows platforms.

The static checks read pinned text; they are not execution of the full Happier
runtime. Framing only is claimed.

## Running

```powershell
node qualification/codex-stdio/restricted-jsonl.test.mjs `
  --happier-git-dir D:\path\to\Happier\.git `
  --happier-patch-objects D:\evidence\patch-index-verification\objects `
  --git "C:\Program Files\Git\cmd\git.exe" `
  --tsc "C:\path\to\node_modules\typescript\lib\tsc.js" `
  --type-roots "C:\path\to\node_modules\@types" `
  --temp-root C:\Windows\Temp\opencode
```

Prerequisites:

- The suite requires **pinned Node 24.22.1** and blocks any other version. It never
  claims a version it did not run.
- `--git` must be an **absolute Windows path**, not a PATH lookup. Git runs with an
  isolated empty config pinned to `core.autocrlf=input`, no ambient `GIT_*`
  variables and no dependency installation, and is used read-only against the
  pinned object stores plus a disposable scratch repository for `git apply`.
- The patch-index object directory must have an adjacent `receipt.json` that binds
  the pinned commit/tree and the five-patch candidate tree. Missing or mismatched
  receipts fail the run before any module is imported.
- The patch is refused if its SHA-256 differs from the qualified digest, so a
  non-maintained override cannot be exercised under this label.
- `--tsc` and `--type-roots` are optional but are required to claim the compile.
  Supply an owner-trusted compiler installation and Node type declarations.
  The witness runs `tsc.js` with the same pinned Node and reports its version
  output, the Node types version, and a hash prefix of the compiler entrypoint.
  It compiles only the exact patched module with the pinned flags; it does not
  attest the compiler installation.
  When omitted, the compile check prints `NOT_RUN` and the receipt lists
  `typescript-single-module` as `NOT_RUN`; no compiler proof is then claimed.
- An existing `--temp-root` is used only as a parent; the suite creates an owned
  `rac-codex-stdio-*` workspace and removes it unless `--keep-temp` is passed.
- `--json` prints the structured summary (also on stdout; no evidence file is
  written). Exit code is `0` only when every executed check passes.

## Result (2026-11-24, pinned Node 24.22.1)

`PASS` — 27 checks passed, 0 failed (27 listed), including the exact one-file
TypeScript compile, 38 framing cases, the Buffer subview and bounded-scan
regressions, and 5 string-reader parity cases. Exit code `0`.

`RESULT PASS 27/27 executed checks (node v24.22.1, win32/x64)`.

The compile ran with `tsc 5.9.3` and installed `@types/node 24.19.1`; the previous
module failed with `TS2322` at the `finish()` return.

## Limitations

- The reader is framing only. A delivered frame may be empty-adjacent whitespace,
  non-JSON or invalid JSON-RPC; validation and method admission are explicitly out
  of scope.
- No consumer selects the restricted factory. It is an exported API in a maintained
  module, not a new controller, transport, launch path or profile.
- `0009` is unregistered and is not part of the active five-patch candidate tree;
  applying it to the candidate produces the reported patched blob but does not
  change any series, lock, pin or profile.
- All bytes are synthetic. The Buffer regression uses real in-process Node Buffers,
  but no real stdin/stdout pipe, process owner, stderr stream or Codex app-server is
  exercised, so pipe custody, backpressure, cancellation and settlement remain
  unqualified.
- The configured cap is limited to the defined 64 MiB ceiling. The reusable frame
  buffer stays allocated for the reader lifetime at up to `maxFrameBytes + 1` bytes.
  It is not wiped or zeroized, so stale bytes may remain. No peak-allocation,
  throughput or OOM-classification claim is made; only per-frame retained bytes are
  bounded. A memory-allocation failure while growing the buffer propagates as a
  thrown error and is not classified as a framing failure.
- The reader is non-reentrant. The owner must serialize `push`/`finish`, must not call
  back into the reader from callbacks, and must treat a callback throw as terminal
  before wiring. That contract is not enforced or qualified here.
- The TypeScript proof is an exact **single-module** compile, not a full Happier
  program/workspace typecheck, install or build.
- Windows and pinned Node 24.22.1 only. The suite depends on an owner-supplied Git
  executable; no other platform or toolchain is claimed.

## Files

- `restricted-jsonl.test.mjs` — binding, patch application, module import, framing
  and string-reader parity checks, structured stdout summary.
- `README.md` — this document.
- Owned patch: `patches/happier/0009-codex-restricted-jsonl.patch`.
