import { assetHash } from "./hash";
import { W_PROBE, type State } from "./passive";
import { PROBES } from "./probes.generated";

let hashIndexCache: Map<string, Map<number, string>> | undefined;

/** Hash table -> path -> (release index -> hash), built once on first use. */
export function hashIndex(): Map<string, Map<number, string>> {
  if (hashIndexCache) return hashIndexCache;
  hashIndexCache = new Map();
  for (const [path, hashes] of Object.entries(PROBES)) {
    const byRelease = new Map<number, string>();
    for (const [h, ranges] of Object.entries(hashes)) {
      for (let r = 0; r < ranges.length; r += 2) for (let i = ranges[r]!; i <= ranges[r + 1]!; i++) byRelease.set(i, h);
    }
    hashIndexCache.set(path, byRelease);
  }
  return hashIndexCache;
}

export function isKnownPath(path: string): boolean {
  return path in PROBES;
}

/**
 * Match a core file's content against every release that shipped it and constrain the
 * candidates. `source` labels the evidence ("probe" for a request, "cached" for a cache read).
 */
export function matchFile(st: State, path: string, text: string, source: string): boolean {
  const ranges = PROBES[path]?.[assetHash(text)];
  if (!ranges) {
    st.evidence.push(`${source} ${path}: unknown content (patched, or newer than the fingerprint data)`);
    return false;
  }
  if (!st.fileMatched) st.score += 100; // a byte-identical core file is proof of Drupal
  st.fileMatched = true;
  st.evidence.push(`${source} ${path}: matches known release(s)`);
  st.c.inRanges(W_PROBE, ranges);
  return true;
}
