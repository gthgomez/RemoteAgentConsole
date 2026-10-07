import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface ConfiguredProject {
  id: string;
  displayName: string;
  path: string;
}

/** Validates configured allowlist entries and replaces paths with their canonical directory paths. */
export async function canonicalizeConfiguredProjects(
  projects: readonly ConfiguredProject[],
): Promise<ConfiguredProject[]> {
  const seenIds = new Set<string>();
  const seenPaths = new Map<string, string>();
  const canonicalProjects: ConfiguredProject[] = [];

  for (const project of projects) {
    if (!project.id.trim()) throw new Error("Configured project IDs must not be empty");
    if (seenIds.has(project.id)) {
      throw new Error(`Duplicate project ID: ${project.id}`);
    }
    seenIds.add(project.id);

    if (!isAbsolute(project.path)) {
      throw new Error(`Configured project path for ID '${project.id}' must be absolute`);
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(project.path);
    } catch {
      throw new Error(
        `Configured project path for ID '${project.id}' does not exist or cannot be resolved`,
      );
    }

    let isDirectory: boolean;
    try {
      isDirectory = (await stat(canonicalPath)).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      throw new Error(`Configured project path for ID '${project.id}' must be a directory`);
    }

    const pathKey = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
    const existingId = seenPaths.get(pathKey);
    if (existingId) {
      throw new Error(
        `Configured projects '${existingId}' and '${project.id}' resolve to the same canonical path`,
      );
    }
    seenPaths.set(pathKey, project.id);
    canonicalProjects.push({ ...project, path: canonicalPath });
  }

  return canonicalProjects;
}
