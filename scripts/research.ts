#!/usr/bin/env bun
/**
 * Fingerprint research pipeline.
 *
 *   bun run research            # download (cached) + analyze + write fingerprints
 *   bun run research --offline  # analyze only what is already in .cache/
 *
 * 1. Reads the official release history feeds from updates.drupal.org.
 * 2. Streams every stable core tarball (plus the newest pre-release of a major
 *    that has no stable yet) through `tar`, keeping only the public JS and the
 *    few PHP files that decide what ends up in the page.
 * 3. Extracts runtime-observable markers from each release (Drupal.* API
 *    surface, jQuery plugins, globals, shipped jQuery version, library names).
 * 4. Writes:
 *      src/fingerprints.generated.ts   compact data imported by the detector
 *      research/markers.json           full marker -> releases table
 *      research/REPORT.md              human-readable summary
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { assetHash } from "../src/hash";

const ROOT = join(import.meta.dir, "..");
const CACHE = join(ROOT, ".cache", "releases");
const FEEDS = ["6.x", "7.x", "current"];
const OFFLINE = process.argv.includes("--offline");
const CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export type Ver = { raw: string; parts: number[]; pre: string | null };

export function parseVersion(raw: string): Ver {
  const [main, pre = null] = raw.split("-", 2) as [string, string | undefined];
  return { raw, parts: main.split(".").map(Number), pre: pre ?? null };
}

export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < Math.max(va.parts.length, vb.parts.length); i++) {
    const d = (va.parts[i] ?? 0) - (vb.parts[i] ?? 0);
    if (d) return d;
  }
  if (va.pre === vb.pre) return 0;
  if (va.pre === null) return 1;
  if (vb.pre === null) return -1;
  return va.pre < vb.pre ? -1 : 1;
}

type Release = { version: string; url: string; date: number };

async function fetchReleases(): Promise<Release[]> {
  const all: Release[] = [];
  for (const feed of FEEDS) {
    const xml = await (await fetch(`https://updates.drupal.org/release-history/drupal/${feed}`)).text();
    for (const m of xml.matchAll(/<release>([\s\S]*?)<\/release>/g)) {
      const body = m[1]!;
      const version = /<version>([^<]+)<\/version>/.exec(body)?.[1];
      const status = /<status>([^<]+)<\/status>/.exec(body)?.[1];
      const url = /<download_link>([^<]+\.tar\.gz)<\/download_link>/.exec(body)?.[1];
      const date = Number(/<date>(\d+)<\/date>/.exec(body)?.[1] ?? 0);
      if (!version || !url || status !== "published") continue;
      if (!/^\d+\.\d+(\.\d+)?(-(alpha|beta|rc)\d+)?$/.test(version)) continue;
      all.push({ version, url, date });
    }
  }
  const byVersion = new Map(all.map((r) => [r.version, r]));
  const stable = [...byVersion.values()].filter((r) => !r.version.includes("-"));
  const stableMajors = new Set(stable.map((r) => parseVersion(r.version).parts[0]));
  // Newest pre-release of each major that has no stable release yet.
  const preByMajor = new Map<number, Release>();
  for (const r of byVersion.values()) {
    if (!r.version.includes("-")) continue;
    const major = parseVersion(r.version).parts[0]!;
    if (stableMajors.has(major)) continue;
    const cur = preByMajor.get(major);
    if (!cur || compareVersions(r.version, cur.version) > 0) preByMajor.set(major, r);
  }
  return [...stable, ...preByMajor.values()].sort((a, b) => compareVersions(a.version, b.version));
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

const TAR_INCLUDES = [
  "*/misc/*.js",
  "*/core/assets/vendor/jquery/jquery.js",
  "*/core/assets/vendor/jquery/jquery.min.js",
  "*/core/assets/vendor/once/once.js",
  "*/core/assets/vendor/once/once.min.js",
  "*/core/assets/vendor/jquery-once/jquery.once.js",
  "*/core/core.libraries.yml",
  "*/core/lib/Drupal.php",
  "*/includes/bootstrap.inc",
  "*/includes/common.inc",
  "*/modules/system/system.module",
  "*/core/lib/Drupal/Core/Asset/*.php",
  "*/core/lib/Drupal/Core/Render/HtmlResponseAttachmentsProcessor.php",
  "*/core/lib/Drupal/Core/Render/BareHtmlPageRenderer.php",
  "*/core/themes/*/*.info.yml",
  "*/themes/*/*.info",
  // Public static assets, hashed for active (fetch) probing.
  "*/misc/*.css",
  "*/core/modules/*/js/*",
  "*/core/modules/*/css/*",
  "*/core/themes/*/js/*",
  "*/core/themes/*/css/*",
  "*/modules/*.js",
  "*/modules/*.css",
  "*/themes/*.js",
  "*/themes/*.css",
];
/** Bump when TAR_INCLUDES changes so cached extractions are refreshed. */
const EXTRACT_VERSION = "2";

