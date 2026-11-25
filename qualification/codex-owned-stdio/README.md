# Codex owned stdio transport helper (0010, inactive)

Source-bound, offline qualification of the inactive owner-backed stdio transport
helper added by `patches/happier/0010-codex-owned-stdio.patch`.

**Labels: offline, source-bound, not-integrated, not-physical, not-wired.**

- *Offline*: no prompt, model, provider, auth, database, relay, listener, installed
  app or live Happier process is started.
- *Source-bound*: the pinned Happier objects, the active five-patch candidate tree
  and the reviewed inactive 0009 patch are read directly. 0010 is applied only to a
  disposable extracted fragment.
- *Not integrated*: the maintained client, RPC policy and every selector are
  unchanged. No current caller, barrel export or activation path exists.
- *Not physical*: no real pipe, process, job, socket or device is exercised.
- *Not wired*: 0010 is unregistered and stacked after 0009; neither patch is listed
  in the active series.

## Binding

| Item | Value |
| --- | --- |
| Prepared on RAC base | `67fffdb08164a1f625b06693a7f935e27aac7387` / tree `8d117ab288f852cd2b65ed823e919a90b13ab65a` |
| Happier commit | `e992e049ffa7a98ab60740ac60f94918f022ff24` |
| Happier source tree | `911bdc3c673608490b932bd939166d88f198066a` |
| Five-patch candidate tree | `c62fcb80464a0b7161efb4c09bdcbd8d9506bea4` |
| Reviewed inactive 0009 | `patches/happier/0009-codex-restricted-jsonl.patch`, sha256 `173b465fc186fc0d1071c2357071253c9bad348cf28789a1226b7a10b2d29703` |
| 0009-applied reader blob | `26e11d56c3a65558a1b1c0b587bfbc49d7557999` |
| Helper-only 0010 patch | `patches/happier/0010-codex-owned-stdio.patch`, sha256 `bb8d74c0f8b7d2e7609ee54811f93efed3fe8fa55a4006e38903831dd7d72a61` |
| Maintained client blob (unchanged) | `e74b4e4920f0f8f16f5de98205dce57084ecd4dc` |
| New helper blob | `55e87573934851388750fa6b68fe4177f77dc507` |
| Node used | `v24.22.1` (`win32/x64`, enforced) |
| TypeScript compile | `tsc 5.9.3`, `@types/node 24.19.1`, helper+reader only |

0010 adds exactly one file:

`apps/cli/src/backends/codex/appServer/client/codexOwnedStdioTransport.ts`

It does not modify the maintained client, the reviewed 0009 reader, the series,
profiles, workflows, locks or production reachability. It requires 0009 for the
restricted byte reader. The maintained client blob is verified unchanged.

## What the helper does

### Owner contract

The owner supplies pre-admitted streams, never a command, path or argument vector:

```ts
type CodexOwnedStdioOwner = {
  stdin: { write(bytes: Uint8Array): Promise<void> };
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  onFailure(handler): () => void;      // invokes immediately if already failed
  dispose(): Promise<{
    rootEmpty: boolean | null;         // null = unknown
    jobEmpty: boolean | null;          // null = unknown/not owned
  }>;                                  // must be idempotent after failed handoff
};
```

`stdin` receives UTF-8 bytes including the caller's LF. `stdout` is framed only by
the reviewed 0009 byte reader (LF/CRLF, strict UTF-8, bounded frame cap). `stderr`
is drained, counted to a fixed cap, and discarded: never retained, parsed, logged or
appended to diagnostics.

Owner callbacks, stdin writes and stdout/stderr iterator acquisition/next/return
must not synchronously block the JS event loop; they are async owner
responsibilities. An invoked next/iterator return remains owner responsibility even
after closure is observed. `onLine` and `onTerminal` must return promptly and
synchronously; the helper does not await a returned promise. It does not claim
synchronous OS cancellation.

### Bounds and classification

