// Extract the tilesheet names a mod DEFINES from its shipped .tiles definition
// files (binary, magic "tdef"). Each tileset entry stores its name immediately
// followed by "<name>.png"; we scan for those ".png" tokens. A tilesheet a map
// references that is defined here is the mod's OWN content (textures live in the
// mod's .pack), not an external tile-pack dependency.

const dec = new TextDecoder('latin1');

/** Tilesheet names ("*.png" stems) defined in a binary .tiles file. */
export function extractTilesheets(bytes: Uint8Array): Set<string> {
  const sheets = new Set<string>();
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x2e && bytes[i + 1] === 0x70 && bytes[i + 2] === 0x6e && bytes[i + 3] === 0x67) {
      // ".png" — walk back over printable bytes to the token start
      let s = i;
      while (s > 0) {
        const b = bytes[s - 1]!;
        if (b < 0x20 || b > 0x7e) break;
        s--;
      }
      if (s < i) {
        const name = dec.decode(bytes.subarray(s, i)).trim();
        if (name.length > 0) sheets.add(name);
      }
    }
  }
  return sheets;
}
