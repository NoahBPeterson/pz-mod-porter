// chunkdata_X_Y.bin: per-square navigation/room bit flags, one byte per square,
// grouped by chunk with a per-chunk "uniform type" shortcut. BIG-ENDIAN (Java
// DataStream). Ported from POTChunkData. Decoded to a global getBits(gx,gy).
import { ByteReader, ByteWriter } from './io.js';
import type { Grid } from './grid.js';

// uniform chunk type byte -> the single bits value it represents
const TYPE_TO_BITS: Record<number, number> = { 0: 0, 1: 1, 3: 8, 4: 16 };
// bits value -> uniform type (else 2 = "regular", needs per-square bytes)
function typeOf(bits: number): number {
  if (bits === 0) return 0;
  if (bits === 1) return 1;
  if (bits === 8) return 3;
  if (bits === 16) return 4;
  return 2;
}

interface ChunkBits {
  uniform: number | null;
  bits: Uint8Array | null;
}

export interface ChunkData {
  cellX: number;
  cellY: number;
  getBits(gx: number, gy: number): number;
}

export function readChunkData(bytes: Uint8Array, cellX: number, cellY: number, grid: Grid): ChunkData {
  const r = new ByteReader(bytes);
  const version = r.i16be();
  if (version !== 1) throw new Error(`chunkdata: unexpected version ${version}`);
  const { chunkDim, chunksPerCell, cellDim } = grid;
  const nSqrs = chunkDim * chunkDim;
  const chunks: ChunkBits[] = new Array<ChunkBits>(chunksPerCell * chunksPerCell);

  for (let y = 0; y < chunksPerCell; y++) {
    for (let x = 0; x < chunksPerCell; x++) {
      const type = r.u8();
      if (type === 2) {
        const bits = new Uint8Array(nSqrs);
        for (let i = 0; i < nSqrs; i++) bits[i] = r.u8();
        chunks[x + y * chunksPerCell] = { uniform: null, bits };
      } else {
        chunks[x + y * chunksPerCell] = { uniform: TYPE_TO_BITS[type] ?? 0, bits: null };
      }
    }
  }

  const minX = cellX * cellDim;
  const minY = cellY * cellDim;
  return {
    cellX,
    cellY,
    getBits(gx, gy) {
      const lx = gx - minX;
      const ly = gy - minY;
      if (lx < 0 || ly < 0 || lx >= cellDim || ly >= cellDim) return 0;
      const chunk = chunks[Math.floor(lx / chunkDim) + Math.floor(ly / chunkDim) * chunksPerCell];
      if (!chunk) return 0;
      if (chunk.uniform !== null) return chunk.uniform;
      return chunk.bits?.[(lx % chunkDim) + (ly % chunkDim) * chunkDim] ?? 0;
    },
  };
}

export function writeChunkData(
  cellX: number,
  cellY: number,
  grid: Grid,
  getBits: (gx: number, gy: number) => number,
): Uint8Array {
  const { chunkDim, chunksPerCell, cellDim } = grid;
  const nSqrs = chunkDim * chunkDim;
  const w = new ByteWriter(1 << 14);
  w.i16be(1);

  for (let cy = 0; cy < chunksPerCell; cy++) {
    for (let cx = 0; cx < chunksPerCell; cx++) {
      const local = new Uint8Array(nSqrs);
      for (let ly = 0; ly < chunkDim; ly++) {
        for (let lx = 0; lx < chunkDim; lx++) {
          const gx = cellX * cellDim + cx * chunkDim + lx;
          const gy = cellY * cellDim + cy * chunkDim + ly;
          local[lx + ly * chunkDim] = getBits(gx, gy) & 0xff;
        }
      }
      // uniform only if every square shares one pure-type bits value
      const first = local[0] ?? 0;
      let uniform = typeOf(first) !== 2;
      if (uniform) {
        for (let i = 1; i < nSqrs; i++) {
          if (local[i] !== first) {
            uniform = false;
            break;
          }
        }
      }
      if (uniform) {
        w.u8(typeOf(first));
      } else {
        w.u8(2);
        w.raw(local);
      }
    }
  }
  return w.toBytes();
}
