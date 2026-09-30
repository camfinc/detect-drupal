import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import detectDefault, { detectDrupal, register } from "../src/index";

function page(html: string, globals: Record<string, unknown> = {}) {
  const w = new Window({ url: "https://example.com/" });
  w.document.write(`<!doctype html><html>${html}</html>`);
  Object.assign(w, globals);
  return { window: w as any, document: w.document as any };
}

const settingsTag = (s: object) =>
  `<script type="application/json" data-drupal-selector="drupal-settings-json">${JSON.stringify(s)}</script>`;

describe("non-Drupal pages", () => {
  test("empty page", () => {
    const r = detectDrupal(page("<head></head><body></body>"));
    expect(r).toEqual({ isDrupal: false, version: null, major: null, versionRange: null, confidence: 0, evidence: [], requests: 0 });
  });

  test("WordPress page with jQuery", () => {
    const r = detectDrupal(
      page(
        `<head><meta name="generator" content="WordPress 6.6"><script src="/wp-includes/js/jquery/jquery.min.js?ver=3.7.1"></script></head>`,
        { jQuery: { fn: { jquery: "3.7.1" } } },
      ),
    );
    expect(r.isDrupal).toBe(false);
    expect(r.version).toBeNull();
  });

  test("a lone /sites/default/ path is not enough", () => {
    const r = detectDrupal(page(`<head><link rel="stylesheet" href="/sites/default/files/custom.css"></head>`));
    expect(r.isDrupal).toBe(false);
    expect(r.confidence).toBeGreaterThan(0);
  });

  test("no window / document (SSR) does not throw", () => {
    expect(detectDrupal({ window: undefined, document: undefined }).isDrupal).toBe(false);
  });

  test("hostile getters do not throw", () => {
    const win: any = { document: undefined };
    Object.defineProperty(win, "Drupal", { get: () => { throw new Error("nope"); } });
    Object.defineProperty(win, "drupalSettings", { get: () => { throw new Error("nope"); } });
    expect(() => detectDrupal({ window: win })).not.toThrow();
  });
});

describe("HTML signals", () => {
  test("generator meta gives the major", () => {
    const r = detectDrupal(page(`<head><meta name="Generator" content="Drupal 10 (https://www.drupal.org)"></head>`));
    expect(r.isDrupal).toBe(true);
    expect(r.major).toBe(10);
    expect(r.version).toBe("10");
    expect(r.confidence).toBe(100);
  });

  test("?v= on unaggregated core JS gives the exact version", () => {
    const r = detectDrupal(
      page(
        `<head>${settingsTag({ path: { baseUrl: "/" } })}
         <script src="/core/assets/vendor/jquery/jquery.min.js?v=3.7.1"></script>
         <script src="/core/misc/drupal.js?v=10.3.6"></script>
         <script src="/core/misc/drupal.init.js?v=10.3.6"></script></head>`,
      ),
    );
    expect(r.version).toBe("10.3.6");
    expect(r.major).toBe(10);
    expect(r.versionRange).toEqual({ min: "10.3.6", max: "10.3.6" });
  });

  test("?v= newer than the fingerprint data is trusted as-is", () => {
    const r = detectDrupal(page(`<head><script src="/core/misc/drupal.js?v=13.1.2"></script></head>`));
    expect(r.version).toBe("13.1.2");
    expect(r.major).toBe(13);
  });

  test("library ?v= (jQuery's own version) is not mistaken for core", () => {
    const r = detectDrupal(page(`<head><script src="/core/assets/vendor/jquery/jquery.min.js?v=3.7.1"></script></head>`));
    expect(r.version).not.toBe("3.7.1");
  });

  test("on-demand aggregation (10.1+) with compressed ajaxPageState", () => {
    const r = detectDrupal(
      page(
        `<head>${settingsTag({ ajaxPageState: { libraries: "eJxLzs8rSc0rKc7PS8wvTs3Uy8nPS9dLzUsBAG5GCSk", theme: "olivero" } })}
         <script src="/sites/default/files/js/js_Ab12Cd.js?scope=footer&delta=0&language=en&theme=olivero&include=eJxLzs8"></script></head>`,
      ),
    );
    expect(r.isDrupal).toBe(true);
    expect(r.versionRange?.min).toBe("10.1.0");
    expect(r.major === null || r.major >= 10).toBe(true);
  });

  test("plain ajaxPageState.libraries narrows by core library availability", () => {
    const r = detectDrupal(
      page(`<head>${settingsTag({ ajaxPageState: { libraries: "core/drupal,core/drupal.message,olivero/global-styling", theme: "olivero" } })}</head>`),
    );
    // drupal.message: 8.7+, olivero: 9.1+, uncompressed list: < 10.1
    expect(r.versionRange).toEqual({ min: "9.1.0", max: "10.0.11" });
  });

  test("legacy Drupal 7 markup", () => {
    const r = detectDrupal(
      page(
        `<head><meta name="Generator" content="Drupal 7 (http://drupal.org)">
         <script src="https://example.com/misc/drupal.js?pz1x2c"></script>
         <link rel="stylesheet" href="https://example.com/sites/all/themes/zen/style.css"></head>`,
      ),
    );
    expect(r.major).toBe(7);
    expect(r.version).toBe("7");
  });

  test("new.drupal.org shape: custom file_assets_path, compressed libraries, no JS executed", () => {
    const r = detectDrupal(
      page(
        `<head><meta name="Generator" content="Drupal 11 (https://www.drupal.org)">
         <link rel="stylesheet" href="/assets/css/css_8ZsgqNfsjL-MsddZIbXjb68Mx3OddryxCkgMT5rE5xY.css?delta=0&language=en&theme=bluecheese&include=eJx1j">
         ${settingsTag({ path: { baseUrl: "/" }, ajaxPageState: { libraries: "eJx1j0EOgjAQRe8", theme: "bluecheese" } })}
         <script src="/core/assets/vendor/jquery/jquery.min.js?v=4.0.0"></script>
         <script src="/assets/js/js_9CkmneI36PFbktm9EAW4yQzYmtUKnFEbaiQDA1tms14.js?scope=header&delta=0&language=en&theme=bluecheese&include=eJx1j"></script></head>
         <body><a data-drupal-link-system-path="node/1" data-once="foo">x</a></body>`,
      ),
    );
    expect(r.isDrupal).toBe(true);
    expect(r.major).toBe(11);
    expect(r.version).toBe("11");
    expect(r.versionRange).toEqual({ min: "11.0.0", max: null });
    expect(r.evidence).toContain("Drupal aggregated assets ({js,css}/{js,css}_<hash>)");
  });

  test("data-drupal-* attributes alone mark a Drupal 8+ page", () => {
    const r = detectDrupal(page(`<body><form data-drupal-selector="user-login-form"></form></body>`));
    expect(r.isDrupal).toBe(true);
    expect(r.versionRange?.min).toBe("8.0.0");
  });
});

