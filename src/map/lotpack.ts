// world_X_Y.lotpack: per-cell packed tile data. Each square holds a list of
// tile indices (into the lotheader's tilesUsed) plus a room id; empty squares
// are run-length-encoded (count == -1, then a skip count). Ported from
// IsoLot.load / POTLotPack.loadChunk + saveChunk. Decoded into GLOBAL square
// coordinates so the data can be re-bucketed into a different grid.
import { ByteReader, ByteWriter } from './io.js';
import { LOTPACK_MAGIC, type Grid } from './grid.js';
import type { LotHeader } from './lotheader.js';

/** One decoded square in global coordinates. */
export interface Square {
  gx: number;
  gy: number;
  z: number;
  tiles: string[];
}

export interface LotPack {
  cellX: number;
  cellY: number;
  /** flat list of non-empty squares (global coords) — array, not string-keyed */
  squares: Square[];
  minZ: number;
  maxZ: number;
}

export function readLotPack(bytes: Uint8Array, header: LotHeader, grid: Grid): LotPack {
  const r = new ByteReader(bytes);
  let version = 0;
  if (r.matchMagic(LOTPACK_MAGIC)) {
    version = r.i32();
    if (version < 0 || version > 1) throw new Error(`lotpack: unsupported version ${version}`);
  } else {
    r.seek(0);
  }

  const { chunkDim, chunksPerCell, cellDim } = grid;
  const squares: Square[] = [];
  let seenMinZ = Number.MAX_SAFE_INTEGER;
  let seenMaxZ = Number.MIN_SAFE_INTEGER;

  for (let lwx = 0; lwx < chunksPerCell; lwx++) {
    for (let lwy = 0; lwy < chunksPerCell; lwy++) {
      const index = lwx * chunksPerCell + lwy;
      r.seek((version >= 1 ? 8 : 0) + 4 + index * 8);
      const pos = r.i32();
      if (pos <= 0 || pos >= r.length) continue;
      r.seek(pos);

      const minZ = Math.max(header.minLevel, -32);
      let maxZ = Math.min(header.maxLevel, 31);
      if (version === 0) maxZ--;

      let skip = 0;
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = 0; x < chunkDim; x++) {
          for (let y = 0; y < chunkDim; y++) {
            if (skip > 0) {
              skip--;
              continue;
            }
            const count = r.i32();
            if (count === -1) {
              skip = r.i32();
              if (skip > 0) {
                skip--;
                continue;
              }
            }
            if (count <= 1) continue;
            r.i32(); // room id (unused for tiles)
            const tiles: string[] = [];
            for (let n = 1; n < count; n++) {
              const idx = r.i32();
              tiles.push(header.tilesUsed[idx] ?? '');
            }
            const gx = header.cellX * cellDim + lwx * chunkDim + x;
            const gy = header.cellY * cellDim + lwy * chunkDim + y;
            squares.push({ gx, gy, z, tiles });
            if (z < seenMinZ) seenMinZ = z;
            if (z > seenMaxZ) seenMaxZ = z;
          }
        }
      }
    }
  }

  return {
    cellX: header.cellX,
    cellY: header.cellY,
    squares,
    minZ: seenMinZ === Number.MAX_SAFE_INTEGER ? 0 : seenMinZ,
    maxZ: seenMaxZ === Number.MIN_SAFE_INTEGER ? 0 : seenMaxZ,
  };
}

/**
 * Serialise a B42 lotpack. `squareIndices(gx,gy,z)` returns the interned tile-
 * index list for a square (already resolved against the new header's tilesUsed)
 * or null for empty. zMin/zMax bound the non-empty level range.
 */
export function writeLotPack(
  cellX: number,
  cellY: number,
  grid: Grid,
  zMin: number,
  zMax: number,
  squareIndices: (gx: number, gy: number, z: number) => number[] | null,
): Uint8Array {
  const { chunkDim, chunksPerCell, cellDim } = grid;
  const numChunks = chunksPerCell * chunksPerCell;
  const w = new ByteWriter();
  w.raw(LOTPACK_MAGIC);
  w.i32(1); // version
  w.i32(chunkDim);
  const tableStart = w.pos;
  w.reserve(numChunks * 8); // chunk offset table (8 bytes/entry, low int used)

  for (let chunkX = 0; chunkX < chunksPerCell; chunkX++) {
    for (let chunkY = 0; chunkY < chunksPerCell; chunkY++) {
      const slot = tableStart + (chunkX * chunksPerCell + chunkY) * 8;
      w.i32At(slot, w.pos);
      let notdone = 0;
      for (let z = zMin; z <= zMax; z++) {
        for (let x = 0; x < chunkDim; x++) {
          for (let y = 0; y < chunkDim; y++) {
            const gx = cellX * cellDim + chunkX * chunkDim + x;
            const gy = cellY * cellDim + chunkY * chunkDim + y;
            const tiles = squareIndices(gx, gy, z);
            if (tiles === null || tiles.length === 0) {
              notdone++;
              continue;
            }
            if (notdone > 0) {
              w.i32(-1);
              w.i32(notdone);
              notdone = 0;
            }
            w.i32(tiles.length + 1);
            w.i32(-1); // room id
            for (const idx of tiles) w.i32(idx);
          }
        }
      }
      if (notdone > 0) {
        w.i32(-1);
        w.i32(notdone);
      }
    }
  }
  return w.toBytes();
}
