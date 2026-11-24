# Device authority — local grant lifecycle qualification

Patch under test: `patches/happier/0006-local-device-grant-lifecycle.patch`
against the five-patch Happier tree `c62fcb80464a0b7161efb4c09bdcbd8d9506bea4`
(14 changed paths, all under `apps/server/`).

## Scope

This patch adds only server-side owner-authority primitives:

- additive `RestrictedDeviceEnrollment` storage for PostgreSQL, MySQL, and SQLite;
- a pending enrollment that is short-lived (default 5 minutes, 1–15 minute bounds),
  one-time, capped per account under a serializable transaction with retry, and
  persisted as a SHA-256 digest only;
- a bound authority closure created during server init from the captured issuer
  incarnation; production call sites pass no incarnation and no request data;
- atomic redemption through one conditional `updateMany` claim inside a transaction,
  with the ingress-authorized `expectedKind` in the claim, and expiry read from the
  clock **inside the transaction**, not from an earlier caller timestamp;
- a single dependency-free claim/UUID/lifetime contract shared by the issuer and the
  verifier, so a signed claim cannot drift from the accepted schema;
- signed-claim construction bound to the current authority incarnation, account,
  grant id, kind, and generation;
- `auth.createRestrictedDeviceToken` as the only restricted-mode issuance path,
  using the bound closure and with no legacy token fallback;
- owner-side redacted enrollment recovery (`readEnrollmentRecovery`,
  `listRecentEnrollments`) that exposes enrollment/grant status but never the
  secret hash or a reusable plaintext secret;
- conditional selective revocation with a terminal-generation path that sets
  `revokedAt` without incrementing past the integer bound;
- cleanup of expired unused enrollments only; redeemed/consumed enrollments and
  authoritative grant/revocation rows are never deleted by cleanup.

The closure reads no relay environment, binds no listener, adds no route, and never
uses loopback, a public origin, or a phone token as owner authorization. The patch
does not edit `series.json`.

## C03 restore status

**C03 remains NOT QUALIFIED.** The `HAPPIER_RAC_AUTH_INCARNATION` environment read
is only a configuration placeholder. There is no tested owner-only launcher/IPC and
no pre-listen restore-incarnation rotation, so passing a different incarnation string
is not evidence that restore is protected.

The protected production startup binding must be implemented in the owner-only
launcher/IPC boundary before the relay listens: read the current incarnation from an
owner-ACL-protected store, construct the authority closure during server init, and
perform backup-restore validation/rotation under that same boundary. The current env
path must not be represented as that binding.

## Offline qualification

```powershell
node --test qualification/device-authority/device-grant-lifecycle.test.mjs
```

Observed on Windows with Node `24.22.0`: 10 tests passed, 0 failed.

The fixture:

1. extracts the patched issuer, shared claim contract, and closure, reconstructs the
   modified verifier from the 0002 base plus 0006 hunks, rewrites relative TypeScript
   specifiers for Node execution, and runs them against a synthetic store;
2. proves digest-only storage, expected-kind binding (phone cannot redeem host and
   host cannot redeem phone), admission-time expiry, one-time redemption, lost-response
   recovery, pending cap, cleanup retention, terminal-generation revocation, and
   stale/foreign denial;
3. verifies the strict shared claim parser/date bound accepts issuer output and rejects
   extra keys, non-RFC UUIDs, expired claims, and over-long lifetimes;
4. applies the 0002 + 0006 SQLite migrations to a file database, verifies the new
   indexes, and exercises rollback, two separate connections, expected-kind claim,
   admission expiry, foreign/stale revocation, terminal revocation, and bounded cleanup;
5. statically checks the selected server integration spec exists and is gated by its
   documented runtime prerequisites; it does not execute that spec;
6. asserts structurally that the patch adds no route/listener/ambient env read, no
   plaintext secret column, no legacy issuance call, and no `series.json` edit.

