import { FINGERPRINTS } from "./fingerprints.generated";
import type { DetectDrupalOptions, DrupalDetection, Fingerprints } from "./types";

export type AnyObj = Record<string, any>;

/** Everything learnt from the page, before a verdict is drawn. */
export interface State {
  c: Candidates;
  score: number;
  evidence: string[];
  exact: string | null;
  win: AnyObj | undefined;
  doc: Document | undefined;
  settings: AnyObj | null;
  urls: string[];
  requests: number;
  /** A fetched or cached core file matched a known release byte for byte. */
  fileMatched?: boolean;
}


// Constraint weights: how bad it is for a candidate release to contradict a signal.
export const W_EXACT = 1000; // ?v=X.Y.Z on a core asset
const W_GENERATOR = 500; // <meta name="Generator" content="Drupal N">
const W_STRUCTURE = 200; // core/ vs misc/ paths, drupalSettings vs Drupal.settings
const W_PRESENT = 10; // a versioned API/library/theme is present
const W_ABSENT = 4; // an always-loaded API is missing
const W_JQUERY = 1; // shipped jQuery version (sites often swap jQuery)
export const W_PRERELEASE = 0.5; // alpha/beta/rc builds are rare in the wild
export const W_PROBE = 300; // a fetched core file is byte-identical to a known release
export const W_PROBE_MISSING = 5; // a core file 404s (weak: files can be removed or blocked)

