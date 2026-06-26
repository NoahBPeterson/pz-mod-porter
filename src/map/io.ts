// Binary readers/writers for PZ map files. lotpack/lotheader are little-endian;
// chunkdata is big-endian (Java DataStream). A growable writer supports
// back-patching the chunk offset table.

const NL = 10; // '\n' terminates strings in lot files
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

export class ByteReader {
  readonly view: DataView;
  pos = 0;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get length(): number {
    return this.bytes.length;
  }
  seek(n: number): void {
    this.pos = n;
  }
  /** little-endian int32 */
  i32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  /** big-endian int16 */
  i16be(): number {
    const v = this.view.getInt16(this.pos, false);
    this.pos += 2;
    return v;
  }
  u8(): number {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }
  i8(): number {
    const v = this.view.getInt8(this.pos);
    this.pos += 1;
    return v;
  }
  /** Read a newline-terminated UTF-8 string. */
  line(): string {
    const start = this.pos;
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== NL) this.pos++;
    const s = dec.decode(this.bytes.subarray(start, this.pos));
    this.pos++; // skip newline
    return s;
  }
  /** If the next 4 bytes equal `magic`, consume them and return true; else stay. */
  matchMagic(magic: Uint8Array): boolean {
    if (this.pos + 4 > this.bytes.length) return false;
    for (let i = 0; i < 4; i++) if (this.bytes[this.pos + i] !== magic[i]) return false;
    this.pos += 4;
    return true;
  }
}

export class ByteWriter {
  private buf: Uint8Array;
  private dv: DataView;
  pos = 0;
  constructor(initial = 1 << 16) {
    this.buf = new Uint8Array(initial);
    this.dv = new DataView(this.buf.buffer);
  }
  private ensure(extra: number): void {
    const need = this.pos + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
    this.dv = new DataView(this.buf.buffer);
  }
  /** little-endian int32 */
  i32(v: number): void {
    this.ensure(4);
    this.dv.setInt32(this.pos, v, true);
    this.pos += 4;
  }
  /** big-endian int16 */
  i16be(v: number): void {
    this.ensure(2);
    this.dv.setInt16(this.pos, v, false);
    this.pos += 2;
  }
  u8(v: number): void {
    this.ensure(1);
    this.dv.setUint8(this.pos, v);
    this.pos += 1;
  }
  i8(v: number): void {
    this.ensure(1);
    this.dv.setInt8(this.pos, v);
    this.pos += 1;
  }
  raw(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }
  /** UTF-8 string + newline terminator. */
  str(s: string): void {
    this.raw(enc.encode(s));
    this.u8(NL);
  }
  /** Reserve `n` zero bytes (e.g. a table to back-patch later). */
  reserve(n: number): void {
    this.ensure(n);
    this.pos += n;
  }
  /** Back-patch a little-endian int32 at an absolute offset (already written). */
  i32At(at: number, v: number): void {
    this.dv.setInt32(at, v, true);
  }
  toBytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}
