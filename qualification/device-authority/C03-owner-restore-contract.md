# C03 owner restore contract — design note

**Status: design only; C03 remains NOT QUALIFIED.** This note defines one
owner-bound restore contract for the existing Happier composition. It does not
implement it, does not add a controller, and does not claim a passing runtime,
Windows IPC, installed launcher, or credential handling.

## Binding

| Item | Value |
| --- | --- |
| Happier commit | `e992e049ffa7a98ab60740ac60f94918f022ff24` |
| Happier tree | `911bdc3c673608490b932bd939166d88f198066a` |
| Five-patch candidate tree | `c62fcb80464a0b7161efb4c09bdcbd8d9506bea4` |
| 0006 patch | `patches/happier/0006-local-device-grant-lifecycle.patch`, SHA-256 `a88ed8820854ed4a0288bdb7ee1df98990c7719c183fac4ca4a50461047626a` |
| 0006 target | applies to the five-patch tree; **not** in `series.json` |
| Startup path blobs | `startServer.ts` `e46e782170f85fda5f968f6cce043dd8aa6b77bb`; `api.ts` `e383d565287c41cc527cd6ef8eceab112905c36b`; `auth.ts` (0002) `73322256ad49c29103912c5b075dcffea22495c5` → 0006 `5ea12eec7cdf14742d1b8927570e76c4ecd70693` |
| 0004/0005 blobs | `restrictedRelayIngress.ts` `aa1407828e725961c783d08bba6e1a87a1968721`; `bindRestrictedSocketGrant.ts` `b02ad76abf637e25ffd1da549124479d9be8a33d`; restricted `policy.ts` `3e8430d4b56515c2ce271425a43f8c104e715b3b` |
| Standalone Windows reference | RAC draft commit `e011503ccbd6a3a0fd6188c2333b4c456eebe6ba`: `native/windows-policy/README.md` and `native/windows-launch/README.md`. These files are in that draft, not in the base of this isolated design slice. Neither library implements owner restore. |

## The one existing composition startup path

`apps/server/sources/flavors/light/main.ts` resolves the server flavor from the
environment with `light` as the default and calls `startServer(flavor)`. Its
`--migrate-only` branch applies SQLite migrations and returns before that call.
`apps/server/sources/startServer.ts` then runs, in order:

1. provider selection, light defaults, master-secret setup, DB initializers;
2. `await db.$connect()` (`:210`);
3. `await auth.init()` (`:294`);
4. `await startApi()` (`:334`).

`apps/server/sources/app/api/api.ts` computes `restrictedIngress` (`:107`),
parses `process.env.PORT` (`:157`), and only then binds
`app.listen({ port, host: resolveApiListenHost(process.env) })` (`:158`).
`resolveApiListenHost` returns `127.0.0.1` for restricted ingress, and
`startSocket` receives the same ingress configuration.

`auth.ts` (0006 result) currently derives the authority incarnation from
`readRestrictedDeviceAuthority(process.env)` (`:186`), builds the 0006 closure
from it (`:186-201`), and explicitly calls the env value a **configuration
placeholder** whose protected owner launcher/IPC and pre-listen restore rotation
are not implemented (`:191-194`). There is no restore marker, owner IPC, or
pre-listen gate anywhere in this path.

## Owner contract

**Trusted local owner namespace.** The contract uses one per-user owner namespace
outside the server database, its backups, its restore set and any project tree.
It is an owner-only directory/file namespace protected by the Windows owner SID
and a protected DACL, not by Unix mode bits and not by loopback. The existing
Windows policy helper documents the required owner-only ACL model, reparse
avoidance and identity/protection fingerprints (the bound RAC draft reference
above). The 0005 TypeScript policy path in
`apps/cli/src/security/restrictedDeployment/policy.ts` still **fails closed on
Windows**; the draft helper does not open that path.

**Protected marker.** The namespace holds a small marker, not credential bytes:

- `schemaVersion`, `markerGeneration`, `state`;
- `authorityIncarnation` (the 0006 authority identity);
- `restoreEpoch` and a protected binding to the expected database epoch, which
  cannot be moved backward by a value found in the restored DB;
- `previousMarkerDigest`, `updatedAt`.

The marker contains no master secret, device token, enrollment secret, password
or other reusable credential bytes. It is written atomically, fsynced, and read
through the owner-only Windows boundary. The implementation must demonstrate
durable replacement and recovery on the supported Windows filesystem. A marker
read, ACL, reparse, identity, parse, timeout or consistency failure is a denial.

**Credential bytes.** The owner launcher, marker, IPC and receipts never read,
print, echo or persist master-secret, device-token, enrollment-secret or password
bytes. 0006 recovery is deliberately redacted to enrollment/grant status and never
the secret hash or plaintext (`restrictedDeviceAuthority.ts` `RedactedEnrollmentRecovery`
and `toRecovery`); normal enrollment issuance remains outside this restore
contract. This note requests no live secrets and assumes synthetic-only proof.

