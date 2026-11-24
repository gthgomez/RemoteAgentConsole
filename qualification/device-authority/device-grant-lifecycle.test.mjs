import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const patchPath = join(root, 'patches', 'happier', '0006-local-device-grant-lifecycle.patch');
const grantPatchPath = join(root, 'patches', 'happier', '0002-require-current-device-grants.patch');
const sqliteGrantMigration = 'apps/server/prisma/sqlite/migrations/20261124162000_add_restricted_device_grants/migration.sql';
const sqliteEnrollmentMigration = 'apps/server/prisma/sqlite/migrations/20261124193000_add_restricted_device_enrollments/migration.sql';
const serverSpecPath = 'apps/server/sources/app/auth/restrictedDeviceAuthority.integration.spec.ts';

const authorityIncarnation = 'ca3f8c09-6cca-4042-a47a-978a8c2950ac';
const replacementIncarnation = '3a8f4d42-2b8e-4fff-8bd2-2fc44d6655c9';
const accountId = 'fixture-account';
const startMs = 1_000_000;
const secretBytes = 32;
const summary = { suite: 'rac-device-authority-local-lifecycle', checks: 0 };

function readPatchFiles(path) {
    const files = new Map();
    let current = null;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        if (line.startsWith('diff --git ')) {
            current = { added: [], hunks: [] };
            continue;
        }
        if (!current) continue;
        if (line.startsWith('+++ ')) {
            const target = line.slice(4).trim();
            const withoutPrefix = target.startsWith('b/') ? target.slice(2) : target;
            current.path = withoutPrefix === '/dev/null' ? null : withoutPrefix;
            if (current.path) files.set(current.path, current);
            continue;
        }
        if (line.startsWith('@@ ')) {
            current.hunks.push({ header: line, lines: [] });
            continue;
        }
        if (current.hunks.length > 0) current.hunks[current.hunks.length - 1].lines.push(line);
        if (line.startsWith('+') && !line.startsWith('+++')) current.added.push(line.slice(1));
    }
    return files;
}

function applyHunks(baseText, hunks) {
    const lines = baseText.split('\n');
    let offset = 0;
    for (const hunk of hunks) {
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header);
        assert.ok(match, `invalid hunk header ${hunk.header}`);
        const oldStart = Number(match[1]);
        const oldCount = match[2] === undefined ? 1 : Number(match[2]);
        const oldLines = [];
        const newLines = [];
        for (const line of hunk.lines) {
            if (line.startsWith('\\')) continue;
            if (line.startsWith(' ')) {
                oldLines.push(line.slice(1));
                newLines.push(line.slice(1));
            } else if (line.startsWith('-')) {
                oldLines.push(line.slice(1));
            } else if (line.startsWith('+')) {
                newLines.push(line.slice(1));
            }
        }
        assert.equal(oldLines.length, oldCount, `hunk old count mismatch for ${hunk.header}`);
        const index = oldStart === 0 ? 0 : oldStart - 1 + offset;
        assert.deepEqual(lines.slice(index, index + oldLines.length), oldLines, `hunk context mismatch for ${hunk.header}`);
        lines.splice(index, oldLines.length, ...newLines);
        offset += newLines.length - oldLines.length;
    }
    return lines.join('\n');
}

function addedText(files, path) {
    const entry = files.get(path);
    assert.ok(entry, `patch is missing ${path}`);
    return entry.added.join('\n');
}

function iso(ms) {
    return new Date(ms).toISOString();
}

function randomSecret(index) {
    return Buffer.alloc(secretBytes, index).toString('base64url');
}

const patchFiles = readPatchFiles(patchPath);
const grantPatchFiles = readPatchFiles(grantPatchPath);
const modulePaths = {
    contract: 'apps/server/sources/app/auth/restrictedDeviceClaimsContract.ts',
    enrollment: 'apps/server/sources/app/auth/restrictedDeviceEnrollment.ts',
    authority: 'apps/server/sources/app/auth/restrictedDeviceAuthority.ts',
    verifier: 'apps/server/sources/app/auth/restrictedDeviceGrants.ts',
    store: 'apps/server/sources/app/auth/restrictedDeviceEnrollmentStore.ts',
};
const moduleSources = Object.fromEntries(
    Object.entries(modulePaths).map(([key, path]) => [key, addedText(patchFiles, path)]),
);
// The verifier already exists in the five-patch tree and 0006 modifies it;
// reconstruct its final text for execution from patch 0002 plus 0006 hunks.
moduleSources.verifier = applyHunks(
    addedText(grantPatchFiles, modulePaths.verifier),
    patchFiles.get(modulePaths.verifier).hunks,
);

