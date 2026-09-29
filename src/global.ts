/**
 * Side-effect entry: registers `detectDrupal` on the global object.
 * Used by `import "detect-drupal/global"` / `require("detect-drupal/global")`.
 */
import { detectDrupal as detect } from "./detect";
import { register } from "./register";

register();

declare global {
  // eslint-disable-next-line no-var
  var detectDrupal: typeof import("./detect").detectDrupal;
}

// A local binding rather than a re-export: Bun's bundler mis-renames re-exported imports.
export const detectDrupal = detect;
export default detect;
export type { DetectDrupalOptions, DrupalDetection, DrupalVersionRange } from "./types";
