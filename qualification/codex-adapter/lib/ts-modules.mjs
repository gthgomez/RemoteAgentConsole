import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Resolver for running selected Happier TypeScript modules directly with the
 * pinned Node type stripper. Only build-time aliases are redirected:
 * `.js` specifiers to sibling `.ts` files, and the two runtime dependencies to
 * the pinned reference-archive copies. No package is installed.
 */
export function installSourceHooks({ depsDir }) {
  const protocolIndex = join(
    depsDir,
    "node_modules",
    "@happier-dev",
    "protocol",
    "dist",
    "index.js",
  );
  const zodIndex = join(depsDir, "node_modules", "zod", "index.js");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@happier-dev/protocol") {
        return { url: pathToFileURL(protocolIndex).href, shortCircuit: true };
      }
      if (specifier.startsWith("@happier-dev/protocol/")) {
        const subpath = specifier.slice("@happier-dev/protocol/".length);
        return {
          url: pathToFileURL(
            join(depsDir, "node_modules", "@happier-dev", "protocol", "dist", `${subpath}.js`),
          ).href,
          shortCircuit: true,
        };
      }
      if (specifier === "zod") {
        return { url: pathToFileURL(zodIndex).href, shortCircuit: true };
      }
      if (specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
        const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

export async function importCapabilityModule(sourceRoot) {
  const modulePath = pathToFileURL(
    join(sourceRoot, "packages", "agents", "src", "sessionControls", "sessionCapabilities.ts"),
  ).href;
  return import(modulePath);
}
