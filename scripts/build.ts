#!/usr/bin/env bun
/**
 * Builds:
 *   dist/index.js / index.cjs        ESM + CommonJS (no side effects)
 *   dist/global.js / global.cjs      ESM + CommonJS that also register `globalThis.detectDrupal`
 *   dist/detect-drupal.js / .min.js  classic <script> (IIFE) that registers `window.detectDrupal`
 *   dist/*.d.ts / *.d.cts            type declarations
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const pkg = await Bun.file(join(ROOT, "package.json")).json();
const banner = `/*! ${pkg.name} v${pkg.version} | ${pkg.license} */`;

rmSync(DIST, { recursive: true, force: true });

async function build(opts: Parameters<typeof Bun.build>[0]) {
  const res = await Bun.build({ target: "browser", banner, ...opts });
  if (!res.success) {
    for (const log of res.logs) console.error(log);
    process.exit(1);
  }
  for (const o of res.outputs) console.log(`  ${o.path.replace(ROOT + "/", "")}  ${(o.size / 1024).toFixed(1)} kB`);
}

// One entry per build: multi-entry builds share chunks, which we do not want here.
for (const name of ["index", "global"]) {
  const entrypoints = [join(ROOT, `src/${name}.ts`)];
  await build({ entrypoints, outdir: DIST, format: "esm", naming: `${name}.js` });
  await build({ entrypoints, outdir: DIST, format: "cjs", naming: `${name}.cjs` });
}
for (const minify of [false, true]) {
  await build({
    entrypoints: [join(ROOT, "src/classic.ts")],
    outdir: DIST,
    format: "iife",
    minify,
    naming: minify ? "detect-drupal.min.js" : "detect-drupal.js",
  });
}

// Declarations: emit with tsc, then flatten into self-contained files so the
// .d.ts (ESM) and .d.cts (CJS) twins never import each other across module kinds.
const TYPES = join(ROOT, ".cache", "types");
rmSync(TYPES, { recursive: true, force: true });
const tsc = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.build.json", "--outDir", TYPES], {
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
if (tsc.exitCode !== 0) process.exit(tsc.exitCode ?? 1);
const strip = (f: string) =>
  readFileSync(join(TYPES, f), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export \{\};\n?/gm, "")
    .replace(/^\/\/# sourceMappingURL.*$/gm, "")
    .trim();
const core = ["types.d.ts", "detect.d.ts"].map(strip).join("\n\n");
const decls: Record<string, string> = {
  index: `${core}\n\n${strip("register.d.ts")}\n\nexport default detectDrupal;\n`,
  global: `${core}\n\nexport default detectDrupal;\n\ntype DetectDrupalFn = typeof detectDrupal;\n\ndeclare global {\n  var detectDrupal: DetectDrupalFn;\n}\n`,
};
for (const [name, body] of Object.entries(decls)) {
  for (const ext of [".d.ts", ".d.cts"]) writeFileSync(join(DIST, name + ext), `${banner}\n${body}`);
}
console.log("build ok");
