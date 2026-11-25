# Codex adapter offline qualification (C07)

Source-bound, offline qualification of the selected Happier Codex app-server
adapter surface against the pinned native Codex stable schema.

**Labels: offline, source-bound, not-integrated, not-physical.**

- *Offline*: no prompt, model, provider, auth, database, listener or live Happier
  process is started.
- *Source-bound*: the pinned Happier Git objects and the already-applied candidate
  tree are read directly; no checkout or source mutation is performed.
- *Not integrated*: no RAC host, relay, phone or profile is enabled.
- *Not physical*: no device or network journey is exercised.

## Binding

| Item | Value |
| --- | --- |
| Happier commit | `e992e049ffa7a98ab60740ac60f94918f022ff24` |
| Happier source tree | `911bdc3c673608490b932bd939166d88f198066a` |
| Applied candidate tree | `c62fcb80464a0b7161efb4c09bdcbd8d9506bea4` |
| Patch | `patches/happier/0007-codex-stable-profile.patch` |
| Patch SHA-256 | `6872c372244380919374037a9453fb3bcdd05e4ffd80f7dca121aa055dab3065` |
| Patched manifest blob | `b2fe7f6dfa405b111c051c428ed906203d0ee566` |
| Native binary | `sha256 cefea4ffee1fff04983a99c0dda99944d8b380e891e740a28b32f4b815a6e0b7` |
| Native receipt | `native-only-independent-20261124.json`, content `sha256 f5f784c2a033c4b562cb4c7786f88410dad9779b840dab4007806fd95025a926` (explicit owner-supplied binding) |
| Stable schema | 331 files, manifest `29c34971dff6d5ee23b784d413fb53103bbf06c735d8ec50ddacdbb05d73bbe9` |

The patch is **not** listed in `patches/happier/series.json`; this track does not
change the series. It applies cleanly to the candidate tree and touches only
`packages/agents/src/manifest.ts`.

## What the evidence shows

### `thread/rollback` is unsupported in one native shape

The pinned stable `ClientRequest` has **no** `thread/rollback` method. Happier
nevertheless advertises `sessionRollback.conversation` as `supported` for the
Codex `appServer` runtime and, for a latest-turn target, sends exactly:

```
thread/rollback { threadId, numTurns }
```

(`apps/cli/src/backends/codex/appServer/runtime.ts:5610`, `:5616`)

The stable schema does contain `thread/revert { threadId, beforeTurnId }` and
Happier uses it for history rollback (`runtime.ts:5604`), but history rollback is
**not qualified** in this first lane. No arbitrary fallback is exercised.

The maintained patch adds an `appServer` capability override:

```ts
sessionCapabilities: {
    sessionRollback: { conversation: 'unsupported' },
}
```

Executed against the actual selected capability module, the unpatched source
returns `supported` for appServer rollback and the patched source returns
`unsupported`; ACP and MCP results and every other capability are unchanged.

### `turn/interrupted` is optional compatibility, not a cancellation verdict

The stable schema has `turn/completed` requiring `threadId` and a typed `turn`
(`turn.id`, `turn.status` with `completed | interrupted | failed | inProgress`).
`turn/interrupted` is absent from the stable notification list. Happier treats it as
an optional compatibility notification: when present it is accepted as a terminal
`interrupted` outcome, while the stable path is `turn/completed` whose
`turn.status` decides `completed`, `interrupted` or `failed`. Neither path settles
the turn on the interrupt request: settlement is gated on the tracked turn
identity and `cancel()` awaits the terminal turn.

Executed production logic confirms:

- `turn/completed` + `status: completed` -> `completed`
- `turn/completed` + `status: interrupted` -> `interrupted`
- `turn/completed` + `status: failed` -> `failed`
- optional `turn/interrupted` -> `interrupted`
- the interrupt helper sends exactly `turn/interrupt { threadId, turnId }`,
  waits once for a provider terminal on the startup-gap error, and propagates
  unrelated failures.

Cancellation is therefore **shape-verified only**: this lane does not claim it is
broken (raw grep absence is not evidence) and does not qualify live cancellation.

## What runs, and what cannot

Executed in this lane:

- the actual selected capability module, unpatched and patched, with the pinned
  Node type stripper and only the pinned `zod`/`@happier-dev/protocol` copies from
  the reference CLI archive;
- extracted production functions from `runtime.ts` (terminal classifier,
  interrupt helper, rollback unsupported classifier);
- native schema binding and shape classification;
- pinned source-fact assertions with exact line numbers;
- patch application to the applied candidate tree and blob verification.

