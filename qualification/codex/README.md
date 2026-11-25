# Codex native/offline conformance (ROG-14)

Repeatable, fail-closed qualification of the **installed Windows Codex app-server**
against the stable protocol surface the maintained controller intends to consume.

**Labels: native, offline. Not integrated. Not physical.**

- *Native*: runs against the vendored native `codex.exe` that the npm launcher
  resolves to, not a mock, a schema file or a reimplementation.
- *Offline*: empty owned `CODEX_HOME`, no credentials, no turn, no model or
  provider contact, no listener, no daemon, no shared app-server.
- *Not integrated*: no RAC host, Happier relay, phone or ACP bridge.
- *Not physical*: no Android-over-cellular, Tailscale or real-device journey.
- *Not production enable*: nothing here enables a profile or ships a package.

## Trust scope

The binary check assumes an **owner-trusted fixed install location**: an absolute
PATH entry resolving to the npm global shim and its vendored platform package.
The resolved file is hashed and compared to the pinned digest **before any
launch**. This is not a general trust boundary and not a configurable seam: a
different path containing the same bytes is accepted; different bytes are
rejected. Installing, relocating or replacing the CLI stays an owner action.
`--expected-sha256` exists only to bind a platform target that has no pinned
digest (non-x64-win targets are `BLOCKED` without it).

## Fail-closed order

Each stage must pass before the next is allowed to start. A failed stage stops
the run; the receipt records `stoppedAt` and the gate that stopped it.

| Stage | Stop condition | Launch? |
| --- | --- | --- |
| `composition-lock` | `distribution/composition-lock.json` missing or unreadable -> structured `BLOCKED` receipt | **no** |
| `binary-identity` | launcher unresolved, relative launcher or PATH entry, escaping metadata entrypoint, reparse point, malformed or mismatched SHA-256, unrecognised native magic | **no** |
| `version-identity` | `--version` fails, times out or is not the exact expected label | first launch only |
| `schema-identity` | generation fails, baseline missing or drifted, captured bundle differs | second launch |
| `schema-contract` | any required method/message/identifier/approval/question/cancel contract is absent | no further launch |
| `stdio.initialize` | error response, `codexHome` outside the isolated home, platform or client/user-agent peer mismatch | app-server opened, **no thread call** |
| `stdio.thread.switch` | `thread/start` ids/cwd/version/ephemeral/idle shape wrong, returned sandbox not read-only with network disabled, approval policy not the requested one | **no further thread operation** |

`fileMagic` reads at most 16 bytes, never the whole 407 MB binary.

## What the harness proves

| Check | Evidence |
| --- | --- |
| `identity.containment` / `identity.digest` | shim -> `@openai/codex` package -> vendored target; entrypoint stays inside `vendor/<target>`; metadata and entrypoint are regular files, not reparse points; SHA-256 equals the pinned or owner-supplied digest before launch |
| `version.identity` | `codex --version` equals `codex-cli 0.171.0` |
| `schema.generate` / `schema.baseline-identity` | `generate-json-schema` **without** `--experimental`; all 331 files match the tracked baseline manifest |
| `schema.captured-bytes` | optional byte identity with a captured stable bundle |
| `contract.*` | `initialize`/`initialized`; `thread/start`, `thread/inject_items`, `thread/list`, `thread/read`, `thread/resume`, `thread/delete`; `turn/start`, `turn/interrupt`; thread/turn/item identifier fields; command and file-change approval decisions; user-input question schema; turn cancel params |
| `stdio.initialize` | real stdio handshake; isolated `codexHome`; windows platform; our client name and version token in the peer user agent |
| `stdio.thread.start` | real disposable thread with `cliVersion 0.171.0`, idle, non-ephemeral, inside the disposable project |
| `stdio.thread.sandbox` / `stdio.thread.approval-policy` | returned sandbox is `readOnly` with `networkAccess: false`; returned approval policy is `never` |
| `stdio.thread.synthetic-item` | `thread/inject_items` appends one synthetic item and persists a rollout **without a turn**; this is why the method is part of the required contract |
| `stdio.thread.read` / `resume` / `delete` | read, cross-process resume, delete of the disposable thread |
| `stdio.method-contract` | every method actually sent belongs to the required contract (currently 8: `initialize`, `initialized`, `thread/start`, `thread/inject_items`, `thread/read`, `thread/list`, `thread/resume`, `thread/delete`) |
| `stdio.no-turn` | zero turn/item notifications and no `turn/start` sent |
| `stdio.close-*` | `confirmedExit` on stdin close; `forcedKill` is reported separately and never implies a confirmed exit |
| `isolation.*` | no `auth.json`, no `config.toml`, no plugin-marketplace clone, isolated env directories |
| `happier.method-literals` | only when `--happier-source` is supplied; see "Adapter comparison scope" |