function withTsSpecifiers(source) {
    return source.replace(/from '(\.\/[^']+)'/g, (_match, specifier) => `from '${specifier}.ts'`);
}

const workspace = mkdtempSync(join(tmpdir(), 'rac-device-authority-'));
writeFileSync(join(workspace, 'package.json'), '{"type":"module"}\n');
const moduleFiles = {
    contract: 'restrictedDeviceClaimsContract.ts',
    enrollment: 'restrictedDeviceEnrollment.ts',
    authority: 'restrictedDeviceAuthority.ts',
    verifier: 'restrictedDeviceGrants.ts',
};
for (const [key, fileName] of Object.entries(moduleFiles)) {
    writeFileSync(join(workspace, fileName), `${withTsSpecifiers(moduleSources[key])}\n`);
}
const contract = await import(pathToFileURL(join(workspace, moduleFiles.contract)).href);
const enrollment = await import(pathToFileURL(join(workspace, moduleFiles.enrollment)).href);
const authorityModule = await import(pathToFileURL(join(workspace, moduleFiles.authority)).href);
const verifier = await import(pathToFileURL(join(workspace, moduleFiles.verifier)).href);

const { MAX_RESTRICTED_DEVICE_GENERATION, areRestrictedDeviceClaimTimesUsable, parseRestrictedDeviceGrantClaims } = contract;
const {
    DEFAULT_DEVICE_ENROLLMENT_TTL_MS,
    MAX_DEVICE_ENROLLMENT_TTL_MS,
    MIN_DEVICE_ENROLLMENT_TTL_MS,
    RestrictedDeviceGrantLifecycleError,
    buildRestrictedDeviceGrantClaims,
    createPendingEnrollment,
    hashDeviceEnrollmentSecret,
} = enrollment;
const { MAX_PENDING_ENROLLMENTS_PER_ACCOUNT, createRestrictedDeviceAuthority } = authorityModule;

function createClock(start) {
    let current = start;
    return {
        clock: () => new Date(current),
        set: value => { current = value; },
        advance: delta => { current += delta; },
    };
}

function createFixtureStore() {
    const enrollments = [];
    const grants = [];
    let sequence = 0;

    function toRow(row) {
        const grant = row.redeemedGrantId
            ? grants.find(candidate => candidate.id === row.redeemedGrantId) ?? null
            : null;
        return {
            id: row.id,
            accountId: row.accountId,
            authorityIncarnation: row.authorityIncarnation,
            kind: row.kind,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            consumedAt: row.consumedAt,
            redeemedGrantId: row.redeemedGrantId,
            grant,
        };
    }

    const store = {
        async createEnrollment({ record, maxPending, clock }) {
            const admittedAt = clock();
            for (let index = enrollments.length - 1; index >= 0; index -= 1) {
                const candidate = enrollments[index];
                if (candidate.accountId === record.accountId
                    && candidate.authorityIncarnation === record.authorityIncarnation
                    && candidate.consumedAt === null
                    && candidate.expiresAt.getTime() <= admittedAt.getTime()) {
                    enrollments.splice(index, 1);
                }
            }
            const pending = enrollments.filter(candidate => (
                candidate.accountId === record.accountId
                && candidate.authorityIncarnation === record.authorityIncarnation
                && candidate.consumedAt === null
                && candidate.expiresAt.getTime() > admittedAt.getTime()
            )).length;
            if (pending >= maxPending) {
                throw new RestrictedDeviceGrantLifecycleError('enrollment-limit', 'fixture enrollment limit');
            }
            const id = `enrollment-${++sequence}`;
            enrollments.push({ ...record, id, consumedAt: null, redeemedGrantId: null });
            return { id, expiresAt: record.expiresAt };
        },
        async redeemEnrollment({ secretHash, accountId: requestedAccount, authorityIncarnation: requestedIncarnation, expectedKind, clock }) {
            const admittedAt = clock();
            const row = enrollments.find(candidate => candidate.secretHash === secretHash);
            if (!row
                || row.accountId !== requestedAccount
                || row.authorityIncarnation !== requestedIncarnation
                || row.kind !== expectedKind
                || row.consumedAt !== null
                || row.expiresAt.getTime() <= admittedAt.getTime()) return null;
            row.consumedAt = admittedAt;
            const grant = {
                id: `grant-${grants.length + 1}`,
                accountId: row.accountId,
                authorityIncarnation: row.authorityIncarnation,
                kind: expectedKind,
                generation: 1,
                createdAt: admittedAt,
                revokedAt: null,
            };
            grants.push(grant);
            row.redeemedGrantId = grant.id;
            return { grantId: grant.id, generation: grant.generation, kind: expectedKind };
        },
        async findGrant(id) {
            return grants.find(grant => grant.id === id) ?? null;
        },
        async findEnrollment({ id, accountId: requestedAccount, authorityIncarnation: requestedIncarnation }) {
            const row = enrollments.find(candidate => candidate.id === id);
            if (!row || row.accountId !== requestedAccount || row.authorityIncarnation !== requestedIncarnation) {
                return null;
            }
            return toRow(row);
        },
        async listEnrollments({ accountId: requestedAccount, authorityIncarnation: requestedIncarnation, limit }) {
            return enrollments
                .filter(row => row.accountId === requestedAccount && row.authorityIncarnation === requestedIncarnation)
                .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
                .slice(0, limit)
                .map(toRow);
        },
        async revokeGrantConditionally({ accountId: requestedAccount, authorityIncarnation: requestedIncarnation, grantId, now }) {
            const grant = grants.find(candidate => candidate.id === grantId);
            if (!grant
                || grant.accountId !== requestedAccount
                || grant.authorityIncarnation !== requestedIncarnation
                || grant.revokedAt !== null) return 0;
            grant.revokedAt = now;
            if (grant.generation < MAX_RESTRICTED_DEVICE_GENERATION) grant.generation += 1;
            return 1;
        },
        async deleteExpiredUnusedEnrollments({ authorityIncarnation: requestedIncarnation, now, limit }) {
            let deleted = 0;
            for (let index = 0; index < enrollments.length && deleted < limit; index += 1) {
                const row = enrollments[index];
                if (row.authorityIncarnation === requestedIncarnation
                    && row.consumedAt === null
                    && row.expiresAt.getTime() <= now.getTime()) {
                    enrollments.splice(index, 1);
                    index -= 1;
                    deleted += 1;
                }
            }
            return deleted;
        },
    };
    return { store, enrollments, grants };
}