Not run, explicitly:

- Happier workspace dependency install/build/tests (the yarn lane is not
  available offline; no install was attempted);
- end-to-end Happier daemon/session runtime with Codex app-server (would start a
  live service);
- live cancellation (requires a prompt/model turn);
- history rollback via `thread/revert` (outside the first qualification).

The static source-fact checks read pinned text; they are not an execution of the
full `runtime.ts` module. The capability and extracted-function checks are real
execution of selected production logic.

## Tool boundary

`--git` and `--tar` are required **owner-supplied absolute executables**, not PATH
lookups. The runner records their SHA-256 at start and rechecks both before
emitting the receipt; a replaced tool fails the run. Git runs with an isolated
empty global config (`GIT_CONFIG_NOSYSTEM=1`, empty `GIT_CONFIG_GLOBAL`), an
isolated `HOME`/`XDG_CONFIG_HOME`, no inherited `GIT_*` variables and no
dependency installation. The owner trusts these exact tools; the harness binds
their identity but does not sandbox them.

The runner fails before extracting or executing selected production code if the
pinned commit does not resolve to the expected source tree or any pinned source
blob differs. It fails before importing patched modules if the patched manifest
blob differs from the expected result.

## Running

```sh
RAC_HAPPIER_GIT_DIR=/path/to/Happier/.git
RAC_HAPPIER_PATCH_OBJECTS=/path/to/patch-index/objects
RAC_NATIVE_SCHEMA_DIR=/path/to/codex-native-v0.171.0
RAC_NATIVE_RECEIPT=/path/to/native-only-independent-20261124.json
RAC_NATIVE_RECEIPT_SHA256=f5f784c2a033c4b562cb4c7786f88410dad9779b840dab4007806fd95025a926
RAC_REFERENCE_ARCHIVE=/path/to/happier-v0.2.21-windows-x64.tar.gz
RAC_GIT=/absolute/path/to/git
RAC_TAR=/absolute/path/to/tar
RAC_EVIDENCE_OUT=/path/to/new-receipt.json

node qualification/codex-adapter/run-codex-adapter-qualification.mjs \
  --happier-git-dir "$RAC_HAPPIER_GIT_DIR" \
  --happier-patch-objects "$RAC_HAPPIER_PATCH_OBJECTS" \
  --native-schema-dir "$RAC_NATIVE_SCHEMA_DIR" \
  --native-receipt "$RAC_NATIVE_RECEIPT" \
  --native-receipt-sha256 "$RAC_NATIVE_RECEIPT_SHA256" \
  --reference-archive "$RAC_REFERENCE_ARCHIVE" \
  --git "$RAC_GIT" \
  --tar "$RAC_TAR" \
  --evidence "$RAC_EVIDENCE_OUT"
```

Exit code is `0` only for `PASS`. An existing `--evidence` file is refused; write
each run to a new path. The receipt hash is either pinned in `expectations.json`
or supplied explicitly; an unbound receipt is never accepted.

## Result (2026-11-24, pinned Node 24.22.1)

`PASS` — 30 checks passed, 0 failed, 0 blocked, 5 explicit limitations (35 checks total).

Receipt: `rac-happier-20261124/codex-adapter-20261124/run-20261124-v7.json`,
content `sha256 481f0b9ba2688b3280eee0d0efa87d4a29b4b3053878ddcfacfd653f9183e43d`.

Patch justification is recorded as `true`: the selected source advertises the
capability, the native stable schema lacks the method, and only the appServer
rollback capability changes when the patch is applied.

## Patch scope and limitations

The override is static for the Codex `appServer` runtime. It intentionally hides
rollback for every installed Codex version until a version-aware capability is
available; this is conservative for the pinned composition and avoids advertising
an unqualified action. `thread/revert` remains stable but unqualified, so history
rollback is also withheld. Promoted profiles and runtime enablement are unchanged
and remain disabled.

## Files

- `run-codex-adapter-qualification.mjs` - orchestrator, checks and receipt.
- `expectations.json` - pinned commits, blobs, schema, capability and patch values.
- `lib/git.mjs` - read-only object access, scratch repository, archive extraction.
- `lib/ts-modules.mjs` - Node type-strip resolver for the selected source.
- `lib/extract-functions.mjs` - extracted production-function execution.
- `lib/native-schema.mjs` - native receipt/schema binding and classification.
- `lib/source-facts.mjs` - pinned source assertions.
- `lib/redact.mjs` - path redaction for receipts.
