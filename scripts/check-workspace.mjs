import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

for (const script of ["verify", "dev", "build"]) {
  if (
    typeof packageJson.scripts?.[script] !== "string" ||
    packageJson.scripts[script].length === 0
  ) {
    throw new Error(`package.json must define a non-empty "${script}" script`);
  }
}

const nodeRange = packageJson.engines?.node;
if (nodeRange !== ">=22 <25") {
  throw new Error('package.json engines.node must declare the supported range ">=22 <25"');
}
if (!readme.includes("Node.js 22 through 24")) {
  throw new Error("README.md must document support for Node.js 22 through 24");
}

console.log("Workspace scripts and supported Node range are documented.");
