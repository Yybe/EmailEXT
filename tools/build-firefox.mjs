#!/usr/bin/env node
// Builds a Firefox-ready package in dist/firefox/ from the Chrome root manifest.
// Chrome rejects `background.scripts` inside MV3 manifests, so Firefox-only keys
// are injected here instead of living in the shared manifest.
// Usage: node tools/build-firefox.mjs

import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const RUNTIME_FILES = [
  "background.js",
  "content.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "dashboard.html",
  "dashboard.css",
  "dashboard.js",
  "styles.css",
  "mark.svg"
];

const ICON_SIZES = [16, 48, 128];
const GECKO_ID = "identity-recall@yybe.dev";
const GECKO_MIN_VERSION = "140.0";

const outDir = path.join(root, "dist", "firefox");
await mkdir(path.join(outDir, "icons"), { recursive: true });

for (const file of RUNTIME_FILES) {
  await cp(path.join(root, file), path.join(outDir, file));
}
for (const size of ICON_SIZES) {
  await cp(path.join(root, "icons", `icon${size}.png`), path.join(outDir, "icons", `icon${size}.png`));
}

const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
manifest.background = { scripts: ["background.js"] };
manifest.browser_specific_settings = {
  gecko: {
    id: GECKO_ID,
    strict_min_version: GECKO_MIN_VERSION,
    data_collection_permissions: {
      required: ["none"]
    }
  }
};

await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Firefox build written to ${outDir}`);
