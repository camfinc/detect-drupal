import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { detectDrupal } from "../src/index";
import { PROBES } from "../src/probes.generated";

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

  test("packaged system.info.yml on Drupal 8+", async () => {
    const { fetch } = stubFetch({
      "/sub/core/modules/system/system.info.yml": {
        body: "name: System\ntype: module\nversion: VERSION\n\n# Information added by Drupal.org packaging script on 2024-10-03\nversion: '10.3.6'\nproject: 'drupal'\n",
      },
    });
    const r = await detectDrupal({ depth: "deep", baseUrl: "https://site.test/sub", fetch });
    expect(r.version).toBe("10.3.6");
    expect(r.isDrupal).toBe(true);
  });

  test("Composer-built sites (version: VERSION only) fall through to hash probes", async () => {
    const { fetch, log } = stubFetch({
      "/core/modules/system/system.info.yml": { body: "name: System\ntype: module\nversion: VERSION\n" },
    });
    const r = await detectDrupal({ depth: "deep", baseUrl: "https://site.test/", fetch });
    expect(r.version).toBeNull();
    expect(log.length).toBeGreaterThan(2);
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
