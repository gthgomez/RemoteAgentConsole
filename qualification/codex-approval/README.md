# Codex restricted approval occurrences (C07 continuation)

Source-bound, offline qualification of the additive restricted-profile approval
hardening for the pinned Happier Codex app-server route.

**Labels: offline, source-bound, not-integrated, not-physical.**

- *Offline*: no prompt, model, provider, auth, database, relay, listener, installed
  app or live Happier process is started.
- *Source-bound*: the pinned Happier Git objects and the existing five-patch
  candidate tree are read directly; the patch is applied only to a disposable
  extracted fragment.
- *Not integrated*: no RAC host, relay, phone or profile is enabled.
- *Not physical*: no device or network journey is exercised.

## Binding

| Item | Value |
| --- | --- |
| Happier commit | `e992e049ffa7a98ab60740ac60f94918f022ff24` |
| Happier source tree | `911bdc3c673608490b932bd939166d88f198066a` |
| Five-patch candidate tree | `c62fcb80464a0b7161efb4c09bdcbd8d9506bea4` |
| Patch | `patches/happier/0008-restrict-codex-approval-occurrences.patch` |
| Patch SHA-256 | `1280202ed65c8451d6cd0d4c268b3fc03ab85ffa47011fbc7a5dfa230de19e7a` |

The patch is **not** listed in `patches/happier/series.json`; this track does not
change the series, profiles or controller count. It applies cleanly to the
five-patch candidate tree and is independent of `0007`, which touches only
`packages/agents/src/manifest.ts`.

## The actual native approval route

The pinned native app-server route does **not** use `0001`'s
`ProviderEnforcedPermissionHandler` guard. It is:

```
runCodex.ts:1810   permissionHandler = createCodexPermissionHandler({ ... })
runCodex.ts:1963   codexAppServerRuntime = createCodexAppServerRuntime({ ... permissionHandler ... })
runtime.ts:2941    params.permissionHandler.handleToolCall(update.callId, update.toolName, update.input)
runtime.ts:2943    mapApprovalDecision(update.requestKind, result)
```

`createCodexPermissionHandler` constructs `CodexPermissionHandler`, which extends
`CodexLikePermissionHandler` and is what the app-server route receives.

### Pre-patch behaviour on that route

- `CodexLikePermissionHandler.shouldAutoApprove` returns true for `yolo` /
  `bypassPermissions` and for always-auto-approve tools (`:200`, `:205`).
- `isAllowedForSession` auto-approves a tool/input pair already allowed for the
  session (`:143`, `:277`), including state seeded from `completedRequests`.
- `PermissionRequestCoordinator` caches a completed decision by `requestId` and
  replays it for identical tool/input (`permissionRequestCoordinator.ts:151`).
- `mapApprovalDecision` maps `approved_for_session` to `acceptForSession` and an
  execpolicy amendment to `acceptWithExecpolicyAmendment` (`runtime.ts:2670`),
  which broadens acceptance beyond the current occurrence.

That is sufficient to justify a defensive patch: the handler can auto-approve
without an owner decision, and a session/amendment result can persist broader
authority at the provider.

## What the patch adds

Additive only; every restricted branch is inert unless
`isRestrictedDeploymentConfigured()` is true, so unrestricted behaviour is
unchanged.

1. `CodexPermissionHandler` passes `requireExplicitOwnerDecision` to the shared
   handler, sourced from the existing `@/security/restrictedDeployment/policy`
   predicate used by `0001`.
2. `CodexLikePermissionHandler`, only when that flag is true:
   - returns `false` before every auto-approval branch;
   - overrides `isAllowedForSession` to never accept from the session allowlist;
   - disables the coordinator decision cache for that handler;
   - normalises `approved_for_session` / `approved_execpolicy_amendment`
     permission results to `denied`.
3. `BasePermissionHandler` and `PermissionRequestCoordinator` accept an
   `allowCachedDecisions` option, defaulting to the existing behaviour. When it
   is disabled:
   - a completed decision is neither read nor recorded;
   - a completed request is never replaced or deleted under the same provider
     id;
   - a bounded, non-evicting seen-occurrence claim (4096 ids) is recorded before
     the owner prompt. A duplicate while the same request is pending attaches to
     that pending request; a settled/reused id or a full claim is denied without
     publishing a new prompt.
   - `CodexLikePermissionHandler` denies a permission id already present in
     `completedRequests` without touching the completed record, and turns a
     seen-occurrence rejection into a typed `denied` result.
