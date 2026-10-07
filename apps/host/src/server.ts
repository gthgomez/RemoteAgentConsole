import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { HostProject } from "./index.js";
import { createHostApp } from "./index.js";
import { canonicalizeConfiguredProjects } from "./projects/canonicalize.js";
import { createRuntimeSupervisor } from "./runtime-supervisor.js";
import { SQLiteHostStore } from "./store.js";

function readProjects(value: string | undefined): HostProject[] {
  if (!value) return [];
  let input: unknown;
  try {
    input = JSON.parse(value);
  } catch {
    throw new Error("RAC_PROJECTS_JSON must contain a JSON array of allowlisted projects");
  }
  if (!Array.isArray(input)) throw new Error("RAC_PROJECTS_JSON must be an array");
  return input.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      !("displayName" in entry) ||
      !("path" in entry) ||
      typeof entry.id !== "string" ||
      typeof entry.displayName !== "string" ||
      typeof entry.path !== "string" ||
      !entry.id.trim() ||
      !entry.displayName.trim() ||
      !isAbsolute(entry.path)
    ) {
      throw new Error(
        `RAC_PROJECTS_JSON entry ${index} requires id, displayName, and an absolute path`,
      );
    }
    return { id: entry.id, displayName: entry.displayName, path: entry.path };
  });
}

const projects = await canonicalizeConfiguredProjects(readProjects(process.env.RAC_PROJECTS_JSON));
const databasePath =
  process.env.RAC_HOST_DATABASE_PATH ??
  join(process.env.LOCALAPPDATA ?? homedir(), ".remote-agent-console", "host.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
const store = new SQLiteHostStore({ filename: databasePath, projects });

const app = createHostApp({
  machineId: process.env.RAC_MACHINE_ID ?? "local-machine",
  projects,
  supervisor: createRuntimeSupervisor({ projects }),
  store,
});

const portValue = Number(process.env.RAC_HOST_PORT ?? "4318");
if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
  throw new Error("RAC_HOST_PORT must be an integer from 1 to 65535");
}
await app.listen({ host: "127.0.0.1", port: portValue });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