**Precedence and fail-closed.** When the marker exists, it is authoritative. The
env value `HAPPIER_RAC_AUTH_INCARNATION` is only a placeholder: a conflicting env
value is a failure, and a missing/invalid marker must not fall back to env. In a
restricted composition, missing marker, invalid marker, or marker/DB disagreement
means the server does not bind `auth.init`, does not call `startApi`, and does not
listen. Non-restricted startup is out of scope.

**First adoption is not recovery.** Ordinary startup does not create a marker or
adopt an unbound database. Only an explicit offline owner provisioning step may
bind a new empty database. Import of an existing unbound database or backup
requires explicit owner approval through the offline restore path: give it a
fresh epoch and incarnation and require fresh enrollment. Missing or invalid
marker state in an existing installation is a denial, not bootstrap.

**Owner-only launch and IPC.** The owner launcher is the only writer of the
marker and the only issuer of restore/rotation commands. It starts the server
through the existing Windows launch ownership component with an absolute
executable, fixed argv, a frozen environment block and creation-time job
containment (see the bound RAC draft reference above). Owner commands travel over
a same-user owner-only local IPC channel (named pipe with an owner-only DACL and
a token/SID check), not over the relay HTTP/socket surface and not over loopback.
The launch component is not wired to the host today and its ACL/signing/reparse
hardening remains later work.

**Serialization and crash recovery.** One owner launcher holds an exclusive
owner-scoped lock. `begin-restore` is accepted only after the relay listener and
all owned server processes are stopped and the old marker is recorded. The marker
state is written before any DB mutation. A server process that starts while the
marker is not `ready`, or a process that observes a marker generation different
from the one it was launched with, refuses to listen. After a crash, the owner
can resume the pending operation or leave the installation offline for explicit
recovery. Aborting does not restore a previous `ready` marker or reuse the old
incarnation. All restricted DB-mutating paths, including startup initialization
and `--migrate-only`, must be gated before mutation; fencing `app.listen` alone
is insufficient.

**Sequence.**

1. **begin-restore** — owner IPC authenticates same-user ownership; acquire the
   exclusive lock; stop/confirm the relay is not listening; write
   `state=restore-begin`, the fresh next incarnation and next restore epoch, and
   the identity or digest of the owner-approved backup set into the protected
   marker. No credential bytes are read or written by the launcher or marker.
2. **restore** — the DB backup is restored externally while the marker remains
   non-`ready`; any server start is refused.
3. **validate/rotate** — under the same exclusive custody, durably move from
   `restore-begin` to `validating` after the restore operation has settled.
   Validate the explicitly approved backup set and the restored database before
   adopting it. A database from before revocation
   must not pass ordinary startup as the current authority. If the owner
   explicitly authorized that backup, restore application data with the relay
   offline, then durably bind the restored database to the fresh epoch and
   incarnation; grants and enrollment claims from the backup must remain
   unusable, not be relabeled as current. Only after that durable bind may the
   marker become `ready`. After a crash between database commit and marker
   replacement, resume only if the committed binding matches the pending
   protected marker exactly; otherwise remain offline.
4. **relay listen** — the server reads the `ready` marker through the owner-only
   boundary before opening the expected database. It verifies the database's
   epoch/binding before initializing the 0006 authority closure and reaching
   `startApi`. The launcher-supplied port
   wins over ambient env; the actual bound loopback port must be the one recorded
   in the owner launch contract and used by ingress/allowed-host checks.

Non-executable state table:

| Marker state | Owner action | DB mutation | Relay listen | Crash recovery |
| --- | --- | --- | --- | --- |
| absent/invalid | deny ordinary start; explicit first provisioning only for a new installation | none on ordinary start | no | fail closed |
| `ready` | normal start or begin-restore | none | normal start only after DB binding check | normal |
| `restore-begin` | restore under owner custody | approved restore only | no | resume or leave offline |
| `validating` | validate/rotate | read/rotate | no | resume matching pending operation or leave offline |
| `ready(new)` | start | none | yes | normal |

## Trust separation

Same-owner OS trust is the Windows token/SID plus owner-only DACL and a
same-user IPC check. It is distinct from:

- **loopback trust** — `127.0.0.1` is a bind address, not owner authentication.
  `restrictedRelayIngress` admits a request with no `Origin` when the `Host` is
  the loopback authority (`restrictedRelayIngress.ts`, `allows`), so a loopback
  request must never be treated as an owner command.
- **phone/host device trust** — 0006 claims and grants are device authority, not
  owner restore authority. A phone or host token cannot write the owner marker,
  invoke `begin-restore`, or authorize rotation. Only the same-owner launcher/IPC
  can.
- **relay origin trust** — `HAPPIER_RAC_PUBLIC_ORIGIN`/Host checks restrict the
  phone transport; they are not owner identity.

