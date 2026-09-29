import { FINGERPRINTS } from "./fingerprints.generated";
import { assetHash } from "./hash";
import { isObj, parts, safe, W_EXACT, W_PRERELEASE, W_PROBE, W_PROBE_MISSING, type State } from "./passive";
import type { DetectDepth, DetectDrupalOptions } from "./types";

/** Hard cap so a `"deep"` scan stays polite. */
const MAX_REQUESTS = 40;

export function budgetFor(depth: DetectDepth): number {
  if (typeof depth === "number") return Math.max(0, Math.min(MAX_REQUESTS, Math.floor(depth)));
  return { passive: 0, light: 2, standard: 5, deep: MAX_REQUESTS }[depth] ?? 0;
}

/** Where the site root is: explicit option, Drupal's own base path, drupal.js location, or `/`. */
function resolveBase(options: DetectDrupalOptions, st: State): string | null {
  const href = safe(() => (st.win?.location?.href as string | undefined) ?? st.doc?.location?.href);
  const abs = (u: string) => safe(() => new URL(u, href).href) ?? null;
  if (options.baseUrl) return abs(options.baseUrl.endsWith("/") ? options.baseUrl : options.baseUrl + "/");
  if (!href) return null;
  const s = st.settings;
  const fromSettings = safe(() => (isObj(s?.path) ? s!.path.baseUrl : s?.basePath));
  if (typeof fromSettings === "string" && fromSettings.startsWith("/")) return abs(fromSettings);
  for (const u of st.urls) {
    const m = /^(.*?\/)(?:core\/)?misc\/drupal\.js(?:[?#]|$)/.exec(u);
    if (m) return abs(m[1]!);
  }
  return abs("/");
}

type Fetched = { status: number; text: string | null };

async function get(url: string, options: DetectDrupalOptions, st: State): Promise<Fetched> {
  const f = options.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
  if (!f) return { status: 0, text: null };
  st.requests++;
  const ctrl = typeof AbortController === "function" ? new AbortController() : undefined;
  const timer = ctrl && setTimeout(() => ctrl.abort(), options.timeout ?? 8000);
  try {
    const res = await f(url, { credentials: "same-origin", redirect: "follow", signal: ctrl?.signal });
    if (!res.ok) return { status: res.status, text: null };
    const text = await res.text();
    // Catch-all routes answer 200 with an HTML page for missing files.
    if (/^\s*</.test(text) && /html/i.test(res.headers?.get?.("content-type") ?? "html")) return { status: 404, text: null };
    return { status: res.status, text };
  } catch {
    return { status: 0, text: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pick the probe file that is expected to leave the fewest candidates. Releases that do not
 * ship the file form their own group, since a 404 is (weak) evidence too.
 */
function pickProbe(candidates: number[], tried: Set<string>, hashIndex: Map<string, Map<number, string>>): string | null {
  const n = candidates.length;
  let best: string | null = null;
  let bestExpected = n;
  for (const [path, byRelease] of hashIndex) {
    if (tried.has(path)) continue;
    const groups = new Map<string, number>();
    let absent = 0;
    for (const i of candidates) {
      const h = byRelease.get(i);
      if (h === undefined) absent++;
      else groups.set(h, (groups.get(h) ?? 0) + 1);
    }
    let expected = (absent / n) * absent;
    for (const size of groups.values()) expected += (size / n) * size;
    if (expected < bestExpected - 1e-9) {
      bestExpected = expected;
      best = path;
    }
  }
  return best;
}

let hashIndexCache: Map<string, Map<number, string>> | undefined;
/** probes table -> path -> (release index -> hash), built once on first use. */
function hashIndex(): Map<string, Map<number, string>> {
  if (hashIndexCache) return hashIndexCache;
  hashIndexCache = new Map();
  for (const [path, hashes] of Object.entries(FINGERPRINTS.probes)) {
    const byRelease = new Map<number, string>();
    for (const [h, ranges] of Object.entries(hashes)) {
      for (let r = 0; r < ranges.length; r += 2) for (let i = ranges[r]!; i <= ranges[r + 1]!; i++) byRelease.set(i, h);
    }
    hashIndexCache.set(path, byRelease);
  }
  return hashIndexCache;
}

/** Files that state the exact version, when a site forgot to hide them. */
async function probeExact(base: string, options: DetectDrupalOptions, st: State): Promise<void> {
  const majors = new Set(st.c.best().map((i) => st.c.majors[i]!));
  const tries: [string, RegExp][] = [];
  if ([...majors].some((m) => m < 8)) tries.push(["CHANGELOG.txt", /^Drupal (\d+\.\d+)(?:[.,\s]|$)/m]);
  if ([...majors].some((m) => m >= 8)) {
    tries.push(["core/modules/system/system.info.yml", /^version:\s*['"]?(\d+\.\d+\.\d+(?:-[\w.]+)?)['"]?\s*$/m]);
  }
  for (const [path, re] of tries) {
    const { status, text } = await get(base + path, options, st);
    const v = text ? re.exec(text)?.[1] : undefined;
    if (!v) {
      st.evidence.push(`probe ${path}: ${status === 200 ? "no version" : status ? `HTTP ${status}` : "unreachable"}`);
      continue;
    }
    st.exact = v;
    st.score += 100;
    st.evidence.push(`probe ${path}: version ${v}`);
    const idx = FINGERPRINTS.releases.indexOf(v);
    st.c.constrain(W_EXACT, (i) => (idx >= 0 ? i === idx : st.c.majors[i] === parts(v)[0]));
    return;
  }
}

/** Active scan: request public core files and match their hashes against every known release. */
export async function probe(st: State, options: DetectDrupalOptions, depth: DetectDepth): Promise<State> {
  const budget = budgetFor(depth);
  if (budget === 0 || st.exact) return st;
  const base = resolveBase(options, st);
  if (!base) {
    st.evidence.push("active scan skipped: no base URL (pass options.baseUrl)");
    return st;
  }
  if (depth === "deep") await probeExact(base, options, st);

  const index = hashIndex();
  const tried = new Set<string>();
  let matched = false;
  while (!st.exact && st.requests < budget) {
    // Keep pre-releases that only lose on the "prefer stable" tie-breaker in play.
    const candidates = st.c.best(W_PRERELEASE);
    if (candidates.length <= 1) break;
    const path = pickProbe(candidates, tried, index);
    if (!path) break;
    tried.add(path);
    const { status, text } = await get(base + path, options, st);
    if (text === null) {
      st.evidence.push(`probe ${path}: ${status ? `HTTP ${status}` : "unreachable"}`);
      // Only a real "not found" says anything; 403/5xx/timeouts are blocking, not absence.
      if (status === 404 || status === 410) {
        const present = index.get(path)!;
        st.c.constrain(W_PROBE_MISSING, (i) => !present.has(i));
      }
      continue;
    }
    const ranges = FINGERPRINTS.probes[path]![assetHash(text)];
    if (!ranges) {
      st.evidence.push(`probe ${path}: unknown content (patched, or newer than the fingerprint data)`);
      continue;
    }
    if (!matched) st.score += 100; // a byte-identical core file is proof of Drupal
    matched = true;
    st.evidence.push(`probe ${path}: matches known release(s)`);
    st.c.inRanges(W_PROBE, ranges);
  }
  return st;
}

