import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const serviceWorkerTemplate = readFileSync(new URL("./sw-template.js", import.meta.url), "utf8");

function appShellServiceWorker(): Plugin {
  return {
    name: "app-shell-service-worker",
    configureServer(server) {
      server.middlewares.use("/sw.js", (request, response, next) => {
        if (request.method !== "GET") {
          next();
          return;
        }
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(
          serviceWorkerTemplate
            .replace("__RAC_BUILD_ASSETS__", "[]")
            .replace("__RAC_CACHE_VERSION__", '"dev"'),
        );
      });
    },
    generateBundle(_options, bundle) {
      const assetFileNames = Object.keys(bundle)
        .filter((fileName) => /\.(?:js|css)$/.test(fileName))
        .sort();
      const buildAssets = assetFileNames.map((fileName) => `/${fileName}`);
      const cacheVersion = createHash("sha256")
        .update(assetFileNames.join("\n"))
        .update(bundle["index.html"]?.type === "asset" ? String(bundle["index.html"].source) : "")
        .update(readFileSync(new URL("./public/manifest.webmanifest", import.meta.url)))
        .digest("hex")
        .slice(0, 12);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: serviceWorkerTemplate
          .replace("__RAC_BUILD_ASSETS__", JSON.stringify(buildAssets))
          .replace("__RAC_CACHE_VERSION__", JSON.stringify(cacheVersion)),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), appShellServiceWorker()],
  preview: { proxy: {} },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:4318", changeOrigin: false },
    },
  },
});