function setup(incarnation = authorityIncarnation) {
    const fixture = createFixtureStore();
    const time = createClock(startMs);
    const authority = createRestrictedDeviceAuthority({
        authorityIncarnation: incarnation,
        store: fixture.store,
        clock: time.clock,
    });
    return { ...fixture, ...time, authority };
}

async function rejectionCode(promise) {
    try {
        await promise;
    } catch (error) {
        return error?.code;
    }
    return undefined;
}

function errorCode(run) {
    try {
        run();
    } catch (error) {
        return error?.code;
    }
    return undefined;
}

async function redeem(ctx, secret, kind = 'phone') {
    return await ctx.authority.redeemEnrollment({ accountId, secret, expectedKind: kind });
}

async function enrollAndRedeem(ctx, kind = 'phone') {
    const pending = await ctx.authority.createEnrollment({ accountId, kind });
    const grant = await redeem(ctx, pending.secret, kind);
    return { pending, grant };
}

test('closure persists a digest, binds expected kind, and redeems once', async () => {
    const ctx = setup();
    const pending = await ctx.authority.createEnrollment({ accountId, kind: 'host' });
    const stored = ctx.enrollments[0];
    assert.equal(stored.secretHash, hashDeviceEnrollmentSecret(pending.secret));
    assert.notEqual(stored.secretHash, pending.secret);
    assert.ok(!JSON.stringify(stored).includes(pending.secret));
    assert.equal(stored.expiresAt.getTime() - stored.createdAt.getTime(), DEFAULT_DEVICE_ENROLLMENT_TTL_MS);

    assert.equal(await rejectionCode(redeem(ctx, pending.secret, 'phone')), 'enrollment-not-usable');
    assert.equal(ctx.grants.length, 0);
    assert.equal(ctx.enrollments[0].consumedAt, null);

    await assert.doesNotReject(redeem(ctx, pending.secret, 'host'));
    assert.equal(ctx.grants.length, 1);
    assert.equal(ctx.grants[0].kind, 'host');
    assert.equal(await rejectionCode(redeem(ctx, pending.secret, 'host')), 'enrollment-not-usable');
    assert.equal(ctx.grants.length, 1);
    summary.checks += 1;
});

test('admission-time expiry wins over any earlier caller time', async () => {
    const ctx = setup();
    const pending = await ctx.authority.createEnrollment({
        accountId,
        kind: 'phone',
        ttlMs: MIN_DEVICE_ENROLLMENT_TTL_MS,
    });
    ctx.set(startMs + MIN_DEVICE_ENROLLMENT_TTL_MS);
    assert.equal(await rejectionCode(redeem(ctx, pending.secret)), 'enrollment-not-usable');
    assert.equal(ctx.enrollments[0].consumedAt, null);
    assert.equal(ctx.grants.length, 0);
    summary.checks += 1;
});