describe("runtime signals", () => {
  test("Drupal 7 globals", () => {
    const Drupal = {
      settings: { basePath: "/" },
      behaviors: { foo: { attach() {} } },
      locale: {},
      formatString() {},
      absoluteUrl() {},
      urlIsLocal() {},
      detachBehaviors() {},
      encodePath() {},
      freezeHeight() {},
      unfreezeHeight() {},
      getSelection() {},
      ajaxError() {},
      beforeUnloadCalled() {},
      displayAjaxError() {},
      stringReplace() {},
      sanitizeAjaxUrl() {},
    };
    const r = detectDrupal(page("<head></head>", { Drupal, jQuery: { fn: { jquery: "1.4.4" } } }));
    expect(r.isDrupal).toBe(true);
    expect(r.major).toBe(7);
    expect(r.versionRange?.min).toBe("7.73");
  });

  test("a stray polyfill does not override strong evidence", () => {
    const r = detectDrupal(
      page(`<head><meta name="Generator" content="Drupal 10 (https://www.drupal.org)"></head>`, {
        Drupal: { behaviors: {}, settings: {}, jsEnabled: true },
      }),
    );
    expect(r.major).toBe(10);
  });
});

describe("exports", () => {
  afterEach(() => {
    delete (globalThis as any).detectDrupal;
  });

  test("default export", () => {
    expect(detectDefault).toBe(detectDrupal);
  });

  test("register() exposes the global without clobbering", () => {
    const target: any = {};
    expect(register(target)).toBe(detectDrupal);
    expect(target.detectDrupal).toBe(detectDrupal);
    const other = () => null;
    const t2: any = { detectDrupal: other };
    expect(register(t2) as unknown).toBe(other);
  });
});

describe("passive-only build", () => {
  test("same passive result, never async, ignores depth", async () => {
    const { detectDrupal: passiveOnly } = await import("../src/passive-only");
    const p = page(`<head><meta name="Generator" content="Drupal 10 (https://www.drupal.org)"></head>`);
    const r = passiveOnly({ ...p, depth: "deep" } as any);
    expect(r).not.toBeInstanceOf(Promise);
    expect(r.major).toBe(10);
    expect(r.requests).toBe(0);
    expect(r.evidence.some((e) => e.includes("passive-only"))).toBe(true);
    expect({ ...r, evidence: [] }).toEqual({ ...detectDrupal(p), evidence: [] });
  });
});