The three executable TypeScript modules also pass a standalone
`tsc --strict --erasableSyntaxOnly` check using a minimal `node:crypto` declaration.

## Selected server integration spec — NOT_RUN

`apps/server/sources/app/auth/restrictedDeviceAuthority.integration.spec.ts` is the
installed-runtime companion. It uses upstream `createLightSqliteHarness`, the generated
SQLite Prisma client, the real migration deploy path, and the real `auth` module. It
covers enrollment commit/lost response, single redemption, issuer token plus actual
verifier, selective phone/host revocation, signed legacy-token denial, terminal
generation, and synthetic incarnation rotation with no restore credit.

It is **NOT_RUN in this offline workspace** because the pinned dependency install and
generated SQLite Prisma client are absent. Runtime execution belongs in a disposable
authorized Linux checkout that already provides portable Node `24.22.1` and Yarn
`1.22.22` on `PATH`. Do not activate or install package-manager shims or globals; in
particular, do not run `corepack enable`/`corepack prepare`, because those write
persistent shims and conflict with the no-unattended-install rule on a shared host.

From the checkout root:

```sh
node --version                 # expect v24.22.1
yarn --version                 # expect 1.22.22
yarn install --frozen-lockfile
yarn --cwd apps/server build:shared
yarn --cwd apps/server generate:light
yarn --cwd apps/server test:integration sources/app/auth/restrictedDeviceAuthority.integration.spec.ts
```

Constraints and supported steps:

- use only the pre-provisioned toolchain on `PATH`; no shim activation, no global or
  package-manager installation, and no `yarn set version`;
- the root `packageManager` is `yarn@1.22.22`, so the install is Yarn Classic and uses
  `--frozen-lockfile`; `--immutable` is not a valid Yarn Classic flag;
- `.node-version` pins Node `24.22.1`;
- `apps/server/scripts/buildSharedDeps.mjs` prepares the workspace package outputs;
  `test:unit` gets this through `pretest`, but `test:integration` has no `pretest` hook;
- `generate:light` is the package script
  `yarn -s schema:sync --quiet && prisma generate --schema prisma/sqlite/schema.prisma`;
- `createLightSqliteHarness` then runs the package's `migrate:sqlite:deploy`.

This remains less than installed-runtime qualification. Do not treat the offline
fixtures or the spec's static presence check as a runtime pass. No Prisma runtime or
auth integration run is claimed here.

## Exact applicability

```powershell
node qualification/device-authority/check-patch-applicability.mjs `
  --git-dir <happier-repo>/.git `
  --objects <evidence-object-directory> `
  --alternates <happier-repo>/.git/objects `
  --tree c62fcb80464a0b7161efb4c09bdcbd8d9506bea4 `
  --patch patches/happier/0006-local-device-grant-lifecycle.patch
```

Observed: `PASS`, 14 changed paths, disposable index only; no objects or refs written.

## Not run

- the selected Vitest integration spec against a generated SQLite Prisma client and
  the real auth module;
- Happier server typecheck/build, DB-contract suite, and full unit suite;
- protected local IPC or launcher binding;
- in-flight decision and upload fencing.

Prerequisites for the selected Prisma/auth spec are the commands above: a complete
Happier checkout, Yarn `1.22.22` install with `--frozen-lockfile`, explicit
`build:shared`, `generate:light`, and the `apps/server` Vitest environment. No runtime
result is implied.

## Remaining follow-up

- Remote enrollment redemption under the restricted relay.
- Owner-only local IPC for enrollment creation/redemption, recovery, revocation, and
  token issuance, sourcing the bound closure from server init.
- Protected pre-listen restore-incarnation rotation and launcher/IPC qualification.
- In-flight decision and upload fencing tied to the grant/generation.
- Device token refresh/rotation policy beyond the bounded claim lifetime.
- Generated-client, DB-contract, server build, and full-suite execution.
- Integration-owner review, then `series.json` registration.
