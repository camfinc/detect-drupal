/** Expose `fn` as `detectDrupal` on the global object, unless something is already there. */
export function setGlobal<T extends (...args: any[]) => any>(fn: T, target: Record<string, any> = globalThis as any): T {
  if (typeof target.detectDrupal !== "function") target.detectDrupal = fn;
  return target.detectDrupal;
}
