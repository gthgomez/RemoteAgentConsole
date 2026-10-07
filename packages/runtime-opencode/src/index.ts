import { spawn } from "node:child_process";
import type { AcpRuntimeOptions } from "@remote-agent-console/acp-client";
import { createAcpRuntimeAdapter } from "@remote-agent-console/acp-client";
import type { RuntimeCapabilities, RuntimeSummary } from "@remote-agent-console/contracts";
import type { RuntimeAdapter } from "@remote-agent-console/runtime-core";

const opencodeCapabilities: RuntimeCapabilities = {
  sessions: { create: true, resume: false, list: false },
  interaction: { cancel: true, permissions: true, questions: false },
  models: { selectable: false, effort: false },
  modes: false,
  plans: false,
  commands: false,
  images: false,
  files: false,
};

export interface OpenCodeRuntimeOptions {
  projects: Readonly<Record<string, string>>;
  command?: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export interface OpenCodeDiscoveryOptions {
  command?: string;
  versionArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Wraps OpenCode's stable ACP v1 stdio entry point in the shared ACP adapter. */
export function createOpenCodeRuntimeAdapter(
  options: OpenCodeRuntimeOptions,
  adapterFactory: (options: AcpRuntimeOptions) => RuntimeAdapter = createAcpRuntimeAdapter,
): RuntimeAdapter {
  return adapterFactory({
    id: "opencode",
    displayName: "OpenCode",
    command: options.command ?? "opencode",
    args: options.args ?? ["acp"],
    ...(options.env ? { env: options.env } : {}),
    projects: options.projects,
  });
}

/** Probes the local CLI with `--version` without invoking a shell. */
export async function discoverOpenCode(
  options: OpenCodeDiscoveryOptions = {},
): Promise<RuntimeSummary> {
  const result = await captureCommand(
    options.command ?? "opencode",
    options.versionArgs ?? ["--version"],
    options.env ?? process.env,
    options.timeoutMs ?? 3000,
  );
  if (result.exitCode !== 0 || result.timedOut || result.error) {
    return {
      id: "opencode",
      displayName: "OpenCode",
      installed: false,
      capabilities: null,
    };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const versionMatch = output.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/m);
  return {
    id: "opencode",
    displayName: "OpenCode",
    installed: true,
    ...(versionMatch?.[1] ? { version: versionMatch[1] } : {}),
    capabilities: { ...opencodeCapabilities },
  };
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
  timedOut: boolean;
}

function captureCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let error: Error | null = null;
    let timedOut = false;
    let settled = false;
    const child = spawn(command, [...args], {
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, error, timedOut });
    };
    const append = (current: string, chunk: Buffer) => {
      if (current.length >= 32_768) return current;
      return current + chunk.toString("utf8").slice(0, 32_768 - current.length);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (cause) => {
      error = cause;
      finish(null);
    });
    child.once("close", (code) => finish(code));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(null);
    }, timeoutMs);
    timer.unref();
  });
}