The Windows policy helper explicitly notes that “owner-only” is owner-only under
normal access checks, not a defense against an administrator/SYSTEM or another
process running as the same user (see the bound RAC draft reference above).
A process with that owner authority that can replace the marker and database
together is outside the rollback protection this contract provides. The launch
library's evidence is same-user synthetic only.

## Exact proof that would distinguish the cases

All rows are synthetic, non-executable design proofs; none is a runtime claim.

| Case | Synthetic setup | Required observation |
| --- | --- | --- |
| Interrupted marker | marker `restore-begin` with candidate incarnation, DB not rotated | server refuses listen; owner status shows non-`ready`; resume/abort is explicit; no env fallback |
| First adoption and migrate-only | no marker and either a new empty DB or a pre-epoch DB; invoke the restricted migration entry point | ordinary startup and direct migration make no changes; only explicit owner provisioning or offline restore binds the DB, without reviving historical grants |
| Restored pre-revocation DB | restore an older backup while the protected marker expects a newer epoch | ordinary start rejects the stale binding and never listens; explicit owner restore rotates before listen and does not revive any old grant |
| Commit before marker replacement | DB recorded the new binding, but the protected marker still says `validating` | normal start refuses; only a matching pending owner restore can finish and publish `ready` |
| Old vs new enrollment | old enrollment/grant `authorityIncarnation=old`; marker/new closure `new` | old redemption/grant status is not usable (`restore-required`/`enrollment-not-usable`); new enrollment is only accepted under the new incarnation. The 0006 synthetic test already shows this distinction (`0006` patch lines 557-580) |
| Port binding precedence | launcher/marker says loopback port P; ambient `PORT` differs or changes after bind | actual bound address is `127.0.0.1:P`; ingress allowed Hosts derive from the actual bound port; the ambient value cannot admit a stale authority |
| Stale admit | socket admitted before rotation/revocation; marker rotates; old token/grant remains in memory | listener/sockets are closed before rotation; after rotation an old token is rejected on the next check; no new admission from the prepopulated path |
| Marker/env conflict | valid marker says incarnation A; env says B | startup fails closed; B is not used; no listener |

The current 0004 socket binding rechecks a grant every 5 s and on each incoming
packet, with a 2 s timeout (`bindRestrictedSocketGrant.ts:3-4, 31-36`), and
`auth.verifyToken` revalidates against the current incarnation. That leaves an
idle-socket window unless the listener/sockets are quiesced before rotation; the
contract therefore requires a stopped listener and explicit socket closure, not
only the periodic sweep.

## Exact Windows seams and review requirements

- `startServer.ts` has no restore gate between DB connect (`:210`), `auth.init`
  (`:294`) and `startApi` (`:334`). The owner marker/validator must gate these
  steps and any earlier DB mutation; no code currently does. The separate
  `flavors/light/main.ts` `--migrate-only` path must either be denied for a
  restricted launch or run only under the same explicitly authorized offline
  owner operation.
- `auth.ts` still reads the incarnation from env (`:186`) and calls it a
  placeholder (`:191-194`); `createPrismaRestrictedDeviceAuthority` is bound during
  init (`:195-201`). The marker store, owner IPC, and protected launch binding do
  not exist here.
- `api.ts` computes restricted ingress before listen (`:107`), parses `PORT`
  separately (`:157`), and binds at `:158`; it does not compare the marker,
  launcher port or actual bound address. This is the port-precedence seam.
- `readRestrictedRelayIngress` returns `undefined` when the authority env is
  absent, which yields the non-restricted `0.0.0.0`/`*` defaults; a missing marker
  must not be allowed to reach that fallback in a restricted launch.
- `restrictedRelayIngress.ts` derives allowed Hosts from `env.PORT`, not from
  the actual bound socket; the allowed loopback Host can omit `Origin`.
- `bindRestrictedSocketGrant.ts` rechecks a grant, not the restore marker/epoch;
  idle connections can survive until the next sweep, and no listener/socket
  quiesce is implemented.
- The 0005 policy loader fails closed on Windows; the helper is not invoked by
  any patch and has no production package binding. The launch library has no
  production agent binding. See the two bound RAC draft documents above.
- 0006 stores incarnation and lifecycle fields on grants and enrollments, but
  has no global restore epoch or expected backup/database binding. The protected
  epoch and database comparison are required new contracts, not existing
  capabilities.

## Design vs acceptance

This note defines the design constraints for one composition path: owner
namespace and marker precedence, owner-only launch/IPC, the restore sequence,
crash recovery, trust separation and the proof matrix. The storage and locking
mechanisms still need implementation and independent review.

Acceptance is **not** met: there is no implemented owner-only Windows marker/IPC,
no startServer restore gate, no DB high-water/epoch comparison, no actual-bound-
port binding, no quiesce-before-rotate behavior, no installed-runtime test, and
the 0005 Windows path still fails closed. 0006 is not registered in
`series.json`; profiles, patches and the controller topology are unchanged. No
live system, credentials, listeners, Git/remote writes, tests, exploit
reproduction or subdelegation were used for this note.
