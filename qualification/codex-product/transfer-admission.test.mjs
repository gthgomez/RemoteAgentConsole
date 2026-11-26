import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const root = process.argv[2] ?? process.env.RAC_TRANSFER_WITNESS_HAPPIER_ROOT;
assert.ok(root && isAbsolute(root), "supply the absolute patched Happier checkout root");
const cliSource = pathToFileURL(join(root, "apps/cli/src/api/machine/rpcHandlers.promptAssetTransfers.ts")).href;
const state = { restricted: true, events: [] };
const sharedSymbol = Symbol.for("rac-transfer-admission-witness");
globalThis[sharedSymbol] = state;
const imports = new Map([
  ["@happier-dev/protocol", "export const PromptAssetMutationResponseV1Schema={},PromptAssetReadRequestSchema={},RPC_METHODS=new Proxy({}, {get:(_, key)=>key});"],
  ["@/configuration", "export const configuration={filesTransferSessionTtlMs:30000};"],
  ["@/security/restrictedDeployment/policy", "export function isRestrictedDeploymentConfigured(){return state.restricted;}"],
  ["@/transfers/core/transferSessionStore", "export class TransferSessionStore { dispose(){state.events.push('dispose');} }"],
  ["@/transfers/rpc/registerUploadTransferLifecycleHandlers", "export function registerUploadTransferLifecycleHandlers({methods}){state.events.push(...Object.values(methods));}"],
  ["./transfers/registerMachineDownloadTransferRpcHandlers", "export function registerMachineDownloadTransferRpcHandlers({methods}){state.events.push(...Object.values(methods));}"],
  ["@/transfers/targets/resolvePromptAssetDownloadSource", "export function resolvePromptAssetDownloadSource(){throw Error('unexpected_effect');}"],
  ["@/transfers/targets/resolvePromptAssetUploadTarget", "export function resolvePromptAssetUploadTarget(){throw Error('unexpected_effect');}"],
]);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL !== cliSource) return next(specifier, context);
    const code = imports.get(specifier);
    assert.ok(code, "unexpected witness dependency");
    return {
      url: `data:text/javascript,${encodeURIComponent(
        `const state=globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(sharedSymbol))})];${code}`,
      )}`,
      shortCircuit: true,
    };
  },
});
const { registerMachinePromptAssetTransferRpcHandlers } = await import(cliSource);
hooks.deregister();

test("restricted startup registers no prompt asset effect path, unrestricted startup retains both lanes", async () => {
  const params = { rpcHandlerManager: {}, adapterRegistry: new Map() };
  const restricted = registerMachinePromptAssetTransferRpcHandlers(params);
  assert.deepEqual(state.events, []);
  await restricted.dispose();
  assert.deepEqual(state.events, ["dispose"]);
  state.events = [];
  state.restricted = false;
  const normal = registerMachinePromptAssetTransferRpcHandlers(params);
  assert.deepEqual(state.events, ["DOWNLOAD", "UPLOAD"].flatMap((kind) =>
    ["INIT", "CHUNK", "FINALIZE", "ABORT"].map((step) => `DAEMON_PROMPT_ASSETS_${kind}_${step}`)));
  await normal.dispose();
  assert.equal(state.events.at(-1), "dispose");
});

test("restricted relay does not consult the ordinary machine transfer feature override", async () => {
  const source = await readFile(join(root, "apps/server/sources/app/api/socket.ts"), "utf8");
  const expression = /const serverRoutedTransferEnabled = ([\s\S]+?);/.exec(source)?.[1];
  assert.ok(expression);
  assert.match(source, /machineTransferHandler\(userId, socket, \{\s*io,\s*serverRoutedTransferEnabled,/);
  let consulted = 0;
  const sandbox = { restrictedIngress: {}, isServerFeatureEnabledForRequest: () => { consulted++; return true; }, process: { env: {} } };
  assert.equal(vm.runInNewContext(expression, sandbox), false);
  assert.equal(consulted, 0);
  sandbox.restrictedIngress = undefined;
  assert.equal(vm.runInNewContext(expression, sandbox), true);
  assert.equal(consulted, 1);
});