test('lost response cannot mint or replay a second grant and owner recovery is redacted', async () => {
    const ctx = setup();
    const pending = await ctx.authority.createEnrollment({ accountId, kind: 'phone' });
    const committed = await redeem(ctx, pending.secret);
    assert.equal(await rejectionCode(redeem(ctx, pending.secret)), 'enrollment-not-usable');
    assert.equal(ctx.grants.length, 1);

    const recovery = await ctx.authority.readEnrollmentRecovery({
        accountId,
        enrollmentId: pending.enrollmentId,
    });
    assert.equal(recovery.state, 'redeemed');
    assert.equal(recovery.grant.grantId, committed.grantId);
    const serialized = JSON.stringify(recovery);
    assert.ok(!serialized.includes(pending.secret));
    assert.ok(!serialized.includes('secretHash'));
    assert.equal((await ctx.authority.listRecentEnrollments({ accountId })).length, 1);
    const listed = await ctx.authority.listRecentEnrollments({ accountId });
    assert.equal(listed[0].grant.grantId, committed.grantId);

    assert.equal(await ctx.authority.revokeGrant({ accountId, grantId: committed.grantId }), true);
    assert.notEqual((await ctx.authority.readEnrollmentRecovery({
        accountId,
        enrollmentId: pending.enrollmentId,
    })).grant.revokedAt, null);

    const fresh = await ctx.authority.createEnrollment({ accountId, kind: 'phone' });
    await assert.doesNotReject(redeem(ctx, fresh.secret));
    assert.equal(ctx.grants.length, 2);
    assert.deepEqual(ctx.grants.map(grant => grant.revokedAt !== null), [true, false]);
    summary.checks += 1;
});

test('pending enrollment storage is bounded and cleanup keeps authoritative rows', async () => {
    const ctx = setup();
    for (let index = 0; index < MAX_PENDING_ENROLLMENTS_PER_ACCOUNT; index += 1) {
        await ctx.authority.createEnrollment({ accountId, kind: 'phone' });
    }
    assert.equal(await rejectionCode(ctx.authority.createEnrollment({ accountId, kind: 'phone' })), 'enrollment-limit');

    ctx.advance(MAX_DEVICE_ENROLLMENT_TTL_MS + 1);
    assert.equal(await ctx.authority.cleanupExpiredEnrollments(), MAX_PENDING_ENROLLMENTS_PER_ACCOUNT);
    assert.equal(ctx.enrollments.length, 0);

    const redeemed = await enrollAndRedeem(ctx);
    assert.equal(await ctx.authority.revokeGrant({ accountId, grantId: redeemed.grant.grantId }), true);
    ctx.advance(MAX_DEVICE_ENROLLMENT_TTL_MS + 1);
    assert.equal(await ctx.authority.cleanupExpiredEnrollments(), 0);
    assert.equal(ctx.enrollments.length, 1);
    assert.equal(ctx.grants.length, 1);
    assert.notEqual(ctx.grants[0].revokedAt, null);
    summary.checks += 1;
});

test('terminal-generation revocation does not overflow and denies stale or foreign callers', async () => {
    const ctx = setup();
    const { grant } = await enrollAndRedeem(ctx);
    ctx.grants[0].generation = MAX_RESTRICTED_DEVICE_GENERATION;

    assert.equal(await ctx.authority.revokeGrant({ accountId, grantId: grant.grantId }), true);
    assert.equal(ctx.grants[0].generation, MAX_RESTRICTED_DEVICE_GENERATION);
    assert.notEqual(ctx.grants[0].revokedAt, null);
    assert.equal(await ctx.authority.revokeGrant({ accountId, grantId: grant.grantId }), false);
    assert.equal(await rejectionCode(ctx.authority.buildGrantClaims({ accountId, grantId: grant.grantId })), 'grant-revoked');

    const foreign = setup();
    const foreignGrant = await enrollAndRedeem(foreign);
    assert.equal(await ctx.authority.revokeGrant({ accountId: 'other-account', grantId: foreignGrant.grant.grantId }), false);
    const previous = createRestrictedDeviceAuthority({
        authorityIncarnation: replacementIncarnation,
        store: foreign.store,
        clock: foreign.clock,
    });
    assert.equal(await previous.revokeGrant({ accountId, grantId: foreignGrant.grant.grantId }), false);
    assert.equal(foreign.grants[0].revokedAt, null);
    summary.checks += 1;
});

