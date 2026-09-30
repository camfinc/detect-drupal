import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { detectDrupal } from "../src/index";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FINGERPRINTS } from "../src/fingerprints.generated";
import { PROBES } from "../src/probes.generated";

const FINGER = FINGERPRINTS.releases;

type Routes = Record<string, { status?: number; body: string; type?: string }>;

function stubFetch(routes: Routes) {
  const log: string[] = [];
  const fetch = async (url: string) => {
    const path = new URL(url).pathname;
    log.push(path);
    const r = routes[path];
    if (!r) return new Response("<!doctype html><title>Not found</title>", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/plain" } });
  };
  return { fetch, log };
}

describe("depth", () => {
  test("passive is synchronous and makes no requests", () => {
    const { fetch, log } = stubFetch({});
    const r = detectDrupal({ window: {}, fetch });
    expect(r).not.toBeInstanceOf(Promise);
    expect(r.requests).toBe(0);
    expect(log).toEqual([]);
  });

  test("active depths return a Promise and respect their request budget", async () => {
    for (const [depth, max] of [["light", 2], ["standard", 5], [3, 3]] as const) {
      const { fetch, log } = stubFetch({});
      const p = detectDrupal({ depth, baseUrl: "https://site.test/", fetch });
      expect(p).toBeInstanceOf(Promise);
      const r = await p;
      expect(r.requests).toBeLessThanOrEqual(max);
      expect(log.length).toBe(r.requests);
      expect(r.isDrupal).toBe(false);
    }
  });

  test("without a base URL (Node, no page) the active scan is skipped, not failed", async () => {
    const r = await detectDrupal({ depth: "deep", fetch: stubFetch({}).fetch });
    expect(r.requests).toBe(0);
    expect(r.evidence.join()).toContain("no base URL");
  });

  test("a throwing fetch never rejects", async () => {
    const r = await detectDrupal({
      depth: "standard",
      baseUrl: "https://site.test/",
      fetch: async () => {
        throw new Error("network down");
      },
    });
    expect(r.isDrupal).toBe(false);
  });
});

describe("exact-version files (deep)", () => {
  test("Drupal 7 CHANGELOG.txt", async () => {
    const w = new Window({ url: "https://site.test/node/1" });
    w.document.write(`<html><head><meta name="Generator" content="Drupal 7 (http://drupal.org)"><script src="/misc/drupal.js?abc"></script></head></html>`);
    const { fetch } = stubFetch({ "/CHANGELOG.txt": { body: "\nDrupal 7.101, 2024-06-05\n-----------------------\n- Fixed things.\n" } });
    const r = await detectDrupal({ window: w as any, document: w.document as any, depth: "deep", fetch });
    expect(r.version).toBe("7.101");
    expect(r.versionRange).toEqual({ min: "7.101", max: "7.101" });
  });

  test("Drupal 8+: a deep scan only ever requests public JS/CSS files", async () => {
    const w = new Window({ url: "https://site.test/node/1" });
    w.document.write(`<html><head><meta name="Generator" content="Drupal 11 (https://www.drupal.org)"></head></html>`);
    const { fetch, log } = stubFetch({});
    const r = await detectDrupal({ window: w as any, document: w.document as any, depth: "deep", fetch });
    expect(r.requests).toBeGreaterThan(0);
    expect(log.filter((p) => !/\.(js|css)$/.test(p))).toEqual([]);
  });

  test("CHANGELOG.txt is requested only once hash probes show Drupal 6/7", async () => {
    // Serve the real 7.101 misc/drupal.js so its hash matches a known release.
    const real = join(import.meta.dir, "..", ".cache", "releases", "7.101", "misc/drupal.js");
    if (!existsSync(real)) return; // needs the research cache
    const { fetch, log } = stubFetch({
      "/misc/drupal.js": { body: readFileSync(real, "utf8") },
      "/CHANGELOG.txt": { body: "\nDrupal 7.101, 2024-06-05\n----\n" },
    });
    const r = await detectDrupal({ depth: "deep", baseUrl: "https://site.test/", fetch });
    expect(log).toContain("/CHANGELOG.txt");
    expect(log.indexOf("/CHANGELOG.txt")).toBeGreaterThan(log.indexOf("/misc/drupal.js"));
    expect(r.version).toBe("7.101");
  });
});

describe("hash probes", () => {
  test("a 200 HTML catch-all page counts as missing, not as a match", async () => {
    const path = Object.keys(PROBES)[0]!;
    const { fetch } = stubFetch({ ["/" + path]: { body: "<!doctype html><html><body>Home</body></html>", type: "text/html; charset=utf-8" } });
    const r = await detectDrupal({ depth: "light", baseUrl: "https://site.test/", fetch });
    expect(r.isDrupal).toBe(false);
  });

  test("an unknown (patched) file is reported but does not constrain", async () => {
    const routes: Routes = {};
    for (const p of Object.keys(PROBES)) routes["/" + p] = { body: "/* patched */" };
    const r = await detectDrupal({ depth: "light", baseUrl: "https://site.test/", fetch: stubFetch(routes).fetch });
    expect(r.evidence.some((e) => e.includes("unknown content"))).toBe(true);
    expect(r.versionRange).toBeNull();
  });
});

describe("cached depth (already-loaded files, no network)", () => {
  const release = (v: string) => join(import.meta.dir, "..", ".cache", "releases", v);
  const haveCache = existsSync(release("7.50"));

  function cachedPage(version: string, files: string[], query: string) {
    const dir = release(version);
    const w = new Window({ url: "https://site.test/node/1" });
    const tags = files
      .map((f) => (f.endsWith(".css") ? `<link rel="stylesheet" href="/${f}?${query}">` : `<script src="/${f}?${query}"></script>`))
      .join("");
    w.document.write(`<html><head>${tags}</head></html>`);
    const log: { url: string; init?: RequestInit }[] = [];
    (w as any).fetch = async (url: string, init?: RequestInit) => {
      log.push({ url, init });
      if (init?.cache !== "only-if-cached") throw new Error("network fetch");
      const path = new URL(url).pathname.slice(1);
      return existsSync(join(dir, path)) ? new Response(readFileSync(join(dir, path), "utf8")) : new Response("", { status: 504 });
    };
    return { w, log };
  }

  test.skipIf(!haveCache)("Drupal 7: cached misc/*.js + system CSS narrow within 7.x, zero requests", async () => {
    const { w, log } = cachedPage("7.50", ["misc/drupal.js", "misc/jquery.once.js", "modules/system/system.base.css", "modules/system/system.theme.css"], "o8z1k2");
    const passive = detectDrupal({ window: w as any, document: w.document as any });
    const cached = await detectDrupal({ window: w as any, document: w.document as any, depth: "cached" });
    expect(cached.requests).toBe(0);
    expect(log.every((l) => l.init?.cache === "only-if-cached")).toBe(true);
    expect(cached.evidence.some((e) => e.startsWith("cached misc/drupal.js: matches"))).toBe(true);
    const width = (r: typeof cached) => FINGER.indexOf(r.versionRange!.max ?? "7.103") - FINGER.indexOf(r.versionRange!.min);
    expect(width(cached)).toBeLessThan(width(passive));
    expect(FINGER.indexOf(cached.versionRange!.min)).toBeLessThanOrEqual(FINGER.indexOf("7.50"));
  });

  test("an active depth does not re-request files already read from the cache", async () => {
    const path = "misc/drupal.js";
    const w = new Window({ url: "https://site.test/" });
    w.document.write(`<html><head><script src="/${path}?x"></script></head></html>`);
    const network: string[] = [];
    // One fetch for both kinds of read: cache-only reads hit, everything else is "network".
    const fetch = async (url: string, init?: RequestInit) => {
      if (init?.cache === "only-if-cached") return new Response("/* cached copy */");
      network.push(new URL(url).pathname.slice(1));
      return new Response("", { status: 404 });
    };
    const r = await detectDrupal({ window: w as any, document: w.document as any, depth: "standard", fetch });
    expect(r.evidence.some((e) => e.startsWith(`cached ${path}`))).toBe(true);
    expect(network).not.toContain(path);
  });
});
