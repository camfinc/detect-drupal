# detect-drupal

Detect whether a site runs Drupal, and which core version: from 6.0 to 12.x, in the browser or
in Node.

- **Passive** by default: reads what is already on the page (JS globals, DOM markers, asset URLs).
  Synchronous, no network.
- **Cached** on request: re-reads the core files the page has *already loaded* from the browser
  cache and matches their content hashes. Still no network.
- **Active** on request: fetches a few public core files and matches their content hashes against
  every Drupal core release ever published. This usually narrows a site down to a patch range, or
  the exact version.
- A **no-network build** to inject into a live page: passive and cached only. It has no code path
  that sends a request.
- Fingerprints are **generated from the real releases**, not written by hand: all 532 core
  tarballs from 6.0 to 12.0.0-alpha1 are downloaded, diffed and hashed.

```js
import detectDrupal from "detect-drupal";

detectDrupal();
// { isDrupal: true, version: "10", major: 10, versionRange: { min: "10.2.0", max: null },
//   confidence: 100, evidence: [...], requests: 0 }

await detectDrupal({ depth: "deep" }); // e.g. on new.drupal.org
// { isDrupal: true, version: "11.4", major: 11, versionRange: { min: "11.4.6", max: "11.4.7" },
//   confidence: 100, evidence: [...], requests: 5 }
```

## Install

```sh
npm install detect-drupal
```

(or `bun add`, `pnpm add`, `yarn add`)

## Usage

**ES modules / bundlers**

```js
import detectDrupal from "detect-drupal"; // or: import { detectDrupal } from "detect-drupal";
```

**CommonJS**

```js
const { detectDrupal } = require("detect-drupal");
```

**Classic `<script>`**: registers `window.detectDrupal`.

```html
<script src="https://cdn.jsdelivr.net/npm/detect-drupal/dist/detect-drupal.min.js"></script>
<script>
  console.log(detectDrupal());
</script>
```

**Register the global from a bundle**

```js
import "detect-drupal/global"; // side effect: globalThis.detectDrupal = detectDrupal

// or explicitly (never overwrites an existing global):
import { register } from "detect-drupal";
register();
```

The main entry has no side effects, so bundlers can tree-shake it.

**No-network build**

```js
import { detectDrupal } from "detect-drupal/passive"; // CommonJS: require("detect-drupal/passive")

detectDrupal();                            // passive, synchronous
await detectDrupal({ depth: "cached" });   // + already-loaded files from the browser cache
```

It has the same passive and cached detection as the main entry, but the active scan is left out
of the bundle. Its types only accept `"passive"` and `"cached"`. From plain JS, `"light"`,
`"standard"` and `"deep"` are treated as `"cached"`.

**Node: check any site by URL**

There is no page to read in Node, so detection relies on active probing alone.

```js
import { detectDrupal } from "detect-drupal";

const result = await detectDrupal({ depth: "deep", baseUrl: "https://www.example.com/" });
```

## Injecting into a live page

`dist/detect-drupal.passive.min.js` is a self-contained script (21 kB gzipped) that registers
`window.detectDrupal` on whatever page it runs in, without overwriting an existing one. It never
sends a request:

- `detectDrupal()` reads the page only (synchronous).
- `await detectDrupal({ depth: "cached" })` also re-reads the core files the page already loaded
  (e.g. `misc/drupal.js`, system CSS) from the browser cache and matches their content hashes. It
  uses `fetch(url, { cache: "only-if-cached", mode: "same-origin" })`, which the Fetch standard
  defines as cache-only: a cache miss fails instead of going to the network. This helps most on
  Drupal 6/7 and on sites with CSS aggregation off. Aggregated bundles can't be matched.