Provisional defaults for this inactive helper (a reviewed binding must re-derive
them): 16 MiB frame cap, 64 queued writes, 1 MiB queued bytes, a **10 s write
deadline from enqueue to settlement**, 5 s disposal deadline and an 8000-byte
stderr count cap. Optional limits are snapshotted/frozen at helper construction;
later caller mutation does not change policy. Both deadline limits are validated
against the JS timer maximum (2^31-1 ms) at construction, so an effective optional
value can never silently overflow `setTimeout`.

- Outbound payload length, UTF-8 byte count and item/byte queue overflow latch the
  fixed `capacity` state before encoding or touching the stream.
- A non-LF/non-string payload is an independent `write` contract fault.
- A stream write rejection is `write`; a write/deadline expiry is `timeout`.
- Invalid/oversized inbound frames are `frame`; truncation/clean EOF is `eof`;
  owner failure is `owner`; a callback throw is the fixed sanitized `callback`
  state; closed admission is `closed`.

`CodexOwnedStdioError` is the single fixed fail-closed state. Its message contains
only the reason and never a payload, sample or stderr. A synchronous throw from an
early terminal observer is contained and cannot reopen closure.

### Start / handoff / settlement

- A compliant `onFailure` may register, immediately replay an already-failed owner,
  then return its unsubscribe. If terminal/closure occurs during that synchronous
  registration, the just-returned subscription is detached exactly once, terminal
  handlers are removed, stdout/stderr are never acquired, and owner disposal remains
  single.
- Normal start opens stdout and stderr once and subscribes normally.
- The bounded settlement promise is published before any synchronous owner
  unsubscribe, so a reentrant dispose from that unsubscribe shares one owner
  disposal.
- Iterator acquisition is explicit and separately gated. If terminal/closure is
  replayed by `owner.stdout[Symbol.asyncIterator]()` or by
  `owner.stderr[Symbol.asyncIterator]()`, no `next()` (including the first) is
  submitted. At most one `next()` is in flight; after closure is observed, none is
  resubmitted. A terminal reported synchronously while acquiring stdout or calling
  its first `next()` prevents starting stderr. When a frame callback reports
  terminal later, stderr may already have an admitted read; neither loop submits
  another `next()` after observing closure. A best-effort, non-blocking iterator
  `return()` is attempted when a loop exits before natural completion.
- `closeAdmission()` is a full logical stop, not a write-only drain. It rejects
  sends and stops accepting read frames or new terminal notifications. It does not
  report partial frames as truncated and does not dispose the owner.
- `dispose()` stops admission, shares one settlement promise and bounds the owner
  disposal; it is also responsible for best-effort failure-subscription detachment
  after normal startup. `rootEmpty`/`jobEmpty` remain owner claims; `null` is unknown.
  A settlement never means a provider turn was cancelled or a request was not
  delivered.

## What was executed, and what was not

Executed (real execution, not stubs):

- the patched helper and reviewed 0009 reader imported with pinned Node 24.22.1
  type stripping (relative extensionless import resolved by a disposable harness
  resolver; patched source unchanged);
- **45 checks**, including:
  - split CRLF/multibyte frames, multi-frame flow, serialized UTF-8 LF writes;
  - callback/malformed/oversized-frame/truncated/early-EOF/invalid-chunk terminality
    and no delivery after terminal, including containment of a thrown transport
    error subtype as the fixed sanitized `callback` state;
  - broken stream write, non-LF contract fault, item/byte/payload `capacity`
    classification before stream touch, write deadline from enqueue to settlement,
    prompt blocked-send settlement on owner failure and close-admission rejection;
  - bounded discarded stderr with no sentinel leakage;
  - idempotent one-shot settlement, unknown settlement on throw/timeout, invalid
    settlement normalization, invalid limits/owner contract rejection, and rejection
    of deadline limits above the JS timer maximum;
  - optional-limit snapshotting;
  - replayed-failure handoff detach with zero stdout/stderr opens, normal start,
    reentrant-unsubscribe single disposal, early terminal observer throw containment,
    synchronous stdout-terminal suppression of stderr, no further stdout `next`
    after closure, and zero-next regressions when failure is replayed during stdout
    iterator acquisition or during stderr iterator acquisition;