test('issuer output is accepted by the strict verifier parser and date bound', async () => {
    const ctx = setup();
    const { grant } = await enrollAndRedeem(ctx);
    const claims = await ctx.authority.buildGrantClaims({ accountId, grantId: grant.grantId });
    assert.deepEqual(parseRestrictedDeviceGrantClaims(claims), claims);
    assert.equal(areRestrictedDeviceClaimTimesUsable(claims, startMs), true);

    await assert.doesNotReject(verifier.verifyRestrictedDeviceGrant({
        authorityIncarnation,
        userId: accountId,
        signedExtras: claims,
        nowMs: startMs,
        lookupGrant: async () => ctx.grants[0],
    }));

    assert.equal(parseRestrictedDeviceGrantClaims({ ...claims, extra: true }), null);
    assert.equal(parseRestrictedDeviceGrantClaims({
        ...claims,
        authorityIncarnation: '00000000-0000-0000-0000-000000000000',
    }), null);
    assert.equal(areRestrictedDeviceClaimTimesUsable({
        issuedAtMs: startMs,
        expiresAtMs: startMs + contract.MAX_DEVICE_CLAIM_LIFETIME_MS + 1,
    }, startMs), false);
    assert.equal(await verifier.verifyRestrictedDeviceGrant({
        authorityIncarnation: replacementIncarnation,
        userId: accountId,
        signedExtras: claims,
        nowMs: startMs,
        lookupGrant: async () => ctx.grants[0],
    }), null);
    summary.checks += 1;
});

test('previous-incarnation status is restore-required and does not mutate the grant', async () => {
    const ctx = setup();
    const { grant } = await enrollAndRedeem(ctx);
    const before = { ...ctx.grants[0] };
    const previous = createRestrictedDeviceAuthority({
        authorityIncarnation: replacementIncarnation,
        store: ctx.store,
        clock: ctx.clock,
    });
    assert.equal(await previous.readGrantStatus({ accountId, grantId: grant.grantId }), 'restore-required');
    assert.equal(await rejectionCode(previous.buildGrantClaims({ accountId, grantId: grant.grantId })), 'restore-required');
    assert.deepEqual(ctx.grants[0], before);
    summary.checks += 1;
});