| Where | How |
| --- | --- |
| DevTools console | Paste the file's contents, then run `detectDrupal()`. |
| Script tag | `<script src="https://cdn.jsdelivr.net/npm/detect-drupal/dist/detect-drupal.passive.min.js"></script>` |
| Browser extension | `chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["detect-drupal.passive.min.js"] })`, then read the result with a second `executeScript` in the `MAIN` world. |
| Puppeteer / Playwright | `await page.addScriptTag({ path: require.resolve("detect-drupal/classic-passive") })`, then `await page.evaluate(() => detectDrupal())`. |

Two caveats:

- **Use the page's main world.** Extension content scripts run in an isolated world by default,
  where `window.Drupal` and `drupalSettings` are not visible. Only the DOM signals would work
  there.
- **Content Security Policy.** Strict CSPs block script tags from a CDN. The console, extension
  `MAIN`-world injection and automation tools are not affected.
- **Browser cache.** `"cached"` finds nothing if the files weren't cached, e.g. with DevTools'
  "Disable cache" on, or when the server sends `Cache-Control: no-store`.

`dist/detect-drupal.min.js` is the full classic build (22 kB gzipped). It is also injectable;
use it when the page should be able to run active scans too (`await detectDrupal({ depth: "light" })`).
Those requests go to the page's own origin.

## Depth

| `depth`               | Requests       | What it does |
| --------------------- | -------------- | --- |
| `"passive"` (default) | 0              | Guesswork from what is already on the page. **Synchronous.** |
| `"cached"`            | 0              | Also re-reads core files the page already loaded from the browser cache and matches their hashes. |
| `"light"`             | up to 2        | Cached, plus fetches the core files that best split the remaining candidate versions. |
| `"standard"`          | up to 5        | Same, with a bigger budget. |
| `"deep"`              | as many as help (max 40, typically 4–7) | Tries the files that state the exact version, then keeps probing until nothing narrows further. |
| a number              | that many      | Custom request budget. |

Every depth other than `"passive"` returns a Promise; `await` works for all of them. Active
depths start with the free cache read, and never request a file they already read that way. Probes
are chosen adaptively: each request goes to the file whose content best separates the versions still
in the running.

Active probes request plain static files (`core/misc/ajax.js`, theme CSS, …) from the site root.
They send the page's own cookies only for same-origin requests. From a browser page, requests to
another origin are subject to CORS; in Node there is no such restriction.

## API

### `detectDrupal(options?)`

Never throws and never rejects. It is safe to call before or after Drupal's own scripts run, and
during SSR.

