#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
    const result = {
        gitDir: '',
        objects: '',
        alternates: '',
        tree: '',
        patch: join(root, 'patches', 'happier', '0006-local-device-grant-lifecycle.patch'),
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = argv[index + 1];
        if (!value) throw new Error(`Missing value for ${arg}`);
        index += 1;
        if (arg === '--git-dir') result.gitDir = value;
        else if (arg === '--objects') result.objects = value;
        else if (arg === '--alternates') result.alternates = value;
        else if (arg === '--tree') result.tree = value;
        else if (arg === '--patch') result.patch = value;
        else throw new Error(`Unknown option ${arg}`);
    }
    if (!result.gitDir || !result.objects || !result.tree) {
        throw new Error('Pass --git-dir, --objects, and --tree');
    }
    return result;
}

function changedPaths(patchPath) {
    return readFileSync(patchPath, 'utf8')
        .split(/\r?\n/)
        .filter(line => line.startsWith('+++ '))
        .map(line => line.slice(4).trim())
        .filter(path => path !== '/dev/null')
        .map(path => (path.startsWith('b/') ? path.slice(2) : path));
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const temp = mkdtempSync(join(tmpdir(), 'rac-happier-apply-check-'));
    try {
        const env = {
            ...process.env,
            GIT_INDEX_FILE: join(temp, 'index'),
            GIT_OBJECT_DIRECTORY: options.objects,
        };
        if (options.alternates) env.GIT_ALTERNATE_OBJECT_DIRECTORIES = options.alternates;
        execFileSync('git', ['--git-dir', options.gitDir, 'read-tree', options.tree], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        execFileSync('git', [
            '--git-dir', options.gitDir,
            'apply', '--cached', '--check', '--whitespace=error', resolve(options.patch),
        ], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const paths = changedPaths(options.patch);
        for (const path of paths) {
            if (!path.startsWith('apps/server/')) throw new Error(`Unexpected patch path ${path}`);
            if (path === 'patches/happier/series.json') throw new Error('Patch must not edit series.json');
        }
        console.log(JSON.stringify({
            suite: 'happier-0006-exact-applicability',
            status: 'PASS',
            tree: options.tree,
            changedPathCount: paths.length,
            paths,
            scope: 'disposable index only; no objects or refs written',
        }, null, 2));
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
}

try {
    main();
} catch (error) {
    console.error(`[applicability] ${error.message}`);
    process.exitCode = 1;
}
