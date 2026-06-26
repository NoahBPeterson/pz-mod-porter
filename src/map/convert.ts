// B41 -> B42 map re-grid driver. Reads a map's baked cells (300-grid), decodes
// every square into global coordinates, re-buckets them into the B42 256-grid,
// and re-emits lotheader/lotpack/chunkdata. This is a faithful port of TIS's
// own zombie.pot.POT converter (which lives in the B42 jar but has no exposed
// trigger). Tile names flow through verbatim unless `renameTile` remaps them.
import { B41, B42 } from './grid.js';
import { readLotHeader, writeLotHeader, type LotHeader, type BuildingDef, type RoomDef } from './lotheader.js';
import { readLotPack, writeLotPack, type LotPack } from './lotpack.js';
import { readChunkData, writeChunkData, type ChunkData } from './chunkdata.js';
import { renameTile as defaultRenameTile, classifyTile, tilesheetOf } from './tile-renames.js';

export interface MapConvertOptions {
  /** Remap a B41 tile name to its B42 name, or null to drop it. Defaults to the
   *  evidence-backed table (drops removed trees, passes everything else). */
  renameTile?: (name: string) => string | null;
  /** Progress callback fired as destination cells are written. */
  onProgress?: (done: number, total: number) => void;
  /** Tilesheets the mod ships in its own .tiles defs — excluded from the
   *  "external dependency" list (they're the mod's own content, not deps). */
  ownSheets?: ReadonlySet<string>;
}

export interface MapConvertStats {
  oldCells: number;
  newCells: number;
  squares: number;
  tilesDropped: number;
  tilesRenamed: number;
  /** non-vanilla tilesheets the map references (mod's own + tile-pack deps),
   *  sorted by usage — surfaced so the user knows what B42 packs to install */
  externalSheets: string[];
}

export interface MapConvertResult {
  /** new basename ("32_60.lotheader" / "world_32_60.lotpack" / "chunkdata_32_60.bin") -> bytes */
  files: Map<string, Uint8Array>;
  stats: MapConvertStats;
  warnings: string[];
}

const cellKey = (x: number, y: number): string => `${x},${y}`;
// Perfect-hash a global square into one safe integer (gy < 100003, z in [-32,31]).
const sqKey = (gx: number, gy: number, z: number): number => (gx * 100003 + gy) * 64 + (z + 32);

const RE_LOTHEADER = /^(\d+)_(\d+)\.lotheader$/;
const RE_LOTPACK = /^world_(\d+)_(\d+)\.lotpack$/;
const RE_CHUNKDATA = /^chunkdata_(\d+)_(\d+)\.bin$/;

