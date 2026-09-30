import { resolveBase } from "./base";
import { FINGERPRINTS } from "./fingerprints.generated";
import { parts, W_EXACT, W_PRERELEASE, W_PROBE_MISSING, type State } from "./passive";
import { hashIndex, matchFile } from "./table";
import type { DetectDepth, DetectDrupalOptions } from "./types";

/** Hard cap so a `"deep"` scan stays polite. */
const MAX_REQUESTS = 40;

export function budgetFor(depth: DetectDepth): number {
  if (typeof depth === "number") return Math.max(0, Math.min(MAX_REQUESTS, Math.floor(depth)));
  return { passive: 0, cached: 0, light: 2, standard: 5, deep: MAX_REQUESTS }[depth] ?? 0;
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

/**
 * Drupal 6/7 ship CHANGELOG.txt in the web root and serve it by default; its first entry is
 * the exact version. Only requested once the evidence says 6/7: on 8+ the file is under core/
 * and carries no version, so asking for it would be a pointless request. Non-public files
 * (e.g. *.info.yml, blocked by Drupal's own .htaccess) are never requested.
 */
async function probeChangelog(base: string, options: DetectDrupalOptions, st: State): Promise<void> {
  const path = "CHANGELOG.txt";
  const { status, text } = await get(base + path, options, st);
  const v = text ? /^Drupal (\d+\.\d+)(?:[.,\s]|$)/m.exec(text)?.[1] : undefined;
  if (!v || parts(v)[0]! >= 8) {
    st.evidence.push(`probe ${path}: ${status === 200 ? "no version" : status ? `HTTP ${status}` : "unreachable"}`);
    return;
  }
  st.exact = v;
  st.score += 100;
  st.evidence.push(`probe ${path}: version ${v}`);
  const idx = FINGERPRINTS.releases.indexOf(v);
  st.c.constrain(W_EXACT, (i) => (idx >= 0 ? i === idx : st.c.majors[i] === parts(v)[0]));
}

/** True when every remaining candidate is Drupal 6 or 7. */
function onlyLegacy(st: State): boolean {
  return st.c.best().every((i) => st.c.majors[i]! < 8);
}

/**
 * Active scan: request public core files and match their hashes against every known release.
 * `tried` holds paths already read (e.g. from the browser cache), which are not requested again.
 */
export async function probe(st: State, options: DetectDrupalOptions, depth: DetectDepth, tried = new Set<string>()): Promise<State> {
  const budget = budgetFor(depth);
  if (budget === 0 || st.exact) return st;
  const base = resolveBase(options, st);
  if (!base) {
    st.evidence.push("active scan skipped: no base URL (pass options.baseUrl)");
    return st;
  }
  let changelogTried = false;
  const tryChangelog = async () => {
    if (depth !== "deep" || changelogTried || st.exact || !onlyLegacy(st) || st.c.best().length <= 1) return;
    changelogTried = true;
    await probeChangelog(base, options, st);
  };
  await tryChangelog(); // page already says 6/7

  const index = hashIndex();
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
    matchFile(st, path, text, "probe");
    await tryChangelog(); // hash probes just showed 6/7
  }
  await tryChangelog();
  return st;
}

