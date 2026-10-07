import { isAbsolute } from "node:path";
import type { AcpRuntimeOptions } from "@remote-agent-console/acp-client";
import type { RuntimeCapabilities, RuntimeSummary } from "@remote-agent-console/contracts";
import {
  createCommandCodeAdapter,
  discoverCommandCodeExecutable,
  readCommandCodeVersion,
} from "@remote-agent-console/runtime-command-code";
import type { RuntimeAdapter } from "@remote-agent-console/runtime-core";
import {
  createOpenCodeRuntimeAdapter,
  discoverOpenCode,
} from "@remote-agent-console/runtime-opencode";
import { createFakeRuntimeSupervisor } from "./fake-runtime.js";
import type { HostProject } from "./index.js";
import type { RuntimeSessionPort, RuntimeSupervisorPort } from "./ports.js";
import { createRuntimeSessionPort } from "./runtime-session-port.js";

export type HostAcpAdapterFactory = (options: AcpRuntimeOptions) => RuntimeAdapter;

export interface RuntimeSupervisorOptions {
  projects: readonly HostProject[];
  env?: NodeJS.ProcessEnv;
  commandCodeExecutable?: string;
  openCodeExecutable?: string;
  adapterFactory?: HostAcpAdapterFactory;
  fakeSupervisor?: RuntimeSupervisorPort;
}

const commandCodeCapabilities: RuntimeCapabilities = {
  sessions: { create: true, resume: false, list: false },
  interaction: { cancel: true, permissions: true, questions: false },
  models: { selectable: false, effort: false },
  modes: false,
  plans: false,
  commands: false,
  images: false,
  files: false,
};

export function createRuntimeSupervisor(options: RuntimeSupervisorOptions): RuntimeSupervisorPort {
  const env = options.env ?? process.env;
  const projects = new Map(options.projects.map((project) => [project.id, project]));
  const projectPaths = Object.fromEntries(options.projects.map(({ id, path }) => [id, path]));
  const adapterFactory = options.adapterFactory;
  const fakeSupervisor =
    options.fakeSupervisor ?? createFakeRuntimeSupervisor({ projects: options.projects });
  const sessions = new Set<RuntimeSessionPort & { close(): Promise<void> }>();

  const configuredCommandCodePath =
    options.commandCodeExecutable ?? env.RAC_COMMAND_CODE_EXECUTABLE;
  const commandCodePath = discoverCommandCodeExecutable({
    ...(configuredCommandCodePath ? { executablePath: configuredCommandCodePath } : {}),
    env,
  });
  const commandCodeVersion = commandCodePath
    ? readCommandCodeVersion(commandCodePath, { env })
    : undefined;
  const commandCodeSummary: RuntimeSummary = commandCodePath
    ? {
        id: "command-code",
        displayName: "Command Code",
        installed: true,
        ...(commandCodeVersion ? { version: commandCodeVersion } : {}),
        capabilities: commandCodeCapabilities,
      }
    : {
        id: "command-code",
        displayName: "Command Code",
        installed: false,
        capabilities: null,
      };

  const openCodeCommand = options.openCodeExecutable ?? env.RAC_OPENCODE_EXECUTABLE ?? "opencode";
  const openCodeSummaryPromise = discoverOpenCode({ command: openCodeCommand, env });
  const openCodeAdapterPromise = openCodeSummaryPromise.then((summary) =>
    summary.installed
      ? createOpenCodeRuntimeAdapter(
          { command: openCodeCommand, args: ["acp"], env, projects: projectPaths },
          adapterFactory,
        )
      : null,
  );
  const commandCodeAdapter = commandCodePath
    ? createCommandCodeAdapter(
        { executablePath: commandCodePath, env, projects: projectPaths },
        adapterFactory,
      )
    : null;

  return {
    async runtimes(): Promise<readonly RuntimeSummary[]> {
      const openCodeSummary = await openCodeSummaryPromise;
      const fakeRuntimes = await fakeSupervisor.runtimes();
      return [...fakeRuntimes, commandCodeSummary, openCodeSummary];
    },
    async createSession(input): Promise<RuntimeSessionPort> {
      const project = projects.get(input.projectId);
      if (!project || !isAbsolute(project.path) || project.path !== input.projectPath) {
        throw new Error("Runtime session project does not match the host allowlist");
      }
      if (input.runtimeId === "fake") return fakeSupervisor.createSession(input);

      let adapter: RuntimeAdapter | null;
      if (input.runtimeId === "command-code") adapter = commandCodeAdapter;
      else if (input.runtimeId === "opencode") adapter = await openCodeAdapterPromise;
      else adapter = null;
      if (!adapter) throw new Error(`Runtime is not installed: ${input.runtimeId}`);

      const session = await createRuntimeSessionPort(adapter, input);
      sessions.add(session);
      return session;
    },
    async close() {
      await Promise.all([...sessions].map((session) => session.close()));
      sessions.clear();
      await fakeSupervisor.close?.();
    },
  };
}