4. `appServer/runtime.ts` consults the same predicate in the native mappers:
   - approval: broader-than-once results map to `decline`, never to
     `acceptForSession` or an execpolicy amendment;
   - permissions: a native sandbox-permission escalation request is declined
     (`{ permissions: {}, scope: 'turn' }`);
   - MCP elicitation: broader-than-once results map to `decline`;
   - approval-shaped `requestUserInput`: rejected in `prepareServerRequest`
     **before asking the owner or building answers** with the fixed error
     `restricted_deployment_requires_typed_approval`. No provider label is
     inferred, no prebuilt answer is forwarded, and an empty answer map is not
     treated as a denial. The pinned app-server client converts the thrown error
     into a bounded JSON-RPC error response (`-32000`); the route does not catch
     it into a success. The provider may fail the turn; that behaviour is
     unqualified. For unrestricted inputs
     (`requireExplicitOwnerDecision === false`) the stock
     `resolveApprovalChoiceLabel` fallback remains reachable; the fixed error is
     gated to restricted approval-shaped calls only.

The policy lives in the new runtime-free
`apps/cli/src/agent/permissions/approvalDecisionPolicy.ts`, imported by both the
handler and the runtime, so the restricted decisions can be executed without the
Happier workspace.

Typed native once-only approvals (`accept` for an explicit once decision;
`decline` for everything broader) and ordinary non-approval user input/unrestricted
branches are unchanged. The foreground UI and relay are not modified.

## What was executed, and what was not

Executed (real execution, not static text):

- the patched production `approvalDecisionPolicy` module, imported with the
  pinned Node type stripper and called with 33 synthetic cases covering
  unrestricted stock fallthrough, restricted broader-decision denial, permissions
  denial, elicitation denial, handler normalisation, the fixed approval-shaped
  mapping/error identity, and the bounded seen-occurrence claim
  fresh/duplicate/full/no-eviction/invalid-capacity semantics.

Static/source (pinned text, not execution of `runtime.ts`):

- commit/tree/candidate-tree object bindings, patch digest, touched-path set,
  patch application and all resulting blob identities;
- the route wiring, guard ordering, fixed-error propagation through
  `prepareServerRequest` -> `runBridgeWork` -> `historyBoundary.onRequest` ->
  app-server client, seen-claim ordering before publication, and the pre-patch
  defect facts.

Not run, explicitly:

- full Happier workspace install/build or `runtime.ts` execution;
- a live Codex app-server, model turn, provider or auth;
- Happier vitest suites (offline install not attempted);
- any device/installed/physical journey.

## Retired v5 claims

`run-20261124-v5.json` is superseded. The following v5 claims are withdrawn and
must not be cited:

- `coordinator.reprompt` — replacing a completed request under the same provider
  id to publish a fresh prompt. The current contract denies a reused/settled id
  and leaves the completed record untouched.
- the label-inference `choice` cases — keyword/positional provider-option
  selection is removed; approval-shaped restricted requests now fail with a
  fixed unsupported error.
- “a re-delivery prompts again instead of replaying an acceptance” — the safe
  outcome is deny/unsupported for settled/reused ids; a duplicate while the same
  request is pending attaches to one pending decision.

## Confirmed provider fencing and separate gaps

Provider turn/request fencing is present in the pinned source and is recorded as
a static fact, not a live claim: `ensureActiveTurnForProviderRequest` rejects a
request whose turn already terminated or whose thread/turn does not match the
active turn, and `serverRequest/resolved` cancels a locally pending request when
another client resolves it.

Precise separate gaps, stated rather than claimed:

- **Relay grant revocation** across an interrupted or retried await is not
  proven. The patch fences decisions at the native app-server/handler boundary
  only.
- **Approval-shaped userInput error** may fail the provider turn. The client
  surfaces a bounded JSON-RPC error and does not catch it into a success, but the
  provider’s error handling is unqualified; this is not a denial.
