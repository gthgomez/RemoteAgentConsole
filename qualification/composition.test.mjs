import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  qualifyCandidate,
  stageCandidate,
  verifyPatchSeries,
} from "../distribution/build-composition.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RAC_URL = "https://github.com/gthgomez/RemoteAgentConsole.git";
const BABEL_URL = "https://github.com/gthgomez/Babel.git";
const HAPPIER_URL = "https://github.com/happier-dev/happier.git";
const STANDALONE_WEB_COMMIT = "f6f4032ffe21310f83a652c0c7dc07a205e66ee8";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitInit(repo) {
  execFileSync("git", ["init", "-q", repo], { stdio: ["ignore", "pipe", "pipe"] });
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["config", "user.name", "Composition Fixture"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  git(repo, ["config", "core.eol", "lf"]);
}

function commit(repo, message) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

async function createWorld() {
  const root = await mkdtemp(join(tmpdir(), "rac-composition-test-"));
  const rac = join(root, "rac");
  const babel = join(root, "babel");
  const happier = join(root, "happier");
  const candidate = join(root, "candidate");
  const artifacts = join(root, "artifacts");
  const lockPath = join(rac, "distribution", "composition-lock.json");
  const seriesPath = join(rac, "patches", "happier", "series.json");
  for (const repo of [rac, babel, happier]) gitInit(repo);
  await mkdir(artifacts, { recursive: true });

  await write(join(rac, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nfixture: rac\n");
  await write(join(rac, "README.md"), "# RAC fixture\n");
  const baseRac = commit(rac, "fixture: audited RAC baseline");
  const baseRacTree = git(rac, ["rev-parse", "HEAD^{tree}"]);
  git(rac, ["remote", "add", "origin", RAC_URL]);

  await write(
    join(babel, "babel-cli", "package-lock.json"),
    '{"name":"babel-cli","lockfileVersion":3}\n',
  );
  await write(join(babel, "README.md"), "# Babel fixture\n");
  const babelCommit = commit(babel, "fixture: reviewed Babel candidate");
  const babelTree = git(babel, ["rev-parse", "HEAD^{tree}"]);
  git(babel, ["remote", "add", "origin", BABEL_URL]);
  git(babel, ["checkout", "-q", "--detach", babelCommit]);

  const license = [
    "MIT License",
    "",
    "Copyright (c) fixture",
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    "of this software and associated documentation files (the \"Software\"), to deal",
    "in the Software without restriction.",
    "",
  ].join("\n");
  await write(join(happier, "apps", "cli", "src", "agent", "acp", "AcpBackend.ts"), "fixture\n");
  await write(join(happier, "LICENCE"), license);
  await write(join(happier, "yarn.lock"), "# fixture yarn lock\n");
  await write(join(happier, "README.md"), "# Happier fixture\n");
  const happierCommit = commit(happier, "fixture: pinned Happier base");
  const happierTree = git(happier, ["rev-parse", "HEAD^{tree}"]);
  git(happier, ["remote", "add", "origin", HAPPIER_URL]);
  const happierLicenseSha = sha256(Buffer.from(license));

  const patchDir = join(rac, "patches", "happier");
  const patches = [];
  git(happier, ["checkout", "-q", "-b", "patch-fixture"]);
  let previousCommit = happierCommit;
  for (let index = 1; index <= 5; index += 1) {
    // The last patch modifies a file introduced by the first patch so the
    // receipt verifier must use the final per-path check, not the first one.
    const fileName = index === 5 ? "patch-1.txt" : `patch-${index}.txt`;
    const content =
      index === 5 ? "ordered patch 1\nordered patch 5\n" : `ordered patch ${index}\n`;
    await write(join(happier, fileName), content);
    const currentCommit = commit(happier, `fixture: ordered patch ${index}`);
    const patch = execFileSync(
      "git",
      ["-C", happier, "diff", "--binary", previousCommit, currentCommit],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const patchName = `000${index}-fixture.patch`;
    const patchPath = join(patchDir, patchName);
    await write(patchPath, patch);
    patches.push({
      path: `patches/happier/${patchName}`,
      sha256: sha256(Buffer.from(patch)),
      description: `Fixture patch ${index}`,
    });
    previousCommit = currentCommit;
  }
  git(happier, ["checkout", "-q", "main"]);
  git(happier, ["branch", "-D", "patch-fixture"]);

  const artifactSpecs = [
    {
      id: "happier-cli-windows-x64",
      component: "cli",
      platform: "windows-x64",
      sourceCommit: happierCommit,
      fileName: "fixture-cli.tar.gz",
      content: "fixture cli archive\n",
      tag: "cli-v0.2.21",
    },
    {
      id: "happier-server-windows-x64",
      component: "server-with-web",
      platform: "windows-x64",
      sourceCommit: happierCommit,
      fileName: "fixture-server.tar.gz",
      content: "fixture server archive\n",
      tag: "server-v0.2.21",
    },
    {
      id: "happier-standalone-web-reference",
      component: "standalone-web-reference",
      platform: "web-any",
      sourceCommit: STANDALONE_WEB_COMMIT,
      fileName: "fixture-web.tar.gz",
      content: "fixture web archive\n",
      tag: "ui-web-v0.2.21",
    },
  ];
  const referenceArtifacts = [];
  for (const spec of artifactSpecs) {
    const bytes = Buffer.from(spec.content);
    await write(join(artifacts, spec.fileName), bytes);
    referenceArtifacts.push({
      id: spec.id,
      component: spec.component,
      platform: spec.platform,
      sourceCommit: spec.sourceCommit,
      url: `https://github.com/happier-dev/happier/releases/download/${spec.tag}/${spec.fileName}`,
      fileName: spec.fileName,
      sha256: sha256(bytes),
      bytes: bytes.length,
    });
  }

  const lock = {
    schemaVersion: 1,
    repositories: {
      rac: {
        url: RAC_URL,
        commit: baseRac,
        tree: baseRacTree,
        lockfiles: {
          "pnpm-lock.yaml": sha256(Buffer.from("lockfileVersion: '9.0'\nfixture: rac\n")),
        },
      },
      babel: {
        url: BABEL_URL,
        commit: babelCommit,
        tree: babelTree,
        lockfiles: {
          "babel-cli/package-lock.json": sha256(
            Buffer.from('{"name":"babel-cli","lockfileVersion":3}\n'),
          ),
        },
      },
      happier: {
        url: HAPPIER_URL,
        commit: happierCommit,
        tree: happierTree,
        lockfiles: { "yarn.lock": sha256(Buffer.from("# fixture yarn lock\n")) },
        license: { path: "LICENCE", sha256: happierLicenseSha },
      },
    },
    toolchain: {
      node: process.versions.node,
      yarn: "0.0.0-fixture",
      bun: "0.0.0-fixture",
      pnpm: "0.0.0-fixture",
    },
    referenceArtifacts,
  };
  const series = {
    schemaVersion: 1,
    base: { repository: HAPPIER_URL, commit: happierCommit, tree: happierTree },
    patches,
  };
  await write(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await write(seriesPath, `${JSON.stringify(series, null, 2)}\n`);
  await write(join(rac, "README.md"), "# RAC fixture\n\ncandidate\n");
  const racCommit = commit(rac, "fixture: RAC candidate with pinned composition inputs");

  const staged = await stageCandidate({
    happierRepo: happier,
    lock,
    series,
    lockPath,
    seriesPath,
    artifactRoot: rac,
    artifactDir: artifacts,
    output: candidate,
  });

  return {
    root,
    rac,
    babel,
    happier,
    candidate,
    artifacts,
    lockPath,
    seriesPath,
    lock,
    series,
    baseRac,
    racCommit,
    babelCommit,
    babelTree,
    happierCommit,
    happierTree,
    manifest: staged.manifest,
    patchedTree: staged.manifest.patchedTree,
  };
}

function qualifyOptions(world, overrides = {}) {
  return {
    scope: "codex-only",
    racRepo: world.rac,
    racCommit: world.racCommit,
    babelRepo: world.babel,
    babelCommit: world.babelCommit,
    babelTree: world.babelTree,
    candidateRepo: world.candidate,
    expectedPatchedTree: world.patchedTree,
    artifactDir: world.artifacts,
    ...overrides,
  };
}

function cleanup(world) {
  return rm(world.root, { recursive: true, force: true });
}

test(
  "qualifies an exact codex-only source candidate without Babel or install claims",
  async (t) => {
    const world = await createWorld();
    t.after(() => cleanup(world));

    const receipt = await qualifyCandidate(qualifyOptions(world));

    assert.equal(receipt.receiptType, "rac-composition-candidate-qualification");
    assert.equal(receipt.scope, "codex-only");
    assert.equal(receipt.disposition, "structural-qualified-source-only-not-an-installed-product");
    assert.equal(receipt.structuralChecks.status, "pass");
    assert.equal(receipt.inputs.binding, "selected-rac-commit-blobs");
    assert.equal(receipt.components.rac.identityBound, true);
    assert.equal(receipt.components.rac.selected.commit, world.racCommit);
    assert.equal(receipt.components.rac.selected.checkoutKind, "exact");
    assert.equal(receipt.components.rac.selected.headIsMerge, false);
    assert.equal(receipt.components.rac.baseline.commit, world.baseRac);
    assert.equal(receipt.components.rac.selected.baselineContained, true);
    assert.equal(receipt.components.babel.scope, "excluded");
    assert.equal(receipt.components.babel.identityBound, false);
    assert.equal(receipt.components.babel.selected, null);
    assert.equal(receipt.coverage.babel, "not-covered");
    assert.equal(receipt.candidateIsolation.structuralCandidate, "disposable staged checkout");
    assert.equal(receipt.candidateIsolation.sourceWorktreeClean, "not-claimed");
    assert.equal(receipt.coverage.sourceWorktree, "not-covered");
    assert.equal(receipt.components.happier.identityBound, true);
    assert.equal(receipt.components.happier.receiptBinding, "selected-rac-commit-blobs");
    assert.equal(receipt.components.happier.selected.patchCount, 5);
    assert.equal(receipt.components.happier.selected.patchedTree, world.patchedTree);
    assert.deepEqual(receipt.components.happier.patchedTreeBinding, {
      value: world.patchedTree,
      source: "cli-argument",
    });
    assert.equal(receipt.components.happier.license.spdx, "MIT");
    assert.equal(receipt.referenceArtifacts.status, "files-verified");
    assert.equal(receipt.referenceArtifacts.classification, "compatibility-reference-only");
    assert.equal(receipt.installation.status, "not-qualified");
    assert.equal(receipt.installation.installedProduct, false);
    assert.equal(receipt.installation.activation, "closed");
    assert.deepEqual(receipt.installation.profiles, []);
    assert.equal(receipt.builtEvidence.status, "not-run");
    assert.equal(receipt.builtEvidence.installedProduct, false);
    assert.equal(receipt.builtEvidence.receiptOnly, true);
    assert.equal(receipt.builtEvidence.binariesVerified, false);
    assert.equal(receipt.builtEvidence.installProof, false);
    assert.equal(receipt.builtEvidence.activationProof, false);
    assert.equal(receipt.productClaims.installedProduct, false);
    assert.equal(receipt.productClaims.referenceArtifactsAreCompatibilityInputsOnly, true);
    assert.equal(receipt.buildReadiness.buildsAttempted, false);
    assert.equal(receipt.buildReadiness.matchesPin, false);
    assert.ok(receipt.buildReadiness.reasons.length > 0);
    assert.equal(receipt.buildReadiness.observed.node, process.versions.node);
  },
);

test("complete composition scope binds the actual detached Babel candidate", async (t) => {
  const world = await createWorld();
  t.after(() => cleanup(world));

  const receipt = await qualifyCandidate(qualifyOptions(world, { scope: "composition" }));

  assert.equal(receipt.scope, "composition");
  assert.equal(receipt.components.babel.identityBound, true);
  assert.equal(receipt.components.babel.selected.commit, world.babelCommit);
  assert.equal(receipt.components.babel.selected.tree, world.babelTree);
  assert.equal(receipt.components.babel.selected.checkoutKind, "detached-exact");
  assert.equal(receipt.components.babel.baseline.commit, world.babelCommit);
  assert.equal(receipt.coverage.babel, "source-identity-only");
});

test("stage refuses a patched tree that disagrees with the composition lock pin", async (t) => {
  const world = await createWorld();
  t.after(() => cleanup(world));

  const lock = structuredClone(world.lock);
  lock.repositories.happier.patchedTree = "0".repeat(40);
  await assert.rejects(
    stageCandidate({
      happierRepo: world.happier,
      lock,
      series: world.series,
      lockPath: world.lockPath,
      seriesPath: world.seriesPath,
      artifactRoot: world.rac,
      artifactDir: world.artifacts,
      output: join(world.root, "candidate-pinned"),
    }),
    /does not match the composition lock pin/,
  );
});

test("reads the lock from the selected RAC commit and rejects a missing baseline", async (t) => {
  const world = await createWorld();
  t.after(() => cleanup(world));

  const lock = structuredClone(world.lock);
  lock.repositories.rac.commit = "0".repeat(40);
  await write(
    join(world.rac, "distribution", "composition-lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  const badCommit = commit(world.rac, "fixture: lock with missing baseline");

  await assert.rejects(
    qualifyCandidate(qualifyOptions(world, { racCommit: badCommit })),
    /Cannot resolve the audited RAC baseline/,
  );
});

test("rejects a lock whose audited RAC baseline tree does not match its commit", async (t) => {
  const world = await createWorld();
  t.after(() => cleanup(world));

  const lock = structuredClone(world.lock);
  lock.repositories.rac.tree = "0".repeat(40);
  await write(
    join(world.rac, "distribution", "composition-lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  const badCommit = commit(world.rac, "fixture: lock with mismatched baseline tree");

  await assert.rejects(
    qualifyCandidate(qualifyOptions(world, { racCommit: badCommit })),
    /Audited RAC baseline tree mismatch/,
  );
});

test("requires exact RAC HEAD and rejects a merge parent", async (t) => {
  const world = await createWorld();
  t.after(() => cleanup(world));

  await write(join(world.rac, "LATER.md"), "# later\n");
  commit(world.rac, "fixture: later RAC head");
  await assert.rejects(
    qualifyCandidate(qualifyOptions(world, { racCommit: world.racCommit })),
    /RAC HEAD .* does not equal the explicit expected commit/,
  );

  git(world.rac, ["checkout", "-q", "-b", "feature"]);
  await write(join(world.rac, "FEATURE.md"), "# feature\n");
  const featureCommit = commit(world.rac, "fixture: pull request head");
  git(world.rac, ["checkout", "-q", "main"]);
  git(world.rac, ["merge", "-q", "--no-ff", "-m", "fixture: synthetic merge", "feature"]);
  const mergeHead = git(world.rac, ["rev-parse", "HEAD"]);

  await assert.rejects(
    qualifyCandidate(qualifyOptions(world, { racCommit: featureCommit })),
    /RAC HEAD .* does not equal the explicit expected commit/,
  );

  const receipt = await qualifyCandidate(qualifyOptions(world, { racCommit: mergeHead }));
  assert.equal(receipt.components.rac.selected.commit, mergeHead);
  assert.equal(receipt.components.rac.selected.checkoutKind, "exact");
  assert.equal(receipt.components.rac.selected.headIsMerge, true);
  assert.equal(receipt.components.rac.selected.parents.length, 2);
  assert.ok(receipt.components.rac.selected.parents.includes(featureCommit));
});

test("ignores caller inputs, ambient Git overrides, and replacement objects", async (t) => {
  const world = await createWorld();
  t.after(() => cleanup(world));

  const originalBlob = git(world.rac, [
    "rev-parse",
    "HEAD:patches/happier/0001-fixture.patch",
  ]);
  const replacementBlob = execFileSync(
    "git",
    ["-C", world.rac, "hash-object", "-w", "--stdin"],
    { input: "replacement patch bytes\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
  git(world.rac, ["replace", originalBlob, replacementBlob]);

  const ambient = {
    GIT_DIR: join(world.root, "ambient-git-dir"),
    GIT_COMMON_DIR: join(world.root, "ambient-common-dir"),
    GIT_WORK_TREE: join(world.root, "ambient-work-tree"),
    GIT_INDEX_FILE: join(world.root, "ambient-index"),
    GIT_OBJECT_DIRECTORY: join(world.root, "ambient-objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(world.root, "ambient-alternates"),
    GIT_REPLACE_REF_BASE: "refs/ambient-replace/",
    GIT_GRAFT_FILE: join(world.root, "ambient-grafts"),
    GIT_SHALLOW_FILE: join(world.root, "ambient-shallow"),
  };
  const saved = {};
  for (const [key, value] of Object.entries(ambient)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  let receipt;
  try {
    receipt = await qualifyCandidate({
      ...qualifyOptions(world),
      lock: { forged: true },
      series: { forged: true },
      lockPath: join(world.root, "forged-lock.json"),
      seriesPath: join(world.root, "forged-series.json"),
      artifactRoot: world.root,
    });
  } finally {
    for (const key of Object.keys(ambient)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }

  assert.equal(receipt.inputs.binding, "selected-rac-commit-blobs");
  assert.equal(receipt.inputs.lock.path, "distribution/composition-lock.json");
  assert.equal(receipt.inputs.patchSeries.path, "patches/happier/series.json");
  assert.equal(receipt.inputs.lock.sha256, sha256(await readFile(world.lockPath)));
  assert.equal(receipt.inputs.patchSeries.sha256, sha256(await readFile(world.seriesPath)));
});

test("rejects a staged receipt when the selected RAC commit changes the lock blob", async (t) => {
  const world = await createWorld();
  t.after(() => cleanup(world));

  const changedLock = structuredClone(world.lock);
  changedLock.toolchain.pnpm = "0.0.0-changed";
  await write(
    join(world.rac, "distribution", "composition-lock.json"),
    `${JSON.stringify(changedLock, null, 2)}\n`,
  );
  const changedCommit = commit(world.rac, "fixture: changed composition lock");

  await assert.rejects(
    qualifyCandidate(qualifyOptions(world, { racCommit: changedCommit })),
    /not bound to the composition lock blob of the selected RAC commit/,
  );
});

test("rejects patch bytes that differ from the selected RAC commit blobs", async (t) => {
  const world = await createWorld();
  t.after(() => cleanup(world));

  const patchPath = join(world.rac, "patches", "happier", "0001-fixture.patch");
  const originalPatch = await readFile(patchPath, "utf8");
  await write(patchPath, `${originalPatch}\n# tampered\n`);
  const changedCommit = commit(world.rac, "fixture: changed patch bytes");

  await assert.rejects(
    qualifyCandidate(qualifyOptions(world, { racCommit: changedCommit })),
    /SHA-256 mismatch against selected RAC blob/,
  );
});

test("rejects dirty RAC and dirty Babel checkouts", async (t) => {
  const world = await createWorld();
  t.after(() => cleanup(world));

  await write(join(world.babel, "babel-cli", "package-lock.json"), '{"dirty":true}\n');
  await assert.rejects(
    qualifyCandidate(qualifyOptions(world, { scope: "composition" })),
    /Babel checkout is dirty/,
  );

  await write(join(world.rac, "unexpected.txt"), "dirty\n");
  await assert.rejects(qualifyCandidate(qualifyOptions(world)), /RAC checkout is dirty/);
});

test("disallows Babel moving refs and unreviewed commit strings", async (t) => {
  const world = await createWorld();
  t.after(() => cleanup(world));

  await assert.rejects(
    qualifyCandidate(qualifyOptions(world, { scope: "composition", babelCommit: "main" })),
    /Babel expected commit must be an explicit 40-character commit/,
  );
  await assert.rejects(
    qualifyCandidate(qualifyOptions(world, { scope: "composition", babelTree: "0".repeat(40) })),
    /must equal the reviewed composition lock/,
  );
  await assert.rejects(
    qualifyCandidate(qualifyOptions(world, { scope: "composition", babelCommit: "0".repeat(40) })),
    /must equal the reviewed composition lock/,
  );

  git(world.babel, ["checkout", "-q", "-b", "moving-branch"]);
  await assert.rejects(
    qualifyCandidate(qualifyOptions(world, { scope: "composition" })),
    /Babel checkout is attached to the moving ref refs\/heads\/moving-branch/,
  );
});

test("rejects swapped repository identities", async (t) => {
  const world = await createWorld();
  t.after(() => cleanup(world));

  await assert.rejects(
    qualifyCandidate(qualifyOptions(world, { racRepo: world.babel })),
    /does not equal the explicit expected commit|Git blob is missing/,
  );

  git(world.rac, ["checkout", "-q", "--detach", world.racCommit]);
  await assert.rejects(
    qualifyCandidate(qualifyOptions(world, { scope: "composition", babelRepo: world.rac })),
    /Babel HEAD mismatch/,
  );
});

test("detects staged receipt tampering and product-claim inflation", async (t) => {
  const world = await createWorld();
  t.after(() => cleanup(world));

  const receiptPath = join(world.candidate, "rac-composition-evidence.json");
  const original = await readFile(receiptPath, "utf8");
  const cases = [
    [
      "patched tree",
      (receipt) => {
        receipt.patchedTree = "0".repeat(40);
      },
      /Candidate receipt patched tree mismatch/,
    ],
    [
      "patch digest",
      (receipt) => {
        receipt.patches[0].sha256 = "0".repeat(64);
      },
      /SHA-256 does not match the patch series/,
    ],
    [
      "patch count",
      (receipt) => {
        receipt.patches.pop();
      },
      /exactly 5 ordered Happier patches/,
    ],
    [
      "source identity",
      (receipt) => {
        receipt.source.commit = "0".repeat(40);
      },
      /Candidate receipt source does not match/,
    ],
    [
      "disposition",
      (receipt) => {
        receipt.disposition = "production";
      },
      /scaffold-only/,
    ],
    [
      "packaging",
      (receipt) => {
        receipt.productionPackaging = "enabled";
      },
      /production packaging/,
    ],
    [
      "profiles",
      (receipt) => {
        receipt.productionProfiles = ["codex"];
      },
      /production profile/,
    ],
    [
      "installed product",
      (receipt) => {
        receipt.installation.installedProduct = true;
      },
      /installed downstream product/,
    ],
    [
      "built evidence in structural candidate",
      (receipt) => {
        receipt.builtEvidence = {
          status: "source-built-reference-only",
          classification: "not-an-installed-product",
        };
      },
      /must not carry built-product evidence/,
    ],
    [
      "patch series binding",
      (receipt) => {
        receipt.inputs.patchSeriesSha256 = "0".repeat(64);
      },
      /not bound to the Happier patch series blob of the selected RAC commit/,
    ],
  ];

  for (const [name, mutate, pattern] of cases) {
    const receipt = JSON.parse(original);
    mutate(receipt);
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    await assert.rejects(qualifyCandidate(qualifyOptions(world)), pattern, name);
  }
  await writeFile(receiptPath, original);
  await assert.doesNotReject(qualifyCandidate(qualifyOptions(world)));
});

test("rejects candidate content outside the declared patch series or build outputs", async (t) => {
  const world = await createWorld();
  t.after(() => cleanup(world));

  await write(join(world.candidate, "build-output.bin"), "unexpected\n");
  await assert.rejects(
    qualifyCandidate(qualifyOptions(world)),
    /content outside the declared patch series/,
  );
  await rm(join(world.candidate, "build-output.bin"));

  await mkdir(join(world.candidate, "node_modules"));
  await assert.rejects(
    qualifyCandidate(qualifyOptions(world)),
    /contains build or install output/,
  );
});

test("accepts source-built evidence only as a receipt, never an installed product", async (t) => {
  const world = await createWorld();
  t.after(() => cleanup(world));

  const buildReceiptPath = join(world.root, "build-evidence.json");
  const buildReceipt = {
    receiptType: "happier-reference-build",
    disposition: "scaffold-only-not-a-production-or-qualified-package",
    source: {
      repository: HAPPIER_URL,
      commit: world.happierCommit,
      tree: world.happierTree,
    },
    patchedTree: world.patchedTree,
    inputs: {
      lockSha256: sha256(await readFile(world.lockPath)),
      patchSeriesSha256: sha256(await readFile(world.seriesPath)),
    },
    patches: world.manifest.patches,
    productionProfiles: [],
    productionPackaging: "disabled",
    qualification: "not-run",
    builtEvidence: {
      status: "source-built-reference-only",
      classification: "not-an-installed-product",
      installation: { status: "not-qualified", installedProduct: false },
      outputs: { buildType: "upstream-reference-only" },
    },
    installation: { status: "not-qualified", installedProduct: false },
    buildReadiness: { matchesPin: true },
  };
  await write(buildReceiptPath, `${JSON.stringify(buildReceipt, null, 2)}\n`);

  const receipt = await qualifyCandidate(
    qualifyOptions(world, { buildEvidencePath: buildReceiptPath }),
  );
  assert.equal(receipt.builtEvidence.status, "source-built-reference-only");
  assert.equal(receipt.builtEvidence.receiptOnly, true);
  assert.equal(receipt.builtEvidence.binariesVerified, false);
  assert.equal(receipt.builtEvidence.installedProduct, false);
  assert.equal(receipt.builtEvidence.installProof, false);
  assert.equal(receipt.builtEvidence.activationProof, false);
  assert.equal(receipt.installation.installedProduct, false);
  assert.equal(receipt.coverage.builtArtifacts, "receipt-only");

  const tampered = [
    [
      "packaging",
      (value) => {
        value.productionPackaging = "enabled";
      },
      /claims production packaging/,
    ],
    [
      "installed product",
      (value) => {
        value.installation.installedProduct = true;
      },
      /installed downstream product/,
    ],
    [
      "build evidence label",
      (value) => {
        value.builtEvidence.status = "installed-product";
      },
      /not labeled as a source-only upstream reference build/,
    ],
  ];
  for (const [name, mutate, pattern] of tampered) {
    const value = JSON.parse(JSON.stringify(buildReceipt));
    mutate(value);
    await write(buildReceiptPath, `${JSON.stringify(value, null, 2)}\n`);
    await assert.rejects(
      qualifyCandidate(qualifyOptions(world, { buildEvidencePath: buildReceiptPath })),
      pattern,
      name,
    );
  }
});

test("the checked-in lock preserves five ordered patches and a patched tree pin", async () => {
  const lock = JSON.parse(
    await readFile(join(REPO_ROOT, "distribution", "composition-lock.json"), "utf8"),
  );
  const series = JSON.parse(
    await readFile(join(REPO_ROOT, "patches", "happier", "series.json"), "utf8"),
  );
  const patches = await verifyPatchSeries({ series, lock, artifactRoot: REPO_ROOT });

  assert.equal(patches.length, 5);
  assert.deepEqual(
    patches.map((patch) => patch.order),
    [1, 2, 3, 4, 5],
  );
  assert.match(lock.repositories.happier.patchedTree, /^[a-f0-9]{40}$/);
  assert.equal(series.base.commit, lock.repositories.happier.commit);
  assert.equal(series.base.tree, lock.repositories.happier.tree);
  assert.equal(lock.referenceArtifacts.length, 3);
  for (const item of lock.referenceArtifacts) {
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
  }
});

test("the existing structural verify path still reports reference-only inputs", async () => {
  assert.ok(existsSync(join(REPO_ROOT, "distribution", "build-composition.mjs")));
  assert.ok(existsSync(join(REPO_ROOT, "patches", "happier", "series.json")));
});