`stdio.thread.list` is **NOT_QUALIFIED**: the 0.171.0 Windows build answers
`thread/list` with zero threads in an unauthenticated isolated home even though
`thread/read` and `thread/resume` address the same thread. It is neither a pass
nor a harness failure. No claim is made about remote-control state, because the
transport does not retain notification parameters.

## Running

```sh
# native-only slice (scoped PASS; adapter comparison NOT_RUN)
node qualification/codex/run-codex-conformance.mjs

# pinned Node 24.22.1 + captured bundle + new receipt
node qualification/codex/run-codex-conformance.mjs \
  --schema-snapshot D:/AgentData/evidence/rac-happier-20261124/codex-native-v0.171.0 \
  --evidence D:/AgentData/evidence/rac-happier-20261124/codex-conformance-20261124/native-only.json

# optional adapter comparison (fails while the gaps below exist)
node qualification/codex/run-codex-conformance.mjs \
  --happier-source D:/AgentData/clones/Happier-rac-v0.2.21-20261124

# pure trust/negative-control assertions; no Codex launch
node qualification/codex/run-codex-conformance.mjs --self-test
```

Exit code is `0` only for `PASS`. `BLOCKED` means the environment or a requested
comparison was unavailable; `FAIL` means a gate assertion was violated.

Statuses: `pass`, `fail`, `blocked`, `skip`, `not-qualified`. The receipt carries a
scoped `qualification` block: `native` (pass/fail/blocked), `adapterComparison`
(`PASS`/`FAIL`/`BLOCKED`/`NOT_RUN`) and `threadList` (always `NOT_QUALIFIED` until
an authenticated profile is qualified).

### Snapshot updates are reviewable

`--write-schema-snapshot` writes a **new** candidate manifest (default
`schema-snapshot.<UTC>.sha256.json`, or `--snapshot-out <file>`). It never
overwrites `schema-snapshot.sha256.json`, refuses a path equal to the baseline,
refuses an existing candidate, and the run still compares against the baseline.
Promoting a candidate is a separate reviewable change.

`--evidence <file>` refuses an existing receipt; there is no overwrite flag.
Write each run to a new path.

## Environment and containment

The child receives a fixed allowlist, not the ambient environment:

`PATH`, `PATHEXT`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `OS`,
`PROCESSOR_ARCHITECTURE`, `NUMBER_OF_PROCESSORS`
plus isolated `CODEX_HOME`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`,
`TEMP`, `TMP` and explicit `RUST_LOG`/`NO_COLOR`.

Relative PATH entries are rejected, and the process PATH is rebuilt with the
Windows system directories first. The receipt records the excluded ambient count,
never the values.

Containment details:

- `HTTP(S)_PROXY`/`ALL_PROXY` point at a closed loopback port.
- `--disable plugins --disable apps --disable remote_plugin` keeps startup local.
- **This is containment, not OS-enforced network isolation.** No observed
  connection attempt plus a closed-port proxy does not prove a firewall or
  sandbox. The receipt states this explicitly.
- With default features this binary syncs a plugin marketplace into `CODEX_HOME`
  and can attempt a Responses WebSocket even without a turn (observed while
  building this harness). The flags and assertions exist because of that.

Bounds: 1 MiB per frame (enforced even when the newline already arrived), 2000
frames, 500 notifications, 8 pending requests, 64 KiB stderr, 60 s per request,
300 s per process, 10 s graceful exit then a kill of only this harness's child.
Version/schema/grep stdout and stderr are byte-capped and recorded as
`{bytes, truncated, sha256}`.

Receipts retain structured scalars only: error codes with hashed messages,
hashed stderr with category counts, masked/sha256 thread ids, protocol method
names and counts. No raw response payloads, raw error text, stderr lines, PIDs or
host/user names are retained.

## Adapter comparison scope (when requested)

The Happier comparison is a **literal method-name scan of Git HEAD objects**, not
a clean checkout and not a runtime test:

- both double-quoted and single-quoted literals are scanned in `git grep` at
  `HEAD`; indirect or computed method names are not counted;
- the worktree is not evaluated, and no Happier process is started;
- completeness of usage is not claimed; counts describe literal occurrences only;
- the pinned commit and tree are verified from the lock before the scan;
- unreadable/empty scan -> `BLOCKED`; commit/tree mismatch or a production literal
  absent from the stable schema -> `FAIL`.

Result on the pinned commit (`e992e049ffa7a98ab60740ac60f94918f022ff24`, tree
`911bdc3c673608490b932bd939166d88f198066a`): **FAIL**, with production gaps:

| Method | Occurrences | Production locations |
| --- | --- | --- |
| `thread/rollback` | 15 (13 test) | `apps/cli/src/backends/codex/appServer/runtime.ts:5610`, `:5616` |
| `turn/interrupted` | 7 (4 test) | `apps/cli/src/backends/codex/appServer/codexAppServerHistoryBoundary.ts:165`, `:180`; `apps/cli/src/backends/codex/appServer/runtime.ts:4116` |

Neither name exists in the 0.171.0 stable schema. A controller or adapter that
depends on them would have no live source. This is recorded as an adapter finding,
not a native failure.

## Current result (2026-11-24, ROG-14, pinned Node 24.22.1)

### Native-only slice: PASS

34 checks: 32 passed, 1 noted (adapter NOT_RUN), 0 failed, 0 blocked,
1 not-qualified.

- Native binary: vendored `codex.exe`, 407,421,232 bytes,
  `sha256 cefea4ffee1fff04983a99c0dda99944d8b380e891e740a28b32f4b815a6e0b7`,
  matched the platform-pinned digest before launch.
- Stable schema: 331 files, manifest
  `29c34971dff6d5ee23b784d413fb53103bbf06c735d8ec50ddacdbb05d73bbe9`,
  identical to the tracked baseline and byte-identical to the captured bundle.
- `thread/start` -> `thread/inject_items` -> `thread/read` -> clean exit 0 ->
  second-process `thread/resume` -> `thread/read` -> `thread/delete` -> clean
  exit 0. One rollout file existed before delete; none remained afterwards.
  Both closes were `confirmedExit` with `forcedKill: false`. No turn, item or
  model activity.
- Returned policy: `sandbox {type: readOnly, networkAccess: false}` and
  `approvalPolicy: never`.
- No credentials, no marketplace clone, no offline-concern stderr; isolated
  `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/`TEMP` with `CODEX_HOME`.