- **Occurrence generation binding** is not proven. The pinned approval schemas
  expose no provider generation token; foreground RPC payloads
  (`sessionAllow`/`sessionDeny`/`sessionAllowWithAnswers`) omit `occurrenceId`,
  and the local `occurrenceId` is generated with `randomUUID()`. The seen claim is
  handler-lifetime and the completed-record check is agentState-bounded; a pruned
  completed record or a new handler can lose the memory. A duplicate while the
  same request is pending attaches to one pending decision; concurrent same-id
  transport is not qualified.
- **Seen-claim capacity** is 4096 ids. New permission ids are denied when full;
  there is no eviction that would permit reuse.
- **Restricted flag delivery**: the lane proves that the in-process
  `HAPPIER_RAC_RESTRICTED_DEPLOYMENT` predicate used by `0001` gates the patched
  code; it does not prove that every restricted profile exports that signal into
  the session process.
- **Execution-run approval path**: Codex execution-run backends accept a
  separately supplied permission handler; that path is not the foreground
  app-server route and is not qualified here.

## Running

```powershell
node qualification/codex-approval/run-codex-approval-qualification.mjs `
  --happier-git-dir D:\path\to\Happier\.git `
  --happier-patch-objects D:\evidence\patch-index-verification\objects `
  --git "C:\Program Files\Git\cmd\git.exe" `
  --tar "C:\Windows\system32\tar.exe" `
  --evidence D:\evidence\new-receipt.json
```

Prerequisites:

- `--git` and `--tar` must be **absolute Windows paths** (drive or UNC), not
  PATH lookups. They are owner-supplied, hashed at start and rechecked before the
  receipt.
- The patch-index object directory must have an adjacent `receipt.json`
  (`..\receipt.json`). A missing sidecar is classified **BLOCKED**; an invalid
  JSON or a sidecar whose source commit/tree/candidate tree do not match is a
  **failure**. Pinned commit/tree/candidate objects and every source blob hash
  are still checked before the sidecar verdict.
- `--patch` is accepted only when its bytes match the pinned 0008 digest. A
  non-maintained override is refused before application; the receipt binds the
  actual applied path and SHA-256 plus the maintained relative path.
- This lane was executed on Windows x64 with pinned Node 24.22.1. No Linux
  execution is claimed.

The runner runs tools with an isolated Git config pinned to
`core.autocrlf=input` (so `git archive` emits the pinned blob bytes on Windows),
no ambient `GIT_*` variables and no dependency installation. An existing
`--evidence` file is refused.

## Result (2026-11-24, pinned Node 24.22.1)

`PASS` — 47 passed, 0 failed, 0 blocked, 12 explicit limitations (59 checks total).

Receipt: `rac-happier-20261124/codex-approval-20261124/run-20261124-v7.json`,
file `sha256 fc256bdc4c3ed586049596aa509aa44f51d5b415462ed478bc23e80c0a852551`,
content `sha256 e7faabc63f929f0e8b7d1d4d318a0b3594f527a8f1bad234f2c26cacb453019e`.

Patch justification is recorded as `true`: the actual route uses the generic
Codex handler, the unpatched handler/runtime auto-approve and broaden, and the
restricted branches deny, reject fixed unsupported shapes, and bind permission
ids to a bounded non-evicting claim without changing the unrestricted branch.

This README/runner correction does not change patch bytes, the pinned blobs or
the v7 patch binding. The v7 receipt’s harness file hashes describe the
pre-correction runner/expectations; the patch and six source blobs above remain
the authoritative binding. The v7 `runtime.no-label-inference` check is
superseded by `runtime.restricted-approval-shaped-order`; use the corrected
runner's receipt for that claim. v5 is superseded directly by v7 for the patch
revision.

## Files

- `run-codex-approval-qualification.mjs` - binding, patch application, static
  facts, executed policy cases and receipt.
- `expectations.json` - pinned commits, trees, blobs, patch digest, route facts,
  decision cases and limits.
- Shared read-only helpers: `qualification/codex-adapter/lib/git.mjs` and
  `qualification/codex-adapter/lib/redact.mjs`.
