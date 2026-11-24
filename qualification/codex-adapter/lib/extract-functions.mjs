import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Extracts a top-level function declaration with balanced parentheses and braces. */
export function extractFunction(source, name) {
  const pattern = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = pattern.exec(source);
  if (!match) throw new Error(`function ${name} not found`);
  const start = match.index;
  let parenDepth = 0;
  let paramsEnd = -1;
  for (let index = match.index + match[0].length - 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") parenDepth += 1;
    else if (char === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        paramsEnd = index;
        break;
      }
    }
  }
  if (paramsEnd < 0) throw new Error(`unbalanced parameters for ${name}`);
  const brace = source.indexOf("{", paramsEnd);
  if (brace < 0) throw new Error(`body not found for ${name}`);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

/** Extracts a single-line const declaration by name. */
export function extractConst(source, name) {
  const pattern = new RegExp(`const\\s+${name}\\s*=\\s*[^;]+;`);
  const match = pattern.exec(source);
  if (!match) throw new Error(`const ${name} not found`);
  return match[0];
}

/**
 * Writes extracted production functions to a temporary TypeScript module and
 * imports it through the pinned Node type stripper. This executes the selected
 * source logic without installing or rebuilding the Happier workspace.
 */
export async function buildFunctionModule({ directory, name, parts, exports }) {
  const path = join(directory, `${name}.ts`);
  const body = `${parts.join("\n\n")}\nexport { ${exports.join(", ")} };\n`;
  await writeFile(path, body, "utf8");
  return { path, module: await import(pathToFileURL(path).href), source: body };
}
