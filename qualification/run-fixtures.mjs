#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPatchSeries, verifyUpstream } from "../distribution/build-composition.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const result = { happierRepo: resolve(root, "..", "Happier"), artifactDir: "", candidate: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!["--happier-repo", "--artifact-dir", "--candidate"].includes(arg) || !argv[index + 1]) {
      fail(`Unknown or incomplete option: ${arg}`);
    }
    const value = resolve(argv[++index]);
    if (arg === "--happier-repo") result.happierRepo = value;
    if (arg === "--artifact-dir") result.artifactDir = value;
    if (arg === "--candidate") result.candidate = value;
  }
  if (!result.artifactDir)
    fail("Pass --artifact-dir pointing to the verified upstream artifact cache");
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const lock = JSON.parse(
    await readFile(resolve(root, "distribution", "composition-lock.json"), "utf8"),
  );
  const series = JSON.parse(
    await readFile(resolve(root, "patches", "happier", "series.json"), "utf8"),
  );
  const evidence = await verifyUpstream({
    happierRepo: options.happierRepo,
    artifactDir: options.artifactDir,
    lock,
  });
  const patches = await verifyPatchSeries({ series });
  evidence.patchSeries = { count: patches.length };

  let candidate = null;
  if (options.candidate) {
    candidate = JSON.parse(
      await readFile(resolve(options.candidate, "rac-composition-evidence.json"), "utf8"),
    );
    if (candidate.disposition !== "scaffold-only-not-a-production-or-qualified-package") {
      fail("Candidate evidence does not identify itself as scaffold-only");
    }
    if (candidate.source?.commit !== evidence.commit || candidate.source?.tree !== evidence.tree) {
      fail("Candidate source does not match the verified upstream fixture");
    }
    if (
      candidate.productionPackaging !== "disabled" ||
      candidate.productionProfiles?.length !== 0
    ) {
      fail("Scaffold fixture must not enable or package a production profile");
    }
  }

  console.log(
    JSON.stringify(
      {
        suite: "pinned-composition-input-fixtures",
        status: "PASS",
        scope:
          "structural fixture only; no agent protocol, Windows process, phone, or physical qualification",
        pinnedCommit: evidence.commit,
        pinnedTree: evidence.tree,
        patchCount: evidence.patchSeries.count,
        verifiedReferenceArtifacts: evidence.artifacts.map(({ id, sha256, bytes }) => ({
          id,
          sha256,
          bytes,
        })),
        productionProfilesEnabled: candidate?.productionProfiles ?? [],
        productionPackaging: candidate?.productionPackaging ?? "not attempted",
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[fixtures] ${error.message}`);
    process.exitCode = 1;
  });
}