export function convertMapCells(input: Map<string, Uint8Array>, opts: MapConvertOptions = {}): MapConvertResult {
  const headerBytes = new Map<string, Uint8Array>();
  const packBytes = new Map<string, Uint8Array>();
  const chunkBytes = new Map<string, Uint8Array>();

  for (const [name, bytes] of input) {
    let m: RegExpExecArray | null;
    if ((m = RE_LOTHEADER.exec(name))) headerBytes.set(cellKey(+m[1]!, +m[2]!), bytes);
    else if ((m = RE_LOTPACK.exec(name))) packBytes.set(cellKey(+m[1]!, +m[2]!), bytes);
    else if ((m = RE_CHUNKDATA.exec(name))) chunkBytes.set(cellKey(+m[1]!, +m[2]!), bytes);
  }

  const warnings: string[] = [];
  const headerCache = new Map<string, LotHeader | null>();
  const packCache = new Map<string, LotPack | null>();
  const chunkCache = new Map<string, ChunkData | null>();

  const getOldHeader = (cx: number, cy: number): LotHeader | null => {
    const k = cellKey(cx, cy);
    if (headerCache.has(k)) return headerCache.get(k) ?? null;
    const b = headerBytes.get(k);
    let h: LotHeader | null = null;
    if (b) {
      try {
        h = readLotHeader(b, cx, cy, B41);
      } catch (e) {
        warnings.push(`lotheader ${k}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    headerCache.set(k, h);
    return h;
  };
  const getOldPack = (cx: number, cy: number): LotPack | null => {
    const k = cellKey(cx, cy);
    if (packCache.has(k)) return packCache.get(k) ?? null;
    const b = packBytes.get(k);
    const h = getOldHeader(cx, cy);
    let p: LotPack | null = null;
    if (b && h) {
      try {
        p = readLotPack(b, h, B41);
      } catch (e) {
        warnings.push(`lotpack ${k}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    packCache.set(k, p);
    return p;
  };
  const getOldChunk = (cx: number, cy: number): ChunkData | null => {
    const k = cellKey(cx, cy);
    if (chunkCache.has(k)) return chunkCache.get(k) ?? null;
    const b = chunkBytes.get(k);
    let c: ChunkData | null = null;
    if (b) {
      try {
        c = readChunkData(b, cx, cy, B41);
      } catch (e) {
        warnings.push(`chunkdata ${k}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    chunkCache.set(k, c);
    return c;
  };

  // Stream destination cells one at a time, decoding source cells lazily and
  // evicting them once the sweep moves past the rows they cover. This keeps the
  // working set to a couple of source-cell rows instead of the whole map, so a
  // 192-cell map converts in ~500MB instead of OOMing past 4GB.
  const rename = opts.renameTile ?? defaultRenameTile;
  const ownSheets = opts.ownSheets ?? new Set<string>();
  let tilesDropped = 0;
  let tilesRenamed = 0;
  const externalUse = new Map<string, number>();

  // Source-cell extent -> the destination cells that cover it (row-major).
  const oldKeys = [...packBytes.keys()].map((k) => k.split(',').map(Number) as [number, number]);
  let minOX = Infinity;
  let maxOX = -Infinity;
  let minOY = Infinity;
  let maxOY = -Infinity;
  for (const [x, y] of oldKeys) {
    if (x < minOX) minOX = x;
    if (x > maxOX) maxOX = x;
    if (y < minOY) minOY = y;
    if (y > maxOY) maxOY = y;
  }
  const D41 = B41.cellDim;
  const D42 = B42.cellDim;
  const candidates: [number, number][] = [];
  if (oldKeys.length > 0) {
    const ncXmin = Math.floor((minOX * D41) / D42);
    const ncXmax = Math.floor(((maxOX + 1) * D41 - 1) / D42);
    const ncYmin = Math.floor((minOY * D41) / D42);
    const ncYmax = Math.floor(((maxOY + 1) * D41 - 1) / D42);
    for (let ncy = ncYmin; ncy <= ncYmax; ncy++) {
      for (let ncx = ncXmin; ncx <= ncXmax; ncx++) {
        const oxMin = Math.floor((ncx * D42) / D41);
        const oxMax = Math.floor((ncx * D42 + D42 - 1) / D41);
        const oyMin = Math.floor((ncy * D42) / D41);
        const oyMax = Math.floor((ncy * D42 + D42 - 1) / D41);
        let overlaps = false;
        for (let oy = oyMin; oy <= oyMax && !overlaps; oy++)
          for (let ox = oxMin; ox <= oxMax; ox++)
            if (packBytes.has(cellKey(ox, oy))) {
              overlaps = true;
              break;
            }
        if (overlaps) candidates.push([ncx, ncy]);
      }
    }
  }

  // Evict cached source cells whose last covered destination row is behind us.
  const lastDestRow = (oy: number): number => Math.floor((oy * D41 + D41 - 1) / D42);
  const evictBelow = (destRow: number): void => {
    for (const cache of [headerCache, packCache, chunkCache]) {
      for (const k of cache.keys()) {
        const oy = +(k.split(',')[1] ?? '0');
        if (lastDestRow(oy) < destRow) cache.delete(k);
      }
    }
  };

  const files = new Map<string, Uint8Array>();
  let squares = 0;
  let newCells = 0;
  const total = candidates.length;
  let curRow = Number.NEGATIVE_INFINITY;

  for (let ci = 0; ci < candidates.length; ci++) {
    const [ncx, ncy] = candidates[ci]!;
    if (ncy !== curRow) {
      evictBelow(ncy);
      curRow = ncy;
    }
    opts.onProgress?.(ci, total);

    const minSqX = ncx * D42;
    const minSqY = ncy * D42;
    const maxSqX = minSqX + D42 - 1;
    const maxSqY = minSqY + D42 - 1;
    const oldMinX = Math.floor(minSqX / D41);
    const oldMinY = Math.floor(minSqY / D41);
    const oldMaxX = Math.floor(maxSqX / D41);
    const oldMaxY = Math.floor(maxSqY / D41);

    const tilesUsed: string[] = [];
    const tileIndex = new Map<string, number>();
    const getTileIndex = (name: string): number => {
      let i = tileIndex.get(name);
      if (i === undefined) {
        i = tilesUsed.length;
        tilesUsed.push(name);
        tileIndex.set(name, i);
      }
      return i;
    };

    // Gather this destination cell's squares from the overlapping source packs.
    const dataMap = new Map<number, number[]>();
    let minZ = 1000;
    let maxZ = -1000;
    for (let ocy = oldMinY; ocy <= oldMaxY; ocy++) {
      for (let ocx = oldMinX; ocx <= oldMaxX; ocx++) {
        const pack = getOldPack(ocx, ocy);
        if (!pack) continue;
        for (const sq of pack.squares) {
          if (sq.gx < minSqX || sq.gx > maxSqX || sq.gy < minSqY || sq.gy > maxSqY) continue;
          const out: number[] = [];
          for (const n of sq.tiles) {
            if (classifyTile(n) === 'external') {
              const sheet = tilesheetOf(n);
              if (!ownSheets.has(sheet)) externalUse.set(sheet, (externalUse.get(sheet) ?? 0) + 1);
            }
            const r = rename(n);
            if (r === null) {
              tilesDropped++;
              continue;
            }
            if (r !== n) tilesRenamed++;
            out.push(getTileIndex(r));
          }
          if (out.length === 0) continue;
          dataMap.set(sqKey(sq.gx, sq.gy, sq.z), out);
          if (sq.z < minZ) minZ = sq.z;
          if (sq.z > maxZ) maxZ = sq.z;
          squares++;
        }
      }
    }
    if (dataMap.size === 0) continue; // empty destination cell — skip
    newCells++;

    // buildings whose origin falls inside this new cell
    const roomList: RoomDef[] = [];
    const buildings: BuildingDef[] = [];
    for (let ocy = oldMinY; ocy <= oldMaxY; ocy++) {
      for (let ocx = oldMinX; ocx <= oldMaxX; ocx++) {
        const oh = getOldHeader(ocx, ocy);
        if (!oh) continue;
        for (const b of oh.buildings) {
          if (b.x < minSqX || b.x > maxSqX || b.y < minSqY || b.y > maxSqY) continue;
          const cloned: RoomDef[] = b.rooms.map((rm) => {
            const copy: RoomDef = { name: rm.name, level: rm.level, rects: rm.rects, objects: rm.objects, x: rm.x, y: rm.y };
            roomList.push(copy);
            return copy;
          });
          buildings.push({ rooms: cloned, x: b.x, y: b.y });
        }
      }
    }

    // zombie density: average the per-square old density into 32x32 new chunks
    const density = buildDensity(ncx, ncy, oldMinX, oldMaxX, oldMinY, oldMaxY, getOldHeader);

    const lotheader = writeLotHeader({
      cellX: ncx,
      cellY: ncy,
      tilesUsed,
      width: B42.chunkDim,
      height: B42.chunkDim,
      minLevelNotEmpty: minZ,
      maxLevelNotEmpty: maxZ,
      roomList,
      buildings,
      zombieDensity: density,
      grid: B42,
    });
    const lotpack = writeLotPack(ncx, ncy, B42, minZ, maxZ, (gx, gy, z) => dataMap.get(sqKey(gx, gy, z)) ?? null);
    const chunkdata = writeChunkData(ncx, ncy, B42, (gx, gy) => {
      const oc = getOldChunk(Math.floor(gx / B41.cellDim), Math.floor(gy / B41.cellDim));
      return oc ? oc.getBits(gx, gy) : 0;
    });

    files.set(`${ncx}_${ncy}.lotheader`, lotheader);
    files.set(`world_${ncx}_${ncy}.lotpack`, lotpack);
    files.set(`chunkdata_${ncx}_${ncy}.bin`, chunkdata);
  }

  opts.onProgress?.(total, total);
  const externalSheets = [...externalUse.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);

  return {
    files,
    stats: { oldCells: headerBytes.size, newCells, squares, tilesDropped, tilesRenamed, externalSheets },
    warnings,
  };
}

function buildDensity(
  ncx: number,
  ncy: number,
  oldMinX: number,
  oldMaxX: number,
  oldMinY: number,
  oldMaxY: number,
  getOldHeader: (cx: number, cy: number) => LotHeader | null,
): Uint8Array {
  const D = B42.cellDim; // 256
  const per = new Uint8Array(D * D);
  for (let ocy = oldMinY; ocy <= oldMaxY; ocy++) {
    for (let ocx = oldMinX; ocx <= oldMaxX; ocx++) {
      const oh = getOldHeader(ocx, ocy);
      if (!oh) continue;
      for (let y = 0; y < D; y++) {
        for (let x = 0; x < D; x++) {
          const gx = ncx * D + x;
          const gy = ncy * D + y;
          const v = zombieDensityForSquare(oh, gx, gy);
          if (v !== 0) per[x + y * D] = v;
        }
      }
    }
  }
  // average each 8x8 chunk
  const out = new Uint8Array(B42.chunksPerCell * B42.chunksPerCell);
  for (let cy = 0; cy < B42.chunksPerCell; cy++) {
    for (let cx = 0; cx < B42.chunksPerCell; cx++) {
      let sum = 0;
      for (let y = 0; y < B42.chunkDim; y++) {
        for (let x = 0; x < B42.chunkDim; x++) {
          sum += per[(cx * B42.chunkDim + x) + (cy * B42.chunkDim + y) * D] ?? 0;
        }
      }
      out[cx + cy * B42.chunksPerCell] = Math.floor(sum / (B42.chunkDim * B42.chunkDim));
    }
  }
  return out;
}

function zombieDensityForSquare(h: LotHeader, gx: number, gy: number): number {
  const minX = h.cellX * h.grid.cellDim;
  const minY = h.cellY * h.grid.cellDim;
  if (gx < minX || gy < minY || gx >= minX + h.grid.cellDim || gy >= minY + h.grid.cellDim) return 0;
  const cx = Math.floor((gx - minX) / h.grid.chunkDim);
  const cy = Math.floor((gy - minY) / h.grid.chunkDim);
  return h.zombieDensity[cx + cy * h.grid.chunksPerCell] ?? 0;
}
