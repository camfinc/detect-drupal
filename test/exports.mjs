#!/usr/bin/env node
// Smoke-test every published entry point of the *built* package under Node.
// Guards against bundler output that parses but fails to link (e.g. dangling export names).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const resolve = (sub, cond) => {
  const e = pkg.exports[sub];
  return new URL("../" + (typeof e === "string" ? e : e[cond].default), import.meta.url);
};

const esm = await import(resolve(".", "import"));
assert.equal(typeof esm.detectDrupal, "function");
assert.equal(esm.default, esm.detectDrupal);
assert.equal(typeof esm.register, "function");
assert.equal(esm.detectDrupal({ window: {} }).isDrupal, false);

const cjs = require(resolve(".", "require").pathname);
assert.equal(typeof cjs.detectDrupal, "function");
assert.equal(cjs.default, cjs.detectDrupal);

const g = await import(resolve("./global", "import"));
assert.equal(globalThis.detectDrupal, g.detectDrupal);
delete globalThis.detectDrupal;
require(resolve("./global", "require").pathname);
assert.equal(typeof globalThis.detectDrupal, "function");
delete globalThis.detectDrupal;

// Classic <script>: run in a fresh context, as a browser would.
// Only the platform globals every browser has (the bundle must not rely on anything else).
const ctx = vm.createContext({ URL, AbortController, setTimeout, clearTimeout });
vm.runInContext(readFileSync(resolve("./classic"), "utf8"), ctx);
assert.equal(typeof ctx.detectDrupal, "function");
assert.equal(ctx.detectDrupal().isDrupal, false);

// Active depth through the classic build: returns a Promise, uses the supplied fetch.
const seen = [];
const pending = ctx.detectDrupal({ depth: "light", baseUrl: "https://site.test/", fetch: async (u) => (seen.push(u), new Response("", { status: 404 })) });
assert.equal(typeof pending.then, "function");
const active = await pending;
assert.equal(active.requests, seen.length);
assert.ok(active.requests > 0 && active.requests <= 2);

console.log("All entry points OK:", Object.keys(pkg.exports).join(", "));
