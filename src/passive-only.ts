/**
 * Passive-only build: reads the current page and never makes a network request.
 * The active (fetch) scan and its probe table are not included, so this is the
 * smallest build and the one to inject into a live page.
 */
import { collect, failed, verdict } from "./passive";
import type { DetectDrupalOptions, DrupalDetection } from "./types";

export type PassiveOnlyOptions = Pick<DetectDrupalOptions, "window" | "document">;

/** Detect Drupal from the current page only. Synchronous; never throws; no network. */
export function detectDrupal(options: PassiveOnlyOptions = {}): DrupalDetection {
  try {
    const st = collect({ window: options.window, document: options.document });
    const depth = (options as DetectDrupalOptions).depth;
    if (depth !== undefined && depth !== "passive") {
      st.evidence.push(`depth "${depth}" ignored: this build is passive-only (no network)`);
    }
    return verdict(st);
  } catch (e) {
    return failed(e);
  }
}

export default detectDrupal;
export type { DrupalDetection, DrupalVersionRange } from "./types";
