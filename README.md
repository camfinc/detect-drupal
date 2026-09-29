# detect-drupal

Detect whether a site runs Drupal, and which core version: from 6.0 to 12.x, in the browser or
in Node.

- **Passive** by default: reads what is already on the page (JS globals, DOM markers, asset URLs).
  Synchronous, no network.
- **Active** on request: fetches a few public core files and matches their content hashes against
  every Drupal core release ever published. This usually narrows a site down to a patch range, or
  the exact version.
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

**Node: check any site by URL**

There is no page to read in Node, so detection relies on active probing alone.

```js
import { detectDrupal } from "detect-drupal";

const result = await detectDrupal({ depth: "deep", baseUrl: "https://www.example.com/" });
```

## Depth

| `depth`               | Requests       | What it does |
| --------------------- | -------------- | --- |
| `"passive"` (default) | 0              | Guesswork from what is already on the page. **Synchronous.** |
| `"light"`             | up to 2        | Fetches the core files that best split the remaining candidate versions. |
| `"standard"`          | up to 5        | Same, with a bigger budget. |
| `"deep"`              | as many as help (max 40, typically 4–7) | Tries the files that state the exact version, then keeps probing until nothing narrows further. |
| a number              | that many      | Custom request budget. |

Every depth other than `"passive"` returns a Promise; `await` works for all of them. Probes are
chosen adaptively: each request goes to the file whose content best separates the versions still
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
| `depth`    | `"passive"`              | See [Depth](#depth). |
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
| `"deep"` from Node, no page at all | 3 (worst: 11) | median 5, max 7 |

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
