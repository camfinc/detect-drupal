#!/usr/bin/env node
/**
 * Ground-truth check against the real JavaScript of every downloaded core release.
 *
 *   bun run research && bun run build && node test/ground-truth.mjs
 *
 * For each release in .cache/releases it builds a happy-dom page, executes that
 * release's actual jQuery / once / drupal.js / misc/*.js in it, runs the *built*
 * dist/index.js detector, and asserts the reported range contains the release.
 *
 * Runs under Node rather than `bun test`: Bun's node:vm does not expose JS
 * builtins inside happy-dom's context, so real library code cannot execute there.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import vm from "node:vm";
import { Window } from "happy-dom";
import { detectDrupal } from "../dist/index.js";
import { detectDrupal as detectNoNetwork } from "../dist/passive.js";
const ROOT = join(import.meta.dirname, "..");
const FINGERPRINTS_RELEASES = JSON.parse(readFileSync(join(ROOT, "research", "markers.json"), "utf8")).releases.map((r) => r.version);
const CACHE = join(ROOT, ".cache", "releases");
const only = process.argv[2];
if (!existsSync(CACHE) || !existsSync(join(ROOT, "research", "markers.json"))) {
  console.error("No release cache found. Run `bun run research` first (downloads core releases into .cache/).");
  process.exit(1);
}

const cmp = (a, b) => FINGERPRINTS_RELEASES.indexOf(a) - FINGERPRINTS_RELEASES.indexOf(b);
const major = (v) => Number(v.split(".")[0]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

function firstExisting(dir, files) {
  return files.find((f) => existsSync(join(dir, f)));
}

function makePage(head = "", body = "") {
  const w = new Window({
    url: "https://example.com/node/1",
    // Never fetch <script src>/<link href> for real: files are injected via vm, and the
    // browser cache is simulated through window.fetch.
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: true },
  });
  w.document.write(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`);
  // happy-dom logs uncaught errors from timers etc.; keep output readable.
  w.console.error = w.console.warn = () => {};
  return w;
}

function run(w, dir, file) {
  vm.runInContext(readFileSync(join(dir, file), "utf8"), w, { filename: file });
}

/** Load bootstrap files (must succeed), then as many other misc files as will execute. */
function loadRuntime(w, dir, version, { full }) {
  const d8 = major(version) >= 8;
  const bootstrap = d8
    ? [
        firstExisting(dir, ["core/assets/vendor/jquery/jquery.min.js", "core/assets/vendor/jquery/jquery.js"]),
        firstExisting(dir, ["core/assets/vendor/once/once.min.js", "core/assets/vendor/once/once.js"]),
        firstExisting(dir, ["core/assets/vendor/jquery-once/jquery.once.js"]),
        "core/misc/drupalSettingsLoader.js",
        "core/misc/drupal.js",
        firstExisting(dir, ["core/misc/drupal.init.js"]),
      ]
    : ["misc/jquery.js", firstExisting(dir, ["misc/jquery.once.js"]), "misc/drupal.js"];
  // Early D8 wraps drupal.js in the `domready` vendor lib (not downloaded); stub it.
  vm.runInContext("window.domready = window.domready || function (fn) { fn(); };", w);
  for (const f of bootstrap.filter(Boolean)) run(w, dir, f);
  if (!full) return;
  const rest = walk(join(dir, d8 ? "core/misc" : "misc"))
    .map((p) => relative(dir, p))
    .filter((p) => p.endsWith(".js") && !bootstrap.includes(p) && !/(^|\/)(jquery[^/]*|ui\/.*|farbtastic.*)\.js$/.test(p))
    .sort();
  // Files depend on each other; retry failures a couple of passes.
  let pending = rest;
  for (let pass = 0; pass < 3 && pending.length; pass++) {
    const failed = [];
    for (const f of pending) {
      try {
        run(w, dir, f);
      } catch {
        failed.push(f);
      }
    }
    pending = failed;
  }
}

function settingsTag(version) {
  const settings = { path: { baseUrl: "/", currentPath: "node/1" }, pluralDelimiter: "\u0003" };
  return `<script type="application/json" data-drupal-selector="drupal-settings-json">${JSON.stringify(settings)}</script>`;
}

function contains(result, v) {
  const r = result.versionRange;
  if (!result.isDrupal || !r) return false;
  return cmp(r.min, v) <= 0 && (r.max === null || cmp(v, r.max) <= 0);
}

