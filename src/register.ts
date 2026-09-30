import { detectDrupal } from "./detect";
import { setGlobal } from "./set-global";

/**
 * Expose `detectDrupal` as a global (`window.detectDrupal` / `globalThis.detectDrupal`).
 * Returns the function for convenience. Does not overwrite an existing global.
 */
export function register(target: Record<string, any> = globalThis as any): typeof detectDrupal {
  return setGlobal(detectDrupal, target);
}
