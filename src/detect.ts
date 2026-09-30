import { probe } from "./active";
import { readCached } from "./cached";
import { collect, failed, verdict } from "./passive";
import type { ActiveOptions, DetectDrupalOptions, DrupalDetection, PassiveOptions } from "./types";

/**
 * Detect whether the current page is a Drupal site and, where possible, which core version.
 *
 * With no `depth` (or `depth: "passive"`) it is synchronous and makes no network requests.
 * `depth: "cached"` returns a Promise and re-reads already-loaded core files from the browser
 * cache (still no network). `"light"`, `"standard"`, `"deep"` or a number may also request
 * public core files from the site.
 * Never throws and never rejects.
 */
export function detectDrupal(options?: PassiveOptions): DrupalDetection;
export function detectDrupal(options: ActiveOptions): Promise<DrupalDetection>;
export function detectDrupal(options?: DetectDrupalOptions): DrupalDetection | Promise<DrupalDetection>;
export function detectDrupal(options: DetectDrupalOptions = {}): DrupalDetection | Promise<DrupalDetection> {
  const depth = options.depth ?? "passive";
  if (depth === "passive") {
    try {
      return verdict(collect(options));
    } catch (e) {
      return failed(e);
    }
  }
  return (async () => {
    try {
      const st = collect(options);
      // Free first: core files the page already loaded, re-read from the browser cache.
      const read = await readCached(st, options);
      if (depth !== "cached") await probe(st, options, depth, read);
      return verdict(st);
    } catch (e) {
      return failed(e);
    }
  })();
}
