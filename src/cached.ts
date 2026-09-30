import { pageHref, resolveBase } from "./base";
import { safe, type State } from "./passive";
import { isKnownPath, matchFile } from "./table";
import type { DetectDrupalOptions } from "./types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Cached scan: re-read core files the page has *already loaded* from the browser's HTTP cache
 * and match their hashes. Uses `cache: "only-if-cached"`, which the Fetch standard defines as
 * never touching the network (a cache miss fails instead), so this makes zero requests.
 *
 * Returns the site-relative paths it read, so a following active scan does not request them again.
 */
export async function readCached(st: State, options: Pick<DetectDrupalOptions, "baseUrl" | "fetch">): Promise<Set<string>> {
  const read = new Set<string>();
  if (st.exact) return read;
  const href = pageHref(st);
  const base = href ? resolveBase(options, st) : null;
  const f: FetchLike | undefined =
    options.fetch ?? safe(() => (typeof st.win?.fetch === "function" ? st.win.fetch.bind(st.win) : undefined));
  if (!href || !base || !f) return read;
  const baseUrl = new URL(base);

  // Every URL the page loaded: tags in the DOM plus resource timing (covers dynamic loads).
  const loaded = new Set<string>();
  for (const u of st.urls) {
    const abs = safe(() => new URL(u, href).href);
    if (abs) loaded.add(abs);
  }
  const entries = safe(() => st.win?.performance?.getEntriesByType?.("resource") as { name: string }[]) ?? [];
  for (const e of entries) if (typeof e?.name === "string") loaded.add(e.name);

  const seen = new Set<string>();
  let misses = 0;
  for (const url of loaded) {
    const u = safe(() => new URL(url));
    // "only-if-cached" requires same-origin mode, so other origins (CDNs) are skipped.
    if (!u || u.origin !== baseUrl.origin || !u.pathname.startsWith(baseUrl.pathname)) continue;
    const path = safe(() => decodeURIComponent(u.pathname.slice(baseUrl.pathname.length)));
    if (!path || seen.has(path) || !isKnownPath(path)) continue;
    seen.add(path);
    try {
      const res = await f(u.href, { cache: "only-if-cached", mode: "same-origin", credentials: "same-origin" });
      if (!res.ok) {
        misses++;
        continue;
      }
      matchFile(st, path, await res.text(), "cached");
      read.add(path);
    } catch {
      misses++; // not in the cache (or cache mode unsupported): never falls back to the network
    }
  }
  if (misses) st.evidence.push(`cached: ${misses} loaded core file(s) not in the browser cache`);
  return read;
}