- Receipt: `rac-happier-20261124/codex-conformance-20261124/native-only-20261124.json`
  under the AgentData evidence root, content
  `sha256 6fcbc4099dcd626727e3f09704aa774f6ab9df0307f3c65d378e2ae43c8ee724`.

### Adapter comparison: FAIL (supplementary)

Receipt `rac-happier-20261124/codex-conformance-20261124/adapter-comparison-20261124.json`,
content `sha256 88d8832f84f61b8d2d49d468d09e3405c69b0da3d6b422320e02825116c803f2`.
The native qualification in that receipt is still `PASS`; the adapter comparison is
`FAIL` for the two production gaps above.

### Negative controls exercised (no Codex launch unless stated)

- wrong `--expected-sha256` -> `FAIL` at `binary-identity`; version, schema and
  stdio stages never ran;
- relative `--codex .\codex.cmd` -> `BLOCKED` before resolution completes;
- existing `--evidence` -> refused before hashing (no overwrite flag exists);
- missing composition lock -> structured `BLOCKED` receipt at `composition-lock`;
- unreadable `--happier-source` -> `BLOCKED`, not skipped;
- `--snapshot-out` equal to the tracked baseline, a pre-existing candidate, or
  used without `--write-schema-snapshot` -> refused.

### Additional gaps

- **Stability labelling**: `ToolRequestUserInputResponse` is in the stable bundle
  but its description still says `EXPERIMENTAL`.
- **Thread list**: not qualified until an owner-approved authenticated profile is
  exercised.
- The initialize and thread-policy gates are fail-closed in code, but no hostile
  peer was run (no fixture may impersonate the app-server). `--self-test`
  (24 assertions) covers digest mismatch, containment helpers, env allowlisting,
  bounded classification, both quote forms, redaction, exit-state logic and
  evidence protection.
- Repo-wide `pnpm verify` was not run: workspace dependencies are not installed
  and offline installation is blocked by pnpm's toolchain self-fetch. The pinned
  `@biomejs/biome@2.5.15` was run on `qualification/codex` with format/lint clean.

## Files

- `run-codex-conformance.mjs` - orchestrator, gates, receipts, self-test.
- `expectations.json` - pinned version, digest, required contract, policy,
  isolation, limits and trust-scope statement.
- `schema-snapshot.sha256.json` - pinned hashes for all 331 stable schema files.
- `lib/native-identity.mjs` - metadata-only resolution, containment/reparse
  checks, bounded magic read, bounded digest verification.
- `lib/schema-check.mjs` - stable generation, manifest comparison, contract
  assertions.
- `lib/app-server-client.mjs` - bounded JSON-RPC stdio client and close state.
- `lib/harness-policy.mjs` - child-environment allowlist, exit description,
  all-occurrence classification with both quote forms.
- `lib/bounds.mjs` - byte-bounded capture, hashed scalar errors, version label.
- `lib/paths.mjs` - absolute/containment, owned-temp and evidence guards.
- `lib/redact.mjs` - path/identifier redaction.