test('sqlite migrations support rollback, separate connections, kind, expiry, and terminal revocation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rac-device-authority-sql-'));
    const dbPath = join(directory, 'fixture.sqlite');
    const first = new DatabaseSync(dbPath);
    let second = null;
    try {
        first.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
        first.exec('CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);');
        first.exec(addedText(grantPatchFiles, sqliteGrantMigration));
        first.exec(addedText(patchFiles, sqliteEnrollmentMigration));

        const indexes = first.prepare('PRAGMA index_list("RestrictedDeviceEnrollment")').all();
        const indexNames = new Set(indexes.map(index => index.name));
        for (const name of [
            'RestrictedDeviceEnrollment_secretHash_key',
            'RestrictedDeviceEnrollment_accountId_createdAt_idx',
            'RestrictedDeviceEnrollment_accountId_consumedAt_expiresAt_idx',
            'RestrictedDeviceEnrollment_authorityIncarnation_consumedAt_expiresAt_idx',
        ]) {
            assert.ok(indexNames.has(name), `missing index ${name}`);
        }
        const columns = first.prepare('PRAGMA table_info("RestrictedDeviceEnrollment")').all().map(column => column.name);
        assert.ok(!columns.includes('secret'));
        assert.ok(!columns.includes('secretValue'));

        first.prepare('INSERT INTO "Account" ("id") VALUES (?)').run(accountId);
        first.prepare('INSERT INTO "Account" ("id") VALUES (?)').run('other-account');
        const insertEnrollment = first.prepare(`
            INSERT INTO "RestrictedDeviceEnrollment"
                ("id", "accountId", "authorityIncarnation", "kind", "secretHash", "createdAt", "expiresAt")
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const insertGrant = first.prepare(`
            INSERT INTO "RestrictedDeviceGrant"
                ("id", "accountId", "authorityIncarnation", "kind", "generation", "createdAt")
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const claim = first.prepare(`
            UPDATE "RestrictedDeviceEnrollment" SET "consumedAt" = ?
            WHERE "secretHash" = ? AND "accountId" = ? AND "authorityIncarnation" = ?
                AND "kind" = ? AND "consumedAt" IS NULL AND "expiresAt" > ?
        `);
        const link = first.prepare('UPDATE "RestrictedDeviceEnrollment" SET "redeemedGrantId" = ? WHERE "id" = ?');

        const secretHash = hashDeviceEnrollmentSecret(randomSecret(1));
        insertEnrollment.run('e1', accountId, authorityIncarnation, 'phone', secretHash, iso(startMs), iso(startMs + 60_000));

        // Explicit rollback must leave neither a consumed enrollment nor a grant.
        first.exec('BEGIN IMMEDIATE');
        assert.equal(claim.run(iso(startMs), secretHash, accountId, authorityIncarnation, 'phone', iso(startMs)).changes, 1);
        insertGrant.run('g1', accountId, authorityIncarnation, 'phone', 1, iso(startMs));
        link.run('g1', 'e1');
        first.exec('ROLLBACK');
        assert.equal(first.prepare('SELECT COUNT(*) AS count FROM "RestrictedDeviceGrant"').get().count, 0);
        assert.equal(first.prepare('SELECT "consumedAt" FROM "RestrictedDeviceEnrollment" WHERE "id" = ?').get('e1').consumedAt, null);

        // Committed claim is visible to a separate connection and cannot repeat.
        first.exec('BEGIN IMMEDIATE');
        assert.equal(claim.run(iso(startMs), secretHash, accountId, authorityIncarnation, 'phone', iso(startMs)).changes, 1);
        insertGrant.run('g1', accountId, authorityIncarnation, 'phone', 1, iso(startMs));
        link.run('g1', 'e1');
        first.exec('COMMIT');

        second = new DatabaseSync(dbPath);
        second.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
        assert.equal(claim.run(iso(startMs), secretHash, accountId, authorityIncarnation, 'phone', iso(startMs)).changes, 0);
        assert.equal(second.prepare('SELECT COUNT(*) AS count FROM "RestrictedDeviceGrant"').get().count, 1);

        // The expected kind is part of the claim.
        insertEnrollment.run('e2', accountId, authorityIncarnation, 'host', hashDeviceEnrollmentSecret(randomSecret(2)), iso(startMs), iso(startMs + 60_000));
        assert.equal(claim.run(iso(startMs), hashDeviceEnrollmentSecret(randomSecret(2)), accountId, authorityIncarnation, 'phone', iso(startMs)).changes, 0);
        assert.equal(claim.run(iso(startMs), hashDeviceEnrollmentSecret(randomSecret(2)), accountId, authorityIncarnation, 'host', iso(startMs)).changes, 1);

        // Expiry is evaluated by the same statement at admission.
        insertEnrollment.run('e3', accountId, authorityIncarnation, 'phone', hashDeviceEnrollmentSecret(randomSecret(3)), iso(startMs - 120_000), iso(startMs - 1));
        assert.equal(claim.run(iso(startMs), hashDeviceEnrollmentSecret(randomSecret(3)), accountId, authorityIncarnation, 'phone', iso(startMs)).changes, 0);

        // Conditional revocation denies foreign and stale rows.
        insertGrant.run('g2', 'other-account', authorityIncarnation, 'phone', 1, iso(startMs));
        insertGrant.run('g3', accountId, replacementIncarnation, 'phone', 1, iso(startMs));
        const revokeIncrement = second.prepare(`
            UPDATE "RestrictedDeviceGrant" SET "revokedAt" = ?, "generation" = "generation" + 1
            WHERE "id" = ? AND "accountId" = ? AND "authorityIncarnation" = ?
                AND "revokedAt" IS NULL AND "generation" < ?
        `);
        const revokeTerminal = second.prepare(`
            UPDATE "RestrictedDeviceGrant" SET "revokedAt" = ?
            WHERE "id" = ? AND "accountId" = ? AND "authorityIncarnation" = ?
                AND "revokedAt" IS NULL AND "generation" >= ?
        `);
        assert.equal(revokeIncrement.run(iso(startMs + 1), 'g2', accountId, authorityIncarnation, MAX_RESTRICTED_DEVICE_GENERATION).changes, 0);
        assert.equal(revokeIncrement.run(iso(startMs + 1), 'g3', accountId, authorityIncarnation, MAX_RESTRICTED_DEVICE_GENERATION).changes, 0);
        assert.equal(second.prepare('SELECT "revokedAt" FROM "RestrictedDeviceGrant" WHERE "id" = ?').get('g3').revokedAt, null);
        insertGrant.run('g5', 'other-account', authorityIncarnation, 'phone', MAX_RESTRICTED_DEVICE_GENERATION, iso(startMs));
        insertGrant.run('g6', accountId, replacementIncarnation, 'phone', MAX_RESTRICTED_DEVICE_GENERATION, iso(startMs));
        assert.equal(revokeTerminal.run(iso(startMs + 1), 'g5', accountId, authorityIncarnation, MAX_RESTRICTED_DEVICE_GENERATION).changes, 0);
        assert.equal(revokeTerminal.run(iso(startMs + 1), 'g6', accountId, authorityIncarnation, MAX_RESTRICTED_DEVICE_GENERATION).changes, 0);
        assert.equal(second.prepare('SELECT "revokedAt" FROM "RestrictedDeviceGrant" WHERE "id" = ?').get('g5').revokedAt, null);
        assert.equal(second.prepare('SELECT "revokedAt" FROM "RestrictedDeviceGrant" WHERE "id" = ?').get('g6').revokedAt, null);

        // A terminal generation is revoked without incrementing past the bound.
        insertGrant.run('g4', accountId, authorityIncarnation, 'phone', MAX_RESTRICTED_DEVICE_GENERATION, iso(startMs));
        assert.equal(revokeIncrement.run(iso(startMs + 2), 'g4', accountId, authorityIncarnation, MAX_RESTRICTED_DEVICE_GENERATION).changes, 0);
        assert.equal(revokeTerminal.run(iso(startMs + 2), 'g4', accountId, authorityIncarnation, MAX_RESTRICTED_DEVICE_GENERATION).changes, 1);
        assert.deepEqual(
            { ...second.prepare('SELECT "generation", "revokedAt" FROM "RestrictedDeviceGrant" WHERE "id" = ?').get('g4') },
            { generation: MAX_RESTRICTED_DEVICE_GENERATION, revokedAt: iso(startMs + 2) },
        );
        assert.equal(revokeTerminal.run(iso(startMs + 3), 'g4', accountId, authorityIncarnation, MAX_RESTRICTED_DEVICE_GENERATION).changes, 0);

        // Cleanup removes only expired unused enrollments; grants and consumed
        // enrollments remain authoritative.
        insertEnrollment.run('e4', accountId, authorityIncarnation, 'phone', hashDeviceEnrollmentSecret(randomSecret(4)), iso(startMs - 120_000), iso(startMs - 1));
        const expiredIds = second.prepare(`
            SELECT "id" FROM "RestrictedDeviceEnrollment"
            WHERE "authorityIncarnation" = ? AND "consumedAt" IS NULL AND "expiresAt" <= ?
            ORDER BY "expiresAt" ASC LIMIT ?
        `).all(authorityIncarnation, iso(startMs), 50).map(row => row.id);
        const deleted = second.prepare(`
            DELETE FROM "RestrictedDeviceEnrollment"
            WHERE "id" IN (${expiredIds.map(() => '?').join(',')})
                AND "authorityIncarnation" = ? AND "consumedAt" IS NULL AND "expiresAt" <= ?
        `).run(...expiredIds, authorityIncarnation, iso(startMs));
        assert.equal(deleted.changes, 2);
        assert.ok(second.prepare('SELECT COUNT(*) AS count FROM "RestrictedDeviceGrant"').get().count >= 1);
        assert.notEqual(second.prepare('SELECT "consumedAt" FROM "RestrictedDeviceEnrollment" WHERE "id" = ?').get('e1').consumedAt, null);
    } finally {
        second?.close();
        first.close();
        rmSync(directory, { recursive: true, force: true });
    }
    summary.checks += 1;
});

