/**
 * Ranges are encoded as flat index pairs into `releases`: [start0, end0, start1, end1, …].
 * Markers carry a leading flag: 1 when defined in drupal.js (always loaded with
 * `window.Drupal`), so their absence is also evidence.
 */
export interface Fingerprints {
  releases: string[];
  markers: Record<string, number[]>;
  jquery: Record<string, number[]>;
  libraries: Record<string, number[]>;
  themes: Record<string, number[]>;
  facts: Record<string, number[]>;
}

/** Public asset path (relative to the site base) -> content hash -> release ranges. */
export type ProbeTable = Record<string, Record<string, number[]>>;

/**
 * How hard to look.
 *
 * - `"passive"` (default): guesswork from what is already on the page. Synchronous, no network.
 * - `"light"`: plus up to 2 requests for the most telling core files.
 * - `"standard"`: plus up to 5 requests.
 * - `"deep"`: keep requesting core files while they still narrow the version, and try the
 *   files that state the exact version (`CHANGELOG.txt` on 6/7, packaged `.info.yml` on 8+).
 * - a number: a custom request budget.
 */
export type DetectDepth = "passive" | "light" | "standard" | "deep" | number;

export interface DetectDrupalOptions {
  /** Window to inspect. Defaults to the global `window`. */
  window?: Window | Record<string, any>;
  /** Document to inspect. Defaults to `window.document`. */
  document?: Document;
  /** Scan depth. Any depth other than `"passive"` makes `detectDrupal` return a Promise. */
  depth?: DetectDepth;
  /**
   * Site root to request core files from. Defaults to Drupal's own base path from the page,
   * else `/` on the current origin. Required outside a browser (e.g. Node).
   */
  baseUrl?: string;
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Per-request timeout in milliseconds. Default 8000. */
  timeout?: number;
}

export type PassiveOptions = DetectDrupalOptions & { depth?: "passive" };
export type ActiveOptions = DetectDrupalOptions & { depth: Exclude<DetectDepth, "passive"> };

export interface DrupalVersionRange {
  /** Oldest known core release consistent with the evidence. */
  min: string;
  /** Newest known core release consistent with the evidence, or `null` if it may be newer than any release known at build time. */
  max: string | null;
}

export interface DrupalDetection {
  /** Whether the page appears to be built with Drupal. */
  isDrupal: boolean;
  /**
   * Most precise version the evidence supports, e.g. `"10.2.3"`, `"10.2"`, `"10"`
   * (or `"7"` / `"7.98"` for Drupal 7). `null` when not Drupal or unknown.
   */
  version: string | null;
  /** Major version, e.g. `10`. */
  major: number | null;
  /** Range of known releases consistent with the evidence. */
  versionRange: DrupalVersionRange | null;
  /** 0–100, following the Wappalyzer convention. */
  confidence: number;
  /** Human-readable list of the signals that were found. */
  evidence: string[];
  /** Number of network requests made (always 0 for `"passive"`). */
  requests: number;
}