- source binding: pinned commit/tree/candidate tree, adjacent receipt, active series
  count, reviewed 0009 digest/reader blob, helper-only 0010 digest, single touched
  path, patch application, helper blob, unchanged maintained client blob;
- no current selector: clean `git grep` status 1 for the helper/owner seam in the
  candidate tree, and the series still lists only the active five patches;
- focused helper+reader compile with `tsc 5.9.3` and `@types/node 24.19.1` under the
  pinned strict flags.

Not run / not claimed:

- any maintained client wiring, RPC request timeout/pending/envelope/callback-budget
  policy, extracted client harness, or client compiler claim;
- any real pipe, owner process, job object, Windows anonymous-pipe adapter, socket,
  device, credential, model turn or Codex app-server;
- Happier install/build/full typecheck/vitest or production launch;
- real OS-call cancellation or interruption; non-Windows platforms.

## Running

```powershell
node qualification/codex-owned-stdio/owned-stdio.test.mjs `
  --happier-git-dir D:\path\to\Happier\.git `
  --happier-patch-objects D:\evidence\patch-index-verification\objects `
  --git "C:\Program Files\Git\cmd\git.exe" `
  --tsc "<repo>\node_modules\typescript\lib\tsc.js" `
  --type-roots "<repo>\apps\host\node_modules\@types" `
  --temp-root C:\Windows\Temp\opencode
```

Prerequisites: pinned Node 24.22.1; absolute Git and optional tsc/type-roots paths;
adjacent patch-index `receipt.json`; enforced 0009/0010 digests; disposable
workspace removed unless `--keep-temp`; no evidence file is written. `--tsc` is
optional; without it the helper compile prints `NOT_RUN` and is not claimed.

## Result (2026-11-24, pinned Node 24.22.1)

`PASS` - 45 checks passed, 0 failed (45 listed), including helper execution and the
focused helper+reader compile. Exit code `0`.

`RESULT PASS 45/45 executed checks (node v24.22.1, win32/x64)`.

Without `--tsc`: 44 executed checks passed, 1 not run (`compile.helper-reader`),
with no compiler claim.

## Maintenance rationale and remaining gaps

This is a deliberately inactive transport-only slice. Do not treat it as activation
readiness or a maintained-client integration.

A future maintained binding must separately:

- honor/configure the provider's intentional request-lifetime policy (including
  `{ timeoutMs: null }` for side-effecting admission methods) rather than imposing a
  transport-wide request budget;
- preserve explicit `AbortError` caller compatibility without falsely reporting
  cancellation;
- keep ambiguous delivery quarantined with no automatic redispatch;
- configure protocol framing, read/write/queue policy and request/notification
  limits explicitly;
- validate the frame cap against the 0009 reader's 64 MiB ceiling **before** setup;
  `start()` can currently throw above that ceiling after subscribing but before
  opening reads;
- define one lifecycle owner that successfully starts the read pumps before sending,
  arranges disposal after terminal or failed setup, and prevents start-after-close.
  The helper permits pre-start sends, and start after a normal close returns without
  notifying the terminal callback;
- pass full Happier workspace typecheck/build and verify the Windows bridge/real
  process custody before any activation.

Remaining gaps here: the maintained client is untouched and unwired; no RPC,
request, envelope, pending or callback-budget policy is implemented; already-running
owner callbacks/iterators are not revoked; in-flight writes are not interruptible;
settlement is not surfaced to a client; no real OS pipe/job/process, full workspace
or Windows bridge verification was performed.

## Files

- `owned-stdio.test.mjs` - binding, helper-only patch application, synthetic helper
  execution and focused helper+reader compile.
- `README.md` - this document.
- Owned patch: `patches/happier/0010-codex-owned-stdio.patch`.
