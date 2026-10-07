import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeConfiguredProjects } from "../../src/projects/canonicalize.js";

describe("canonicalizeConfiguredProjects", () => {
  let tempDirectory: string;

  beforeEach(async () => {
    tempDirectory = await mkdtemp(path.join(tmpdir(), "rac-project-paths-"));
  });

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });

  it("returns absolute existing directory paths resolved through realpath", async () => {
    const projectPath = path.join(tempDirectory, "project");
    await mkdir(projectPath);

    const projects = await canonicalizeConfiguredProjects([
      { id: "demo", displayName: "Demo", path: path.join(projectPath, ".") },
    ]);

    expect(projects).toEqual([
      { id: "demo", displayName: "Demo", path: await realpath(projectPath) },
    ]);
  });

  it("rejects a configured path that does not exist", async () => {
    await expect(
      canonicalizeConfiguredProjects([
        { id: "missing", displayName: "Missing", path: path.join(tempDirectory, "absent") },
      ]),
    ).rejects.toThrow(/does not exist/i);
  });

  it("rejects a path that is not absolute", async () => {
    await expect(
      canonicalizeConfiguredProjects([
        { id: "relative", displayName: "Relative", path: "./project" },
      ]),
    ).rejects.toThrow(/must be absolute/i);
  });

  it("rejects a configured path that is a file", async () => {
    const filePath = path.join(tempDirectory, "not-a-directory");
    await writeFile(filePath, "file");

    await expect(
      canonicalizeConfiguredProjects([{ id: "file", displayName: "File", path: filePath }]),
    ).rejects.toThrow(/must be a directory/i);
  });

  it("resolves a directory symlink to its canonical target", async () => {
    const projectPath = path.join(tempDirectory, "project");
    const aliasPath = path.join(tempDirectory, "alias");
    await mkdir(projectPath);
    await symlink(projectPath, aliasPath, process.platform === "win32" ? "junction" : "dir");

    const projects = await canonicalizeConfiguredProjects([
      { id: "alias", displayName: "Alias", path: aliasPath },
    ]);

    expect(projects[0]?.path).toBe(await realpath(projectPath));
  });

  it("rejects two IDs that resolve to the same directory path", async () => {
    const projectPath = path.join(tempDirectory, "project");
    const aliasPath = path.join(tempDirectory, "alias");
    await mkdir(projectPath);
    await symlink(projectPath, aliasPath, process.platform === "win32" ? "junction" : "dir");

    await expect(
      canonicalizeConfiguredProjects([
        { id: "primary", displayName: "Primary", path: projectPath },
        { id: "alias", displayName: "Alias", path: aliasPath },
      ]),
    ).rejects.toThrow(/same canonical path/i);
  });

  it("rejects duplicate project IDs", async () => {
    const firstPath = path.join(tempDirectory, "first");
    const secondPath = path.join(tempDirectory, "second");
    await Promise.all([mkdir(firstPath), mkdir(secondPath)]);

    await expect(
      canonicalizeConfiguredProjects([
        { id: "duplicate", displayName: "First", path: firstPath },
        { id: "duplicate", displayName: "Second", path: secondPath },
      ]),
    ).rejects.toThrow(/duplicate project id/i);
  });
});
