// Decode a text file's bytes to a string, handling the encodings B41 mods
// shipped in. B42 standardized on UTF-8, but B41 `.txt` translation files —
// especially non-English ones under `Translate/<LANG>/` — were often UTF-16
// (with or without a BOM) or a legacy single-/multi-byte charset chosen per
// language. Reading those as UTF-8 yields NUL-riddled garbage or U+FFFD, which
// is why ~7% of translation files used to fail to convert.
//
// Strategy, in order of confidence:
//   1. BOM (UTF-8 / UTF-16 LE / UTF-16 BE) — authoritative.
//   2. BOM-less UTF-16 — ASCII-range text interleaves NUL bytes; the NUL parity
//      tells LE (XX 00) from BE (00 XX).
//   3. Strict UTF-8 — if it decodes without error, it really is UTF-8 (covers
//      all modern/ASCII files, including legitimately-accented UTF-8).
//   4. Legacy charset keyed by the `Translate/<LANG>/` directory, else 1252.
// The converter re-emits every text file as UTF-8, so this only ever improves
// fidelity (correct glyphs instead of replacement characters).

// PZ language code -> legacy charset, for files that are neither UTF-8 nor
// UTF-16. Mirrors the Windows code pages B41 used per language.
const LANG_CHARSET: Readonly<Record<string, string>> = {
  RU: 'windows-1251', UA: 'windows-1251',
  CN: 'gbk', CH: 'big5', KO: 'euc-kr', JP: 'shift_jis',
  PL: 'windows-1250', CS: 'windows-1250', HU: 'windows-1250', RO: 'windows-1250',
  TR: 'windows-1254', TH: 'windows-874', AR: 'windows-1256',
  EN: 'windows-1252', ES: 'windows-1252', FR: 'windows-1252', DE: 'windows-1252',
  IT: 'windows-1252', PT: 'windows-1252', PTBR: 'windows-1252', NL: 'windows-1252',
  DA: 'windows-1252', FI: 'windows-1252', NO: 'windows-1252', CA: 'windows-1252',
  ID: 'windows-1252', PH: 'windows-1252',
};

function langFromPath(path: string): string | undefined {
  const m = /Translate\/([^/]+)\//i.exec(path.replace(/\\/g, '/'));
  return m?.[1]?.toUpperCase();
}

function decode(label: string, bytes: Uint8Array, fatal = false): string {
  return new TextDecoder(label, { fatal }).decode(bytes);
}

export function decodeText(bytes: Uint8Array, path = ''): string {
  const n = bytes.length;

  // 1) Byte-order marks.
  if (n >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return decode('utf-8', bytes.subarray(3));
  if (n >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return decode('utf-16le', bytes.subarray(2));
  if (n >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return decode('utf-16be', bytes.subarray(2));

  // 2) BOM-less UTF-16: ASCII text leaves a NUL in every other byte. NULs on
  //    even offsets => big-endian (00 XX); on odd offsets => little-endian.
  const sample = Math.min(n, 1000);
  let nul = 0, nulEven = 0;
  for (let i = 0; i < sample; i++) if (bytes[i] === 0) { nul++; if (i % 2 === 0) nulEven++; }
  if (sample > 0 && nul / sample > 0.2) {
    return decode(nulEven >= nul - nulEven ? 'utf-16be' : 'utf-16le', bytes);
  }

  // 3) Strict UTF-8.
  try { return decode('utf-8', bytes, true); } catch { /* not UTF-8 */ }

  // 4) Legacy charset by language (default Western/1252). Never throws.
  const charset = LANG_CHARSET[langFromPath(path) ?? ''] ?? 'windows-1252';
  try { return decode(charset, bytes); } catch { return decode('utf-8', bytes); }
}
