import { probe } from "./active";
import { collect, verdict } from "./passive";
import type { ActiveOptions, DetectDrupalOptions, DrupalDetection, PassiveOptions } from "./types";

function failed(e: unknown): DrupalDetection {
  // Pages can define hostile getters/proxies; never break the host page.
  return {
    isDrupal: false,
    version: null,
    major: null,
    versionRange: null,
    confidence: 0,
    evidence: [`detection error: ${e instanceof Error ? e.message : String(e)}`],
    requests: 0,
  };
}

/**
 * Detect whether the current page is a Drupal site and, where possible, which core version.
 *
 * With no `depth` (or `depth: "passive"`) it is synchronous and makes no network requests.
 * Any other depth returns a Promise and may request public core files from the site.
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
      return verdict(await probe(collect(options), options, depth));
    } catch (e) {
      return failed(e);
    }
  })();
}