/**
 * The --include filters are libarchive (bsdtar) syntax. macOS `tar` is bsdtar; on Linux
 * install it (Debian/Ubuntu: `apt-get install libarchive-tools`), GNU tar won't do.
 */
function bsdtar(): string {
  for (const bin of ["bsdtar", "tar"]) {
    const path = Bun.which(bin);
    if (!path) continue;
    const v = Bun.spawnSync([path, "--version"]).stdout.toString();
    if (v.includes("bsdtar")) return path;
  }
  throw new Error("bsdtar (libarchive) is required: macOS has it as `tar`; on Debian/Ubuntu run `apt-get install libarchive-tools`.");
}
const TAR = OFFLINE ? "" : bsdtar();

async function download(r: Release): Promise<void> {
  const dir = join(CACHE, r.version);
  if (existsSync(join(dir, ".done")) && readFileSync(join(dir, ".done"), "utf8").startsWith(`v${EXTRACT_VERSION} `)) return;
  // Start clean so files from an older extraction format never linger.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const args = TAR_INCLUDES.flatMap((p) => ["--include", p]);
  // bsdtar exits non-zero when an --include pattern matches nothing (D6/D7 have no
  // core/ dir), so only curl's status matters; success = drupal.js was extracted.
  const cmd = `set -o pipefail; curl -fsSL '${r.url}' | { '${TAR}' -xz -C '${dir}' --strip-components 1 --exclude '*.es6.js' --exclude '*/tests/*' --exclude '*.map' --exclude '*.pcss.css' --exclude '*/node_modules/*' ${args
    .map((a) => `'${a}'`)
    .join(" ")} 2>/dev/null; true; }`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const p = Bun.spawn(["bash", "-c", cmd], { stderr: "pipe" });
    const ok = (await p.exited) === 0;
    // Drupal 12+ tarballs ship a Composer-style `web/` docroot.
    if (ok && existsSync(join(dir, "web/core"))) {
      Bun.spawnSync(["sh", "-c", `cp -R '${dir}/web/.' '${dir}/' && rm -rf '${dir}/web'`]);
    }
    if (ok && (existsSync(join(dir, "misc/drupal.js")) || existsSync(join(dir, "core/misc/drupal.js")))) {
      writeFileSync(join(dir, ".done"), `v${EXTRACT_VERSION} ${r.url}`);
      return;
    }
    const err = await new Response(p.stderr).text();
    console.warn(`  retry ${attempt} ${r.version}: ${err.trim()}`);
  }
  throw new Error(`download failed: ${r.version}`);
}