const CORE_THEME_PATH = /\/core\/themes\/([a-z0-9_]+)\//;
const LEGACY_THEME_PATH = /(?:^|\/)themes\/(garland|bluemarine|chameleon|marvin|minnelli|pushbutton|bartik|seven|stark)\//;
const CORE_VERSION_QUERY = /\/core\/(?:misc|modules|themes)\/[^?#]+\.js\?(?:[^#]*&)?v=(\d+\.\d+\.\d+(?:-[a-z]+\d*)?)(?:[&#]|$)/i;

export function parts(v: string): number[] {
  return v.split("-")[0]!.split(".").map(Number);
}

export class Candidates {
  readonly releases: string[];
  readonly penalty: number[];
  readonly majors: number[];
  hasVersionEvidence = false;

  constructor(fp: Fingerprints) {
    this.releases = fp.releases;
    this.penalty = fp.releases.map(() => 0);
    this.majors = fp.releases.map((v) => parts(v)[0]!);
    // Tie-breaker: prefer stable releases unless the evidence points at a pre-release.
    fp.releases.forEach((v, i) => v.includes("-") && (this.penalty[i] = W_PRERELEASE));
  }

  /** Penalise releases for which `ok(index)` is false. */
  constrain(weight: number, ok: (i: number) => boolean): void {
    this.hasVersionEvidence = true;
    for (let i = 0; i < this.releases.length; i++) if (!ok(i)) this.penalty[i]! += weight;
  }

  inRanges(weight: number, ranges: number[], invert = false): void {
    this.constrain(weight, (i) => {
      let hit = false;
      for (let r = 0; r < ranges.length; r += 2) if (i >= ranges[r]! && i <= ranges[r + 1]!) hit = true;
      return hit !== invert;
    });
  }

  majorAtLeast(weight: number, min: number): void {
    this.constrain(weight, (i) => this.majors[i]! >= min);
  }

  majorBelow(weight: number, max: number): void {
    this.constrain(weight, (i) => this.majors[i]! < max);
  }

  /** Indices with the lowest total penalty (plus `slack`, to keep near-ties in play). */
  best(slack = 0): number[] {
    const min = Math.min(...this.penalty);
    const out: number[] = [];
    this.penalty.forEach((p, i) => p <= min + slack && out.push(i));
    return out;
  }
}

export function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export function isObj(v: unknown): v is AnyObj {
  return !!v && (typeof v === "object" || typeof v === "function");
}

/** Resolve a marker such as `Drupal.announce`, `Drupal.theme.placeholder`, `jQuery.fn.once`, `window.once`. */
function hasMarker(win: AnyObj, marker: string): boolean {
  const [root, ...rest] = marker.split(".");
  let obj: any = root === "window" ? win : root === "jQuery" ? win.jQuery : win[root!];
  if (root === "Drupal" && rest[0] === "theme" && rest[1]) {
    const theme = obj?.theme;
    return isObj(theme) && (rest[1] in theme || (isObj(theme.prototype) && rest[1] in theme.prototype));
  }
  for (const key of rest) {
    if (!isObj(obj) || !(key in obj)) return false;
    obj = obj[key];
  }
  return obj !== undefined;
}

function commonPrefix(a: string, b: string, maxDepth: number): string {
  const pa = parts(a);
  const pb = parts(b);
  const out: number[] = [];
  for (let i = 0; i < Math.min(pa.length, pb.length, maxDepth); i++) {
    if (pa[i] !== pb[i]) break;
    out.push(pa[i]!);
  }
  if (out.length === pa.length && out.length === pb.length && a === b) return a; // keep pre-release suffix
  return out.join(".");
}

function urlsOf(doc: Document | undefined): string[] {
  if (!doc) return [];
  const urls: string[] = [];
  const nodes = safe(() => doc.querySelectorAll("script[src],link[href]")) ?? [];
  for (const el of Array.from(nodes)) {
    const u = el.getAttribute("src") ?? el.getAttribute("href");
    if (u) urls.push(u);
  }
  return urls;
}

function readSettings(win: AnyObj, doc: Document | undefined): { settings: AnyObj | null; jsonTag: boolean } {
  const tag = safe(() => doc?.querySelector('script[data-drupal-selector="drupal-settings-json"]'));
  if (tag) {
    const parsed = safe(() => JSON.parse(tag.textContent || "null"));
    if (isObj(parsed)) return { settings: parsed, jsonTag: true };
  }
  if (isObj(win.drupalSettings)) return { settings: win.drupalSettings, jsonTag: !!tag };
  if (isObj(win.Drupal) && isObj(win.Drupal.settings)) return { settings: win.Drupal.settings, jsonTag: !!tag };
  return { settings: null, jsonTag: !!tag };
}

/** Passive scan: inspect the page as-is, no network. */
export function collect(options: DetectDrupalOptions): State {
  const fp = FINGERPRINTS;
  const win: AnyObj | undefined =
    (options.window as AnyObj | undefined) ?? (typeof window !== "undefined" ? (window as unknown as AnyObj) : undefined);
  const doc: Document | undefined = options.document ?? safe(() => win?.document as Document | undefined);
  const evidence: string[] = [];
  const c = new Candidates(fp);
  let score = 0;
  let exact: string | null = null;
  const note = (points: number, msg: string) => {
    score += points;
    evidence.push(msg);
  };

  const state = (): State => ({ c, score, evidence, exact, win, doc, settings, urls, requests: 0 });
  let settings: AnyObj | null = null;
  let urls: string[] = [];
  if (!win && !doc) return state();
  const w: AnyObj = win ?? {};

  // --- <meta name="Generator" content="Drupal 10 (https://www.drupal.org)"> -------------
  const generator = safe(() =>
    Array.from(doc?.querySelectorAll("meta[name]") ?? [])
      .filter((m) => /^generator$/i.test(m.getAttribute("name") || ""))
      .map((m) => m.getAttribute("content") || "")
      .find((content) => /\bDrupal\b/i.test(content)),
  );
  if (generator) {
    note(100, `meta generator: "${generator}"`);
    const major = /\bDrupal\s+(\d+)/i.exec(generator)?.[1];
    if (major) c.constrain(W_GENERATOR, (i) => c.majors[i] === Number(major));
  }

  // --- Asset URLs ----------------------------------------------------------------------
  urls = urlsOf(doc);
  const versionVotes = new Map<string, number>();
  let coreAssets = false;
  let legacyDrupalJs = false;
  for (const u of urls) {
    if (/\/core\/(?:misc|assets|modules|themes|profiles)\//.test(u)) coreAssets = true;
    if (/(?:^|\/)misc\/drupal\.js(?:[?#]|$)/.test(u) && !/\/core\/misc\//.test(u)) legacyDrupalJs = true;
    const v = CORE_VERSION_QUERY.exec(u)?.[1];
    if (v) versionVotes.set(v, (versionVotes.get(v) ?? 0) + 1);
  }
  const drupalJsSrc = urls.some((u) => /(?:^|\/)(?:core\/)?misc\/drupal(?:\.init)?\.js(?:[?#]|$)/.test(u));
  if (drupalJsSrc) note(100, "drupal.js script");
  if (coreAssets) {
    note(40, "assets under /core/");
    c.majorAtLeast(W_STRUCTURE, 8);
  }
  if (legacyDrupalJs) {
    note(0, "legacy /misc/drupal.js path (Drupal 6/7)");
    c.majorBelow(W_STRUCTURE, 8);
  }
  if (versionVotes.size) {
    exact = [...versionVotes.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    note(50, `core asset query string v=${exact}`);
    const idx = fp.releases.indexOf(exact);
    c.constrain(W_EXACT, (i) => (idx >= 0 ? i === idx : c.majors[i] === parts(exact!)[0]));
  }
  // Aggregates live in public:// (/sites/*/files/) unless $settings['file_assets_path'] moves them.
  if (urls.some((u) => /\/(js|css)\/\1_[\w-]{20,}\.\1(?:[?#]|$)/.test(u))) {
    note(60, "Drupal aggregated assets ({js,css}/{js,css}_<hash>)");
  } else if (urls.some((u) => /\/sites\/(?:all|default)\/(?:modules|themes|libraries|files)\//.test(u))) {
    note(30, "assets under /sites/{all,default}/");
  }
  const aggregateWithInclude = urls.some((u) =>
    /\/js\/js_[\w-]+\.js\?(?:[^#]*&)?include=/.test(u),
  );
  if (aggregateWithInclude && fp.facts.aggregateIncludeQuery) {
    evidence.push("on-demand aggregate URL with include= query");
    c.inRanges(W_PRESENT, fp.facts.aggregateIncludeQuery);
  }
  for (const u of urls) {
    const theme = CORE_THEME_PATH.exec(u)?.[1] ?? LEGACY_THEME_PATH.exec(u)?.[1];
    if (theme && fp.themes[theme]) {
      evidence.push(`core theme asset: ${theme}`);
      c.inRanges(W_PRESENT, fp.themes[theme]!);
      break;
    }
  }

  // --- DOM attributes ------------------------------------------------------------------
  if (safe(() => doc?.querySelector("[data-drupal-selector],[data-drupal-link-system-path],[data-drupal-messages]"))) {
    note(60, "data-drupal-* attributes");
    c.majorAtLeast(W_STRUCTURE, 8);
  }

  // --- Settings ------------------------------------------------------------------------
  const read = readSettings(w, doc);
  const jsonTag = read.jsonTag;
  settings = read.settings;
  if (jsonTag) {
    note(100, "drupal-settings-json script tag");
    c.majorAtLeast(W_STRUCTURE, 8);
    if (fp.facts.settingsJsonScriptTag) c.inRanges(W_PRESENT, fp.facts.settingsJsonScriptTag);
  }
  if (isObj(w.drupalSettings)) {
    note(60, "window.drupalSettings");
    c.majorAtLeast(W_STRUCTURE, 8);
  } else if (isObj(w.Drupal) && isObj(w.Drupal.settings) && !jsonTag) {
    note(40, "Drupal.settings (Drupal 6/7)");
    c.majorBelow(W_STRUCTURE, 8);
  }
  const pageState: AnyObj | undefined = settings?.ajaxPageState;
  if (isObj(pageState)) {
    note(20, "ajaxPageState settings");
    if (typeof pageState.theme === "string" && fp.themes[pageState.theme]) {
      evidence.push(`active core theme: ${pageState.theme}`);
      c.inRanges(W_PRESENT, fp.themes[pageState.theme]!);
    }
    const libs = pageState.libraries;
    if (typeof libs === "string" && libs) {
      if (/(^|,)core\//.test(libs)) {
        for (const lib of libs.split(",")) {
          const ranges = fp.libraries[lib];
          if (ranges) c.inRanges(W_PRESENT, ranges);
        }
        if (fp.facts.compressedAjaxPageStateLibraries) c.inRanges(W_PRESENT, fp.facts.compressedAjaxPageStateLibraries, true);
        evidence.push("ajaxPageState.libraries (plain list)");
      } else if (!libs.includes(",") && fp.facts.compressedAjaxPageStateLibraries) {
        evidence.push("ajaxPageState.libraries (compressed)");
        c.inRanges(W_PRESENT, fp.facts.compressedAjaxPageStateLibraries);
      }
    }
  }

  // --- window.Drupal API surface -------------------------------------------------------
  const D = w.Drupal;
  const drupalObj = isObj(D) && isObj(D.behaviors);
  if (drupalObj) {
    note(70, "window.Drupal with behaviors");
    const behaviors = Object.keys(D.behaviors).map((k) => D.behaviors[k]);
    if (behaviors.some((b) => typeof b === "function" && !("attach" in b))) {
      evidence.push("function-style behaviors (Drupal 6)");
      c.constrain(W_STRUCTURE, (i) => c.majors[i] === 6);
    }
    for (const marker of Object.keys(fp.markers)) {
      const [always, ...ranges] = fp.markers[marker]!;
      if (safe(() => hasMarker(w, marker))) c.inRanges(W_PRESENT, ranges);
      else if (always) c.inRanges(W_ABSENT, ranges, true);
    }
  } else if (isObj(D)) {
    note(20, "window.Drupal");
  }
  if (safe(() => doc?.querySelector("[data-once]")) && fp.markers["window.once"]) {
    evidence.push("data-once attributes");
    c.inRanges(W_PRESENT, fp.markers["window.once"]!.slice(1));
  }

  // jQuery shipped by core (weak: jquery_update and themes often replace it).
  const jq = safe(() => w.jQuery?.fn?.jquery as string | undefined);
  if ((drupalObj || score >= 100) && typeof jq === "string" && fp.jquery[jq]) {
    evidence.push(`jQuery ${jq}`);
    c.inRanges(W_JQUERY, fp.jquery[jq]!);
  }

  return state();
}

/** Result for an unexpected error: pages can define hostile getters/proxies; never break the host page. */
export function failed(e: unknown): DrupalDetection {
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

/** Turn the collected evidence into the public result. */
export function verdict(st: State): DrupalDetection {
  const fp = FINGERPRINTS;
  const { c, score, evidence, exact, requests } = st;
  const confidence = Math.min(100, score);
  const isDrupal = confidence >= 50;
  if (!isDrupal) return { isDrupal, version: null, major: null, versionRange: null, confidence, evidence, requests };

  if (exact && fp.releases.indexOf(exact) < 0) {
    // Newer than the fingerprint data (or a dev build): trust the core asset query string.
    return {
      isDrupal,
      version: exact,
      major: parts(exact)[0]!,
      versionRange: { min: exact, max: exact },
      confidence,
      evidence,
      requests,
    };
  }
  if (!c.hasVersionEvidence) return { isDrupal, version: null, major: null, versionRange: null, confidence, evidence, requests };

  const best = c.best();
  const min = fp.releases[best[0]!]!;
  const maxIdx = best[best.length - 1]!;
  const max = fp.releases[maxIdx]!;
  // The range is open-ended if it reaches the newest known release of an active major.
  const maxMajor = c.majors[maxIdx]!;
  const newestMajor = c.majors[c.majors.length - 1]!;
  const lastOfMajor = maxIdx === c.majors.length - 1 || c.majors[maxIdx + 1] !== maxMajor;
  const open = !exact && lastOfMajor && maxMajor >= newestMajor - 2;

  const version = exact ?? (commonPrefix(min, max, open ? 1 : 3) || null);
  const majors = new Set(best.map((i) => c.majors[i]));
  return {
    isDrupal,
    version,
    major: majors.size === 1 ? c.majors[best[0]!]! : null,
    versionRange: { min, max: open ? null : max },
    confidence,
    evidence,
    requests,
  };
}
