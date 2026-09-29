/**
 * Content hash for public core assets: FNV-1a (32-bit) over UTF-16 code units,
 * after dropping a BOM and normalising line endings. Returned in base 36.
 *
 * Shared by the research script (Node, reading release tarballs) and the
 * browser (hashing fetched files), so both sides must stay byte-for-byte equal.
 */
export function assetHash(text: string): string {
  const s = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