| Option     | Default                  | |
| ---------- | ------------------------ | --- |
| `depth`    | `"passive"`              | See [Depth](#depth). The no-network build accepts `"passive"` and `"cached"`. |
| `window`   | global `window`          | Window-like object to inspect, e.g. an iframe's `contentWindow`. |
| `document` | `window.document`        | Document to inspect. |
| `baseUrl`  | the site's own base path | Site root for active probes. Required in Node. |
| `fetch`    | global `fetch`           | Custom fetch implementation, e.g. to add headers or a proxy. |
| `timeout`  | `8000`                   | Per-request timeout in milliseconds. |

### Result

| Field          | Type | |
| -------------- | --- | --- |
| `isDrupal`     | `boolean` | `true` when `confidence >= 50`. |
| `version`      | `string \| null` | The most precise version all remaining candidates share: `"10.3.6"`, `"10.3"`, `"10"`, `"7.103"`, `"7"`. Always a single version, never a range. `null` when not Drupal, or when the evidence spans several majors. |
| `major`        | `number \| null` | Set when every candidate has the same major version. |
| `versionRange` | `{ min: string; max: string \| null } \| null` | Oldest and newest known releases that fit the evidence. `max: null` means the site may also run a release newer than this package knows about. |
| `confidence`   | `number` | 0–100. |
| `evidence`     | `string[]` | Human-readable list of the signals that were found. |
| `requests`     | `number` | Network requests made. |

TypeScript types are included: `DrupalDetection`, `DetectDrupalOptions`, `DetectDepth`.

## How it works

Every known release starts as a candidate. Each signal penalises the releases it contradicts,
weighted by how trustworthy the signal is. The releases with the lowest total penalty win. One odd
signal, such as a contrib module polyfilling an API or a theme swapping jQuery, cannot derail the
result.

| Signal | Tells us |
| --- | --- |
| `?v=X.Y.Z` on unaggregated core JS | exact version (8.0+) |
| Exact version in `CHANGELOG.txt` (6/7) or a packaged `system.info.yml` (8+) | exact version, when the site exposes them (deep only) |
| Content hash of a public core file | the releases that shipped that exact file |
| `<meta name="Generator" content="Drupal N">` | major version (7.0+) |
| `core/…` vs `misc/drupal.js` paths, `drupalSettings` vs `Drupal.settings`, `data-drupal-*` | 8+ vs 6/7 |
| `Drupal.*`, `jQuery.fn.*` and `once` APIs present on the page | the releases that define them |
| APIs from `drupal.js` missing while `window.Drupal` exists | rules out the releases that always define them |
| Active theme, core library names, on-demand aggregation URLs, `data-once` | the releases that shipped them |
| Bundled jQuery version | tie-breaker only |

## Accuracy

The test suite runs the built package against the real JavaScript of all 532 releases. For
passive checks it runs that JS in a simulated browser. For active probes it uses a simulated site
serving that release's files. The reported range contains the true release in every case.

| Scenario | Median candidate releases | Requests |
| --- | --- | --- |
| Passive, core JS loaded, no version in URLs | ~30 (usually one minor) | 0 |
| Passive, unaggregated core assets (`?v=`) | 1 (exact) | 0 |
| `"light"` on a page with Drupal's JS | 4 | 2 |
| `"standard"` on an HTML-only page | 3 | ≤ 5 |
| `"cached"`, Drupal 6/7 page (HTML only, JS not run) | 11 (passive alone: 99) | 0 |
| `"deep"` from Node, no page at all | 3 (worst: 11) | median 5, max 9 |

On live sites:

- **www.drupal.org** (Drupal 7): `"deep"` gives exactly `7.103` in 1 request, from its
  `CHANGELOG.txt`.
- **new.drupal.org** (Drupal 11): `"deep"` gives `11.4.6 – 11.4.7` in 5 requests.

## Limitations

- Passive detection cannot see HTTP headers (`X-Generator`), and production sites usually
  aggregate JS, which hides the `?v=` version. Passive results are therefore often a minor or
  major range. Use an active depth to narrow them.
- Some consecutive patch releases ship byte-identical public files (e.g. 8.7.4–8.7.14 or
  10.5.2–10.5.12). No amount of probing separates those.
- Hash probes need unmodified core files. Patched files are reported in `evidence` and otherwise
  ignored. Blocked requests (403, timeouts) are ignored too. A plain 404 counts as weak evidence
  that the file isn't part of that release, so a site that 404s everything under `/core/` gets
  less precise active results.
- Drupal's default `.htaccess` blocks `.yml` files, so the `system.info.yml` check mostly works on
  misconfigured servers. Composer-built sites carry no version in that file at all.
- Versions released after this package was built appear as "newer" (`max: null`) until the
  fingerprints are refreshed.

## Development

Requires [Bun](https://bun.sh) (package manager and scripts) and Node 20.11+ (for the dist tests).

```sh
bun install --frozen-lockfile
bun run research        # download every core release into .cache/ and regenerate fingerprints (~2 GB)
bun run build           # dist/: ESM, CJS, classic IIFE (+ .min), .d.ts/.d.cts
bun test                # unit tests
bun run test:dist       # build, then entry-point and ground-truth tests under Node
```

`src/fingerprints.generated.ts` is generated by `bun run research`. To refresh it after new Drupal
releases, run `bun run research && bun run test:dist` and publish a patch version.
`research/REPORT.md` lists every marker, jQuery version, theme and probe file with the releases it
appears in.

## License

[MIT](LICENSE)