test('selected app-server integration spec is present and explicitly gated by prerequisites', () => {
    const spec = addedText(patchFiles, serverSpecPath);
    assert.match(spec, /createLightSqliteHarness/);
    assert.match(spec, /initAuth: true/);
    assert.match(spec, /auth\.getRestrictedDeviceAuthority\(\)/);
    assert.match(spec, /auth\.createRestrictedDeviceToken\(/);
    assert.match(spec, /auth\.verifyToken\(/);
    assert.match(spec, /createPrismaRestrictedDeviceAuthority/);
    assert.match(spec, /verifyRestrictedDeviceGrant/);
    assert.match(spec, /lost response/i);
    assert.match(spec, /legacy token/i);
    assert.match(spec, /selectively revokes phones and a host/i);
    assert.match(spec, /terminal-generation/i);
    assert.match(spec, /synthetic incarnation rotation/i);
    assert.match(spec, /Node 24\.22\.1/);
    assert.match(spec, /Yarn 1\.22\.22/);
    assert.match(spec, /node --version/);
    assert.match(spec, /yarn --version/);
    assert.match(spec, /yarn install --frozen-lockfile/);
    assert.match(spec, /yarn --cwd apps\/server build:shared/);
    assert.match(spec, /yarn --cwd apps\/server generate:light/);
    assert.match(spec, /yarn --cwd apps\/server test:integration/);
    assert.doesNotMatch(spec, /yarn install --immutable/);
    assert.doesNotMatch(spec, /corepack/i);
    assert.doesNotMatch(spec, /\bnpm install -g\b|yarn global add|yarn set version|nvm install|fnm install|volta install/i);
    assert.doesNotMatch(spec, /D:\//);
    assert.doesNotMatch(spec, /\.listen\(|startSocket|Fastify/);
    assert.doesNotMatch(spec, /process\.env/);
    summary.checks += 1;
});

test('patch adds no relay route or ambient authorization and no legacy issuance fallback', () => {
    const added = [...patchFiles.values()].flatMap(file => file.added).join('\n');
    assert.doesNotMatch(added, /\.listen\(/);
    assert.doesNotMatch(added, /app\.(get|post|put|patch|delete|route)\(/);
    assert.doesNotMatch(added, /127\.0\.0\.1|localhost/);
    for (const source of [moduleSources.enrollment, moduleSources.authority, moduleSources.store]) {
        assert.doesNotMatch(source, /process\.env|node:http|Fastify|socket|Origin|HAPPIER_RAC_/);
    }

    assert.match(moduleSources.store, /const admittedAt = clock\(\);/);
    assert.match(moduleSources.store, /kind: expectedKind/);
    assert.match(moduleSources.store, /expiresAt: \{ gt: admittedAt \}/);
    assert.match(moduleSources.store, /consumedAt: null/);
    assert.match(moduleSources.store, /deleteMany\(/);
    assert.match(moduleSources.store, /generation: \{ lt: MAX_RESTRICTED_DEVICE_GENERATION \}/);
    assert.match(moduleSources.store, /generation: \{ gte: MAX_RESTRICTED_DEVICE_GENERATION \}/);
    assert.match(moduleSources.store, /include: \{ redeemedGrant: true \}/);
    assert.match(moduleSources.store, /isolationLevel: 'Serializable'/);
    assert.match(moduleSources.store, /P2034/);

    const authAdded = addedText(patchFiles, 'apps/server/sources/app/auth/auth.ts');
    assert.match(authAdded, /createPrismaRestrictedDeviceAuthority/);
    assert.match(authAdded, /getRestrictedDeviceAuthority/);
    assert.match(authAdded, /buildGrantClaims/);
    assert.doesNotMatch(authAdded, /getRestrictedDeviceIncarnation/);
    assert.doesNotMatch(authAdded, /createToken\s*\(/);
    assert.doesNotMatch(authAdded, /allowLegacy/);

    const schemaAdded = addedText(patchFiles, 'apps/server/prisma/schema.prisma');
    assert.match(schemaAdded, /secretHash\s+String\s+@unique/);
    assert.doesNotMatch(schemaAdded, /\bsecret\s+String/);
    assert.match(schemaAdded, /@@index\(\[accountId, createdAt\]\)/);
    assert.match(schemaAdded, /@@index\(\[accountId, consumedAt, expiresAt\]\)/);

    for (const path of patchFiles.keys()) {
        assert.ok(path.startsWith('apps/server/'), `unexpected patch path ${path}`);
    }
    for (const path of [
        'apps/server/prisma/migrations/20261124193000_add_restricted_device_enrollments/migration.sql',
        'apps/server/prisma/mysql/migrations/20261124193000_add_restricted_device_enrollments/migration.sql',
        'apps/server/prisma/sqlite/migrations/20261124193000_add_restricted_device_enrollments/migration.sql',
    ]) {
        const migration = addedText(patchFiles, path);
        assert.match(migration, /secretHash/i);
        assert.match(migration, /UNIQUE INDEX/i);
        assert.match(migration, /accountId_createdAt_idx|accountId.*createdAt/i);
        assert.doesNotMatch(migration, /["`]secret["`]\s/);
    }
    summary.checks += 1;
});

after(() => {
    rmSync(workspace, { recursive: true, force: true });
    const expectedChecks = 10;
    console.log(`\n${JSON.stringify({
        suite: summary.suite,
        status: summary.checks === expectedChecks ? 'PASS' : 'FAIL',
        checks: summary.checks,
        expectedChecks,
        scope: 'offline execution of patched issuer, verifier, and SQL fixtures; synthetic store and SQLite conditional-update proof',
        serverIntegration: {
            status: 'NOT_RUN',
            spec: serverSpecPath,
            prerequisites: [
                'pre-provisioned portable Node 24.22.1 and Yarn 1.22.22 on PATH in a disposable authorized Linux checkout; version checks only, no shim/global install',
                'yarn install --frozen-lockfile from the checkout root',
                'yarn --cwd apps/server build:shared',
                'yarn --cwd apps/server generate:light (schema:sync + prisma generate --schema prisma/sqlite/schema.prisma)',
                'yarn --cwd apps/server test:integration sources/app/auth/restrictedDeviceAuthority.integration.spec.ts',
                'generated SQLite Prisma client and tsx migration deploy tooling',
            ],
        },
        notRun: [
            'generated SQLite Prisma client and auth integration suite',
            'Happier server typecheck/build and DB-contract suite',
            'protected local IPC or launcher binding',
            'in-flight decision and upload fencing',
        ],
        c03: 'NOT QUALIFIED: no tested owner-only launcher/IPC or pre-listen restore incarnation rotation',
    }, null, 2)}`);
});
