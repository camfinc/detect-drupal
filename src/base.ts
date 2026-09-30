import { isObj, safe, type State } from "./passive";
import type { DetectDrupalOptions } from "./types";

/** Where the site root is: explicit option, Drupal's own base path, drupal.js location, or `/`. */
export function resolveBase(options: Pick<DetectDrupalOptions, "baseUrl">, st: State): string | null {
  const href = pageHref(st);
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

export function pageHref(st: State): string | undefined {
  return safe(() => (st.win?.location?.href as string | undefined) ?? st.doc?.location?.href);
}
