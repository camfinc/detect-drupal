/**
 * No-network build: reads the current page, and optionally re-reads core files the page has
 * already loaded from the browser cache. It contains no code path that makes a network
 * request, so it is the one to inject into a live page.
 */
import { readCached } from "./cached";
import { collect, failed, verdict } from "./passive";
import type { DetectDrupalOptions, DrupalDetection } from "./types";

/** `"passive"`: synchronous, page only. `"cached"`: also re-reads already-loaded core files from the browser cache. */
export type NoNetworkDepth = "passive" | "cached";

export type NoNetworkOptions = Pick<DetectDrupalOptions, "window" | "document"> & { depth?: NoNetworkDepth };

/**
 * Detect Drupal without any network requests. Never throws and never rejects.
 * Synchronous for `"passive"` (the default); returns a Promise for `"cached"`.
 */
export function detectDrupal(options?: Pick<DetectDrupalOptions, "window" | "document"> & { depth?: "passive" }): DrupalDetection;
export function detectDrupal(options: Pick<DetectDrupalOptions, "window" | "document"> & { depth: "cached" }): Promise<DrupalDetection>;
export function detectDrupal(options?: NoNetworkOptions): DrupalDetection | Promise<DrupalDetection>;
export function detectDrupal(options: NoNetworkOptions = {}): DrupalDetection | Promise<DrupalDetection> {
  const depth = (options as DetectDrupalOptions).depth ?? "passive";
  const pageOnly = { window: options.window, document: options.document };
  if (depth === "passive") {
    try {
      return verdict(collect(pageOnly));
    } catch (e) {
      return failed(e);
    }
  }
  // Any other depth (including "light"/"standard"/"deep" from plain JS callers) gets the most
  // this build can do without the network: the cache read.
  return (async () => {
    try {
      const st = collect(pageOnly);
      if (depth !== "cached") st.evidence.push(`depth "${depth}" limited to "cached": this build makes no network requests`);
      await readCached(st, {});
      return verdict(st);
    } catch (e) {
      return failed(e);
    }
  })();
}

export default detectDrupal;
export type { DrupalDetection, DrupalVersionRange } from "./types";