const versions = readdirSync(CACHE)
  .filter((v) => existsSync(join(CACHE, v, ".done")) && FINGERPRINTS_RELEASES.includes(v))
  .filter((v) => !only || v === only || v.startsWith(only + "."))
  .sort(cmp);

/**
 * Core files an ordinary unaggregated page loads: drupal.js/jQuery/once and the system (+ D6/D7
 * core module) CSS. D8+ JS is left out on purpose: its ?v= query already gives the exact version,
 * and scenario H is about what the browser cache adds.
 */
function loadedFiles(dir, version) {
  const d8 = major(version) >= 8;
  const pick = (re, root) => walk(join(dir, root)).map((p) => relative(dir, p)).filter((p) => re.test(p));
  return d8
    ? pick(/^core\/modules\/system\/css\/components\/[\w.-]+\.css$/, "core/modules/system/css")
    : [
        ...["misc/drupal.js", "misc/jquery.js", "misc/jquery.once.js"].filter((f) => existsSync(join(dir, f))),
        ...pick(/^modules\/(system|node|user|field)\/(theme\/)?[\w.-]+\.css$/, "modules").filter((p) => !/admin|rtl|maintenance|install/.test(p)),
      ];
}

/** window.fetch for a page whose loaded files are in the HTTP cache; any non-cache read is a test failure. */
function browserCacheFetch(dir, loaded, violations) {
  return async (url, init) => {
    if (init?.cache !== "only-if-cached") {
      violations.push(url);
      throw new Error("network request from a cache read");
    }
    const path = new URL(url).pathname.slice(1);
    if (!loaded.includes(path)) return new Response("", { status: 504 });
    return new Response(readFileSync(join(dir, path), "utf8"), { status: 200 });
  };
}

/** A fake site that serves one release's files, so active probing can be checked offline. */
function siteFetch(dir, log) {
  return async (url) => {
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ""));
    log.push(path);
    const file = join(dir, path);
    if (!path || !existsSync(file) || statSync(file).isDirectory()) return new Response("Not found", { status: 404 });
    return new Response(readFileSync(file, "utf8"), { status: 200, headers: { "content-type": "text/plain" } });
  };
}