async function downloadAll(releases: Release[]): Promise<void> {
  let i = 0;
  let done = 0;
  const worker = async () => {
    while (i < releases.length) {
      const r = releases[i++]!;
      await download(r);
      if (++done % 25 === 0) console.log(`  downloaded ${done}/${releases.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function read(dir: string, rel: string): string | null {
  const p = join(dir, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Strip comments so doc examples like `Drupal.foo = ...` in JSDoc are ignored. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\'"])\/\/.*$/gm, "$1");
}

type Analysis = {
  version: string;
  declaredVersion: string | null;
  jquery: string | null;
  /** marker -> file (relative) that defines it */
  markers: Map<string, string>;
  libraries: string[];
  themes: string[];
  facts: Record<string, boolean>;
};

const NON_DISCRIMINATING =
  /^(jQuery\.fn\.(init|extend|html|position|jquery|ready|load|attr|prop|val|each)|window\.(Drupal|drupalSettings|drupalTranslations|CustomEvent|Modernizr|Promise|Symbol|matchMedia|jQuery|\$)|Drupal\.theme\.prototype)$/;

const ALWAYS_LOADED_FILES = new Set([
  // Loaded whenever window.Drupal exists at all.
  "misc/drupal.js",
  "core/misc/drupal.js",
]);

function analyze(version: string): Analysis {
  const dir = join(CACHE, version);
  const markers = new Map<string, string>();
  const add = (m: string, file: string) => {
    if (!markers.has(m) || ALWAYS_LOADED_FILES.has(file)) markers.set(m, file);
  };

  const jsFiles = walk(dir)
    .map((p) => relative(dir, p))
    .filter(
      (p) =>
        (/^(core\/)?misc\/.+\.js$/.test(p) || p === "core/assets/vendor/jquery-once/jquery.once.js") &&
        !p.endsWith(".es6.js"),
    );

  for (const file of jsFiles) {
    // Vendor libraries shipped in D6/D7 misc/ (jquery, jquery.ui, farbtastic...) are
    // not Drupal API surface; the jQuery version is captured separately.
    if (/(^|\/)(jquery(\.min)?\.js|jquery\.(form|cookie|ba-bbq)\.js|ui\/|farbtastic)/.test(file)) continue;
    const src = stripComments(readFileSync(join(dir, file), "utf8"));

    // Drupal.foo = / Drupal.foo.bar = (first two levels only; deeper is noise)
    for (const m of src.matchAll(/(?<![\w$.])Drupal((?:\.[A-Za-z_$][\w$]*){1,2})\s*=(?!=)/g)) {
      const chain = m[1]!.split(".").filter(Boolean);
      if (chain[0] === "behaviors" && chain[1]) add(`Drupal.behaviors.${chain[1]}`, file);
      else if (chain[0] === "theme" && chain[1] === "prototype") continue;
      else add(`Drupal.${chain[0]}`, file);
    }
    // Drupal.theme.foo = / Drupal.theme.prototype.foo =
    for (const m of src.matchAll(/(?<![\w$.])Drupal\.theme(?:\.prototype)?\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
      if (m[1] !== "prototype") add(`Drupal.theme.${m[1]}`, file);
    }
    // Drupal.theme.prototype = { placeholder: function … } (D6/D7)
    for (const m of src.matchAll(/Drupal\.theme\.prototype\s*=\s*\{([\s\S]*?)\n\};/g)) {
      for (const k of m[1]!.matchAll(/^\s{2}['"]?([A-Za-z_$][\w$]*)['"]?\s*:/gm)) add(`Drupal.theme.${k[1]}`, file);
    }
    // Object-literal members of the bootstrap object: `Drupal = { settings: {}, behaviors: {} }`
    for (const m of src.matchAll(/(?:var\s+Drupal|window\.Drupal)\s*=\s*(?:Drupal\s*\|\|\s*)?\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
      for (const k of m[1]!.matchAll(/['"]?([A-Za-z_$][\w$]*)['"]?\s*:/g)) add(`Drupal.${k[1]}`, file);
    }
    // $.extend(Drupal, { ... }) / Object.assign(Drupal, {...}) top-level keys
    for (const m of src.matchAll(/(?:\$|jQuery)\.extend\(\s*Drupal\s*,\s*\{([\s\S]*?)\n\s*\}\s*\)/g)) {
      for (const k of m[1]!.matchAll(/^\s{2,4}['"]?([A-Za-z_$][\w$]*)['"]?\s*:/gm)) add(`Drupal.${k[1]}`, file);
    }
    // jQuery plugins
    for (const m of src.matchAll(/(?<![\w$.])(?:\$|jQuery)\.fn\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
      add(`jQuery.fn.${m[1]}`, file);
    }
    // $.fn.extend({ a: ..., b: ... })
    for (const m of src.matchAll(/(?:\$|jQuery)\.fn\.extend\(\s*\{([\s\S]*?)\n\s*\}\s*\)/g)) {
      for (const k of m[1]!.matchAll(/^\s{2,6}['"]?([A-Za-z_$][\w$]*)['"]?\s*:/gm)) add(`jQuery.fn.${k[1]}`, file);
    }
    // Page globals
    for (const m of src.matchAll(/(?<![\w$.])window\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) add(`window.${m[1]}`, file);
  }

  // Names that exist on non-Drupal pages too (native jQuery methods that core
  // patches, browser globals that core polyfills, or globals handled structurally
  // by the detector) say nothing about the version when present.
  for (const m of [...markers.keys()]) if (NON_DISCRIMINATING.test(m)) markers.delete(m);

  // Vendor globals.
  if (read(dir, "core/assets/vendor/once/once.js") || read(dir, "core/assets/vendor/once/once.min.js")) {
    add("window.once", "core/assets/vendor/once/once.js");
  }
  if (read(dir, "core/assets/vendor/jquery-once/jquery.once.js")) add("jQuery.fn.once", "core/assets/vendor/jquery-once/jquery.once.js");
  if (read(dir, "misc/jquery.once.js")) add("jQuery.fn.once", "misc/jquery.once.js");

  const jqSrc =
    read(dir, "core/assets/vendor/jquery/jquery.js") ??
    read(dir, "core/assets/vendor/jquery/jquery.min.js") ??
    read(dir, "misc/jquery.js");
  const jquery =
    jqSrc?.match(/jQuery(?: JavaScript Library)? v?(\d+\.\d+(?:\.\d+)?(?:[-.\w]*)?)/)?.[1] ??
    jqSrc?.match(/jquery:\s*["'](\d+\.\d+(?:\.\d+)?)["']/)?.[1] ??
    null;

  const drupalPhp = read(dir, "core/lib/Drupal.php");
  const bootstrap = read(dir, "includes/bootstrap.inc");
  const declaredVersion =
    drupalPhp?.match(/const VERSION = '([^']+)'/)?.[1] ??
    bootstrap?.match(/define\('VERSION', '([^']+)'\)/)?.[1] ??
    null;

  const libsYml = read(dir, "core/core.libraries.yml") ?? "";
  const libraries = [...libsYml.matchAll(/^([a-z][\w.-]*):\s*$/gm)].map((m) => `core/${m[1]}`);

  const themes = walk(join(dir, "core/themes"))
    .concat(walk(join(dir, "themes")))
    .map((p) => /\/([\w]+)\.info(\.yml)?$/.exec(p)?.[1])
    .filter((t): t is string => !!t && t !== "twig" && !/test/.test(t));

  const assetPhp = walk(join(dir, "core/lib/Drupal/Core/Asset"))
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  const attachPhp = read(dir, "core/lib/Drupal/Core/Render/HtmlResponseAttachmentsProcessor.php") ?? "";
  const systemModule =
    (read(dir, "core/modules/system/system.module") ?? read(dir, "modules/system/system.module") ?? "") +
    (read(dir, "includes/common.inc") ?? "") +
    // 11.1+: system's page-attachments hook delegates to BareHtmlPageRenderer.
    (read(dir, "core/lib/Drupal/Core/Render/BareHtmlPageRenderer.php") ?? "");
  const drupalJs = read(dir, "core/misc/drupal.js") ?? read(dir, "misc/drupal.js") ?? "";

  const facts: Record<string, boolean> = {
    // `?v=VERSION` appended to unaggregated JS whose library declares a version.
    jsVersionQueryString: /'v='\s*\.\s*\$js_asset\['version'\]|'v=' \. \$js_asset/.test(assetPhp),
    // Core libraries declare `version: VERSION`.
    coreLibrariesVersionConstant: /version:\s*VERSION/.test(libsYml),
    // <script type="application/json" data-drupal-selector="drupal-settings-json">
    settingsJsonScriptTag: /drupal-settings-json/.test(assetPhp + attachPhp),
    // Lazy (on-demand) aggregation with include= query in aggregate URLs.
    aggregateIncludeQuery: /'include'\s*=>/.test(assetPhp),
    // ajaxPageState.libraries compressed with UrlHelper::compressQueryParameter.
    compressedAjaxPageStateLibraries: /compressQueryParameter/.test(assetPhp + attachPhp),
    // <meta name="Generator" content="Drupal N (...)"> on regular pages.
    generatorMeta: /['"]Generator['"]/.test(systemModule),
    // D6 behaviours are plain functions; D7+ are {attach, detach} objects.
    behaviorsAttachObjects: /\.attach\b/.test(drupalJs),
    drupalJsEnabled: /Drupal\.jsEnabled/.test(stripComments(drupalJs)),
  };

  return { version, declaredVersion, jquery, markers, libraries, themes, facts };
}

// ---------------------------------------------------------------------------
// Active probes: content hashes of public static files
// ---------------------------------------------------------------------------

/** Files a site serves as-is at <base>/<path> (core JS/CSS), as opposed to PHP or config. */
const PUBLIC_ASSET =
  /^(?:core\/(?:misc|modules\/\w+\/(?:js|css)|themes\/\w+\/(?:js|css))\/|misc\/|modules\/|themes\/)[\w./-]+\.(?:js|css)$/;
const MAX_PROBES = 48;

function assetHashes(version: string): Map<string, string> {
  const dir = join(CACHE, version);
  const out = new Map<string, string>();
  for (const p of walk(dir)) {
    const rel = relative(dir, p);
    if (PUBLIC_ASSET.test(rel) && !/(^|\/)tests?\//.test(rel)) out.set(rel, assetHash(readFileSync(p, "utf8")));
  }
  return out;
}

/**
 * Greedily choose the files whose hashes, together, split the releases into the most groups.
 * Runtime probing then picks among these adaptively for the candidates left on a given page.
 */
function chooseProbes(perRelease: Map<string, string>[]) {
  const n = perRelease.length;
  const paths = new Set<string>();
  perRelease.forEach((m) => m.forEach((_, k) => paths.add(k)));
  const ids = new Map<string, Int32Array>();
  for (const path of paths) {
    const seen = new Map<string, number>();
    const arr = new Int32Array(n);
    perRelease.forEach((m, i) => {
      const h = m.get(path);
      if (h !== undefined) arr[i] = seen.get(h) ?? seen.set(h, seen.size + 1).get(h)!;
    });
    if (seen.size > 1 || arr.some((x) => x === 0)) ids.set(path, arr);
  }
  let group = new Int32Array(n);
  let groups = 1;
  const chosen: { path: string; groups: number }[] = [];
  while (chosen.length < MAX_PROBES) {
    let best: string | null = null;
    let bestCount = groups;
    for (const [path, arr] of ids) {
      const keys = new Set<number>();
      for (let i = 0; i < n; i++) keys.add(group[i]! * 4096 + arr[i]!);
      if (keys.size > bestCount || (keys.size === bestCount && best !== null && path < best && keys.size > groups)) {
        bestCount = keys.size;
        best = path;
      }
    }
    if (!best) break;
    const arr = ids.get(best)!;
    const remap = new Map<number, number>();
    const next = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const k = group[i]! * 4096 + arr[i]!;
      next[i] = remap.get(k) ?? remap.set(k, remap.size).get(k)!;
    }
    group = next;
    groups = remap.size;
    ids.delete(best);
    chosen.push({ path: best, groups });
  }
  return { chosen: chosen.map((c) => c.path), steps: chosen, groups: group };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Contiguous runs of indices -> [start, end] pairs. */
function runs(indices: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const i of indices) {
    const last = out[out.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else out.push([i, i]);
  }
  return out;
}

async function main() {
  let releases: Release[];
  if (OFFLINE) {
    releases = readdirSync(CACHE)
      .filter((v) => existsSync(join(CACHE, v, ".done")))
      .sort(compareVersions)
      .map((version) => ({ version, url: "", date: 0 }));
  } else {
    console.log("Fetching release history…");
    releases = await fetchReleases();
    console.log(`  ${releases.length} releases (${releases[0]!.version} … ${releases.at(-1)!.version})`);
    console.log("Downloading (cached in .cache/releases)…");
    await downloadAll(releases);
  }

  console.log("Analyzing…");
  const analyses = releases.map((r) => analyze(r.version));
  const versions = analyses.map((a) => a.version);

  const mismatched = analyses.filter((a) => a.declaredVersion && a.declaredVersion !== a.version);
  for (const a of mismatched) console.warn(`  note: ${a.version} declares VERSION=${a.declaredVersion}`);

  // marker -> indices of releases that define it, and the files it came from.
  const markerIdx = new Map<string, number[]>();
  const markerFiles = new Map<string, Set<string>>();
  analyses.forEach((a, i) => {
    for (const [m, file] of a.markers) {
      (markerIdx.get(m) ?? markerIdx.set(m, []).get(m)!).push(i);
      (markerFiles.get(m) ?? markerFiles.set(m, new Set()).get(m)!).add(file);
    }
  });

  // Markers that are present in every release carry no version information.
  // Markers defined in always-loaded files are usable as absence evidence too.
  const markers = [...markerIdx.entries()]
    .filter(([, idx]) => idx.length < versions.length)
    .map(([name, idx]) => {
      const files = [...markerFiles.get(name)!];
      return {
        name,
        files,
        alwaysLoaded: files.every((f) => ALWAYS_LOADED_FILES.has(f)),
        ranges: runs(idx).map(([s, e]) => [versions[s]!, versions[e]!] as [string, string]),
      };
    })
    .sort((a, b) => compareVersions(a.ranges[0]![0], b.ranges[0]![0]) || a.name.localeCompare(b.name));

  // Keep the detector payload focused: markers in always-loaded files, plus
  // markers from other files whose presence narrows the range meaningfully
  // (i.e. they are not present in every release of every D8+ major).
  const payloadMarkers = markers.filter((m) => {
    const present = markerIdx.get(m.name)!.length;
    return m.alwaysLoaded || present < versions.length * 0.9;
  });

  const jqueryRanges: Record<string, [string, string][]> = {};
  const jqIdx = new Map<string, number[]>();
  analyses.forEach((a, i) => a.jquery && (jqIdx.get(a.jquery) ?? jqIdx.set(a.jquery, []).get(a.jquery)!).push(i));
  for (const [jq, idx] of jqIdx) jqueryRanges[jq] = runs(idx).map(([s, e]) => [versions[s]!, versions[e]!]);

  const factRanges: Record<string, [string, string][]> = {};
  for (const key of Object.keys(analyses[0]!.facts)) {
    const idx = analyses.flatMap((a, i) => (a.facts[key] ? [i] : []));
    factRanges[key] = runs(idx).map(([s, e]) => [versions[s]!, versions[e]!]);
  }

  const libIdx = new Map<string, number[]>();
  analyses.forEach((a, i) => a.libraries.forEach((l) => (libIdx.get(l) ?? libIdx.set(l, []).get(l)!).push(i)));
  const libraryRanges: Record<string, [string, string][]> = Object.fromEntries(
    [...libIdx.entries()]
      .filter(([, idx]) => idx.length < versions.length)
      .map(([l, idx]) => [l, runs(idx).map(([s, e]) => [versions[s]!, versions[e]!])]),
  );

  const themeIdx = new Map<string, number[]>();
  analyses.forEach((a, i) => a.themes.forEach((t) => (themeIdx.get(t) ?? themeIdx.set(t, []).get(t)!).push(i)));
  const themeRanges: Record<string, [string, string][]> = Object.fromEntries(
    [...themeIdx.entries()].map(([t, idx]) => [t, runs(idx).map(([s, e]) => [versions[s]!, versions[e]!])]),
  );

  mkdirSync(join(ROOT, "research"), { recursive: true });
  writeFileSync(
    join(ROOT, "research", "markers.json"),
    JSON.stringify(
      {
        releases: analyses.map((a) => ({ version: a.version, jquery: a.jquery })),
        facts: factRanges,
        jquery: jqueryRanges,
        markers,
        libraries: libraryRanges,
        themes: themeRanges,
      },
      null,
      2,
    ),
  );

  // ---- active probes ----
  console.log("Hashing public assets…");
  const perRelease = versions.map(assetHashes);
  const probeSel = chooseProbes(perRelease);
  const probeTable: Record<string, Record<string, [string, string][]>> = {};
  for (const path of probeSel.chosen) {
    const byHash = new Map<string, number[]>();
    perRelease.forEach((m, i) => {
      const h = m.get(path);
      if (h !== undefined) (byHash.get(h) ?? byHash.set(h, []).get(h)!).push(i);
    });
    probeTable[path] = Object.fromEntries(
      [...byHash].map(([h, idx]) => [h, runs(idx).map(([s, e]) => [versions[s]!, versions[e]!] as [string, string])]),
    );
  }
  // Size of the release groups that remain indistinguishable even with every probe.
  const groupSizes = new Map<number, string[]>();
  probeSel.groups.forEach((g, i) => (groupSizes.get(g) ?? groupSizes.set(g, []).get(g)!).push(versions[i]!));
  const unsplit = [...groupSizes.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);

  // ---- detector payload ----
  const idxOf = new Map(versions.map((v, i) => [v, i]));
  const enc = (ranges: [string, string][]) => ranges.flatMap(([s, e]) => [idxOf.get(s)!, idxOf.get(e)!]);
  const payload = {
    releases: versions,
    markers: Object.fromEntries(payloadMarkers.map((m) => [m.name, [m.alwaysLoaded ? 1 : 0, ...enc(m.ranges)]])),
    jquery: Object.fromEntries(Object.entries(jqueryRanges).map(([k, r]) => [k, enc(r)])),
    libraries: Object.fromEntries(Object.entries(libraryRanges).map(([k, r]) => [k, enc(r)])),
    themes: Object.fromEntries(Object.entries(themeRanges).map(([k, r]) => [k, enc(r)])),
    facts: Object.fromEntries(Object.entries(factRanges).map(([k, r]) => [k, enc(r)])),
  };
  // Kept in its own module so the passive-only build never bundles it.
  const probesPayload = Object.fromEntries(
    Object.entries(probeTable).map(([p, byHash]) => [p, Object.fromEntries(Object.entries(byHash).map(([h, r]) => [h, enc(r)]))]),
  );
  writeFileSync(
    join(ROOT, "src", "fingerprints.generated.ts"),
    `// GENERATED by scripts/research.ts from ${versions.length} Drupal core releases ` +
      `(${versions[0]} … ${versions.at(-1)}). Do not edit by hand; run \`bun run research\`.\n` +
      `/* eslint-disable */\n` +
      `import type { Fingerprints } from "./types";\n\n` +
      `export const FINGERPRINTS: Fingerprints = ${JSON.stringify(payload)};\n`,
  );
  writeFileSync(
    join(ROOT, "src", "probes.generated.ts"),
    `// GENERATED by scripts/research.ts: content hashes of public core files, indexed into\n` +
      `// FINGERPRINTS.releases. Only the active (network) scan uses this. Run \`bun run research\`.\n` +
      `/* eslint-disable */\n` +
      `import type { ProbeTable } from "./types";\n\n` +
      `export const PROBES: ProbeTable = ${JSON.stringify(probesPayload)};\n`,
  );

  // ---- report ----
  const fmt = (r: [string, string][]) => r.map(([s, e]) => (s === e ? s : `${s} – ${e}`)).join(", ");
  const lines = [
    `# Drupal JS fingerprint report`,
    ``,
    `Generated by \`bun run research\` from **${versions.length}** core releases (${versions[0]} … ${versions.at(-1)}).`,
    ``,
    `## Server-side facts that surface in HTML`,
    ``,
    `| fact | releases |`,
    `| --- | --- |`,
    ...Object.entries(factRanges).map(([k, r]) => `| \`${k}\` | ${fmt(r) || "—"} |`),
    ``,
    `## Shipped jQuery`,
    ``,
    `| jQuery | releases |`,
    `| --- | --- |`,
    ...Object.entries(jqueryRanges)
      .sort((a, b) => compareVersions(a[1][0]![0], b[1][0]![0]))
      .map(([k, r]) => `| ${k} | ${fmt(r)} |`),
    ``,
    `## Version-discriminating JS markers`,
    ``,
    `\`always\` = defined in drupal.js, so absence is evidence whenever \`window.Drupal\` exists.`,
    ``,
    `| marker | always | defined in | releases |`,
    `| --- | --- | --- | --- |`,
    ...markers.map((m) => `| \`${m.name}\` | ${m.alwaysLoaded ? "✔" : ""} | ${m.files.join("<br>")} | ${fmt(m.ranges)} |`),
    ``,
    `## Active probes`,
    ``,
    `Files requested by \`depth: "light" | "standard" | "deep"\`, chosen greedily; "groups" is how many`,
    `distinguishable release groups exist after adding each file (${versions.length} releases in total).`,
    ``,
    `| # | file | groups |`,
    `| --- | --- | --- |`,
    ...probeSel.steps.map((st, i) => `| ${i + 1} | \`${st.path}\` | ${st.groups} |`),
    ``,
    `Releases still indistinguishable with every probe file (largest first):`,
    ``,
    ...unsplit.slice(0, 15).map((g) => `- ${g[0]} … ${g.at(-1)} (${g.length})`),
    ``,
    `## Core themes`,
    ``,
    `| theme | releases |`,
    `| --- | --- |`,
    ...Object.entries(themeRanges).map(([k, r]) => `| ${k} | ${fmt(r)} |`),
    ``,
  ];
  writeFileSync(join(ROOT, "research", "REPORT.md"), lines.join("\n"));

  console.log(
    `Done: ${markers.length} discriminating markers (${payloadMarkers.length} in payload), ` +
      `${Object.keys(jqueryRanges).length} jQuery versions, ${Object.keys(libraryRanges).length} libraries, ` +
      `${probeSel.chosen.length} probe files -> ${probeSel.steps.at(-1)?.groups ?? 1} release groups.`,
  );
}

if (import.meta.main) await main();
