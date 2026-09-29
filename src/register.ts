import { detectDrupal } from "./detect";

/**
 * Expose `detectDrupal` as a global (`window.detectDrupal` / `globalThis.detectDrupal`).
 * Returns the function for convenience. Does not overwrite an existing global.
 */
export function register(target: Record<string, any> = globalThis as any): typeof detectDrupal {
  if (typeof target.detectDrupal !== "function") target.detectDrupal = detectDrupal;
  return target.detectDrupal;
}