const failures = [];
const hWidth7 = [];
const width = { A: [], B: [], C: [], D: [], E: [], F: [], G: [], H: [] };
const requests = { E: [], F: [], G: [] };
const samples = [];
for (const version of versions) {
  const dir = join(CACHE, version);
  const d8 = major(version) >= 8;
  const check = (label, result, { exact } = {}) => {
    if (requests[label]) requests[label].push(result.requests);
    const ok = exact ? result.version === version : contains(result, version);
    if (!ok) failures.push({ version, label, result });
    if (result.versionRange) {
      // Open-ended ("or newer"): measure up to the newest known release of that major.
      const lastOfMajor = FINGERPRINTS_RELEASES.filter((x) => major(x) === major(result.versionRange.min)).at(-1);
      const hi = result.versionRange.max ?? lastOfMajor;
      width[label].push(cmp(hi, result.versionRange.min) + 1);
    }
    return result;
  };

  // A: full runtime, no asset URLs in HTML (pure JS fingerprinting).
  let w = makePage(d8 ? settingsTag(version) : "");
  loadRuntime(w, dir, version, { full: true });
  const a = check("A", detectDrupal({ window: w, document: w.document }));
  w.close();

  // B: minimal runtime (only the always-loaded bootstrap).
  w = makePage(d8 ? settingsTag(version) : "");
  loadRuntime(w, dir, version, { full: false });
  check("B", detectDrupal({ window: w, document: w.document }));
  // F: same page, depth "light" (<= 2 requests).
  check("F", await detectDrupal({ window: w, document: w.document, depth: "light", baseUrl: "https://site.test/", fetch: siteFetch(dir, []) }));
  w.close();

  // E: no page at all (Node usage), depth "deep", fingerprinting purely from fetched files.
  const e = check("E", await detectDrupal({ depth: "deep", baseUrl: "https://site.test/", fetch: siteFetch(dir, []) }));
  if (!e.isDrupal) failures.push({ version, label: "E-isDrupal", result: e });

  // G: HTML-only page (no JS ran), depth "standard".
  w = makePage(d8 ? settingsTag(version) + `<meta name="Generator" content="Drupal ${major(version)} (https://www.drupal.org)">` : `<script src="/misc/drupal.js?x"></script>`);
  check("G", await detectDrupal({ window: w, document: w.document, depth: "standard", baseUrl: "https://site.test/", fetch: siteFetch(dir, []) }));
  w.close();

  if (d8) {
    // C: HTML only, unaggregated core assets carry ?v=VERSION.
    w = makePage(
      settingsTag(version) +
        `<script src="/core/misc/drupal.js?v=${version}"></script>` +
        `<script src="/core/assets/vendor/jquery/jquery.min.js?v=3.7.1"></script>`,
    );
    check("C", detectDrupal({ window: w, document: w.document }), { exact: true });
    w.close();
  } else {
    // D: HTML only for D6/D7.
    const meta = major(version) === 7 ? `<meta name="Generator" content="Drupal 7 (http://drupal.org)">` : "";
    w = makePage(meta + `<script src="/misc/drupal.js?q1w2e3"></script>`);
    const d = check("D", detectDrupal({ window: w, document: w.document }));
    // Without the generator tag (D6 has none), paths alone cannot split 6 from 7.
    if (meta && d.major !== major(version)) failures.push({ version, label: "D-major", result: d });
    w.close();
  }

  // H: unaggregated page, depth "cached": re-read already-loaded core files from the browser
  // cache. Zero network requests, for both the full and the no-network build.
  const loaded = loadedFiles(dir, version);
  const query = d8 ? "t=sx2k1q" : "qz8m1p";
  const tags = loaded.map((f) => (f.endsWith(".css") ? `<link rel="stylesheet" href="/${f}?${query}">` : `<script src="/${f}?${query}"></script>`)).join("");
  const violations = [];
  let h;
  for (const detect of [detectDrupal, detectNoNetwork]) {
    w = makePage((d8 ? settingsTag(version) : "") + tags);
    w.fetch = browserCacheFetch(dir, loaded, violations);
    h = check("H", await detect({ window: w, document: w.document, depth: "cached" }));
    if (h.requests !== 0) failures.push({ version, label: "H-requests", result: h });
    w.close();
  }
  if (violations.length) failures.push({ version, label: "H-network", result: { evidence: violations, versionRange: null } });
  if (!d8) hWidth7.push([version, width.D.at(-1), width.H.at(-1)]);

  if (/^(\d+\.\d+\.0|10\.[3-6]\.[1-9]\d*|6\.38|7\.(0|50|103))$/.test(version) && (/\.0$/.test(version) || /^10\.[3-6]\.(4|8)$/.test(version) || !d8)) {
    samples.push([version, a.version, a.versionRange, e.version, e.versionRange, e.requests]);
  }
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
console.log(`Checked ${versions.length} releases.`);
for (const [k, xs] of Object.entries(width)) {
  if (!xs.length) continue;
  const req = requests[k] ? `, median requests ${median(requests[k])}, max ${Math.max(...requests[k])}` : "";
  console.log(`  scenario ${k}: median candidate releases ${median(xs)}, worst ${Math.max(...xs)} (n=${xs.length}${req})`);
}
if (hWidth7.length) {
  const med = (i) => median(hWidth7.map((x) => x[i]));
  console.log(`  Drupal 6/7 HTML-only: median ${med(1)} candidates passive -> ${med(2)} with depth "cached" (0 requests)`);
}
const fmt = (r) => (r ? `${r.min} … ${r.max ?? "newer"}` : "-");
console.log("\nSamples: release | passive (full JS) | deep scan, no page");
for (const [v, got, r, ev, er, n] of samples) {
  console.log(`  ${v.padEnd(9)} | ${String(got).padEnd(7)} ${fmt(r).padEnd(22)} | ${String(ev).padEnd(8)} ${fmt(er).padEnd(22)} ${n} req`);
}

if (failures.length) {
  console.error(`\n${failures.length} FAILURES`);
  for (const f of failures.slice(0, 25)) {
    console.error(`  ${f.version} [${f.label}] -> ${JSON.stringify({ v: f.result.version, r: f.result.versionRange, ev: f.result.evidence })}`);
  }
  process.exit(1);
}
console.log("\nAll ground-truth checks passed.");
