// .lotheader: per-cell header holding the tile-name table, level range, room &
// building definitions, and a per-chunk zombie-density map. Ported from
// POTLotHeader.load/save. Coordinates are normalised to GLOBAL squares on read
// (rect.x += cellX*cellDim) so re-gridding is a coordinate re-bucketing.
import { ByteReader, ByteWriter } from './io.js';
import { LOTHEADER_MAGIC, type Grid } from './grid.js';

export interface RoomRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface MetaObj {
  type: number;
  /** stored relative to the room's bounds origin (as PZ does) */
  x: number;
  y: number;
}
export interface RoomDef {
  name: string;
  level: number;
  rects: RoomRect[];
  objects: MetaObj[];
  /** bounds origin in global squares */
  x: number;
  y: number;
}
export interface BuildingDef {
  rooms: RoomDef[];
  x: number;
  y: number;
}

export interface LotHeader {
  cellX: number;
  cellY: number;
  version: number;
  tilesUsed: string[];
  width: number;
  height: number;
  minLevel: number;
  maxLevel: number;
  rooms: RoomDef[];
  buildings: BuildingDef[];
  zombieDensity: Uint8Array;
  grid: Grid;
}

export function readLotHeader(bytes: Uint8Array, cellX: number, cellY: number, grid: Grid): LotHeader {
  const r = new ByteReader(bytes);
  r.matchMagic(LOTHEADER_MAGIC);
  const version = r.i32();
  if (version < 0 || version > 1) throw new Error(`lotheader: unsupported version ${version}`);

  const tilecount = r.i32();
  const tilesUsed: string[] = [];
  for (let i = 0; i < tilecount; i++) tilesUsed.push(r.line().trim());

  if (version === 0) r.u8(); // "alwaysZero"
  const width = r.i32();
  const height = r.i32();
  let minLevel: number;
  let maxLevel: number;
  if (version === 0) {
    minLevel = 0;
    maxLevel = r.i32();
  } else {
    minLevel = r.i32();
    maxLevel = r.i32();
  }

  const off = cellX * grid.cellDim;
  const offY = cellY * grid.cellDim;

  const numRooms = r.i32();
  const rooms: RoomDef[] = [];
  for (let n = 0; n < numRooms; n++) {
    const name = r.line();
    const level = r.i32();
    const numRects = r.i32();
    const rects: RoomRect[] = [];
    let rx = Number.MAX_SAFE_INTEGER;
    let ry = Number.MAX_SAFE_INTEGER;
    for (let k = 0; k < numRects; k++) {
      const x = r.i32() + off;
      const y = r.i32() + offY;
      const w = r.i32();
      const h = r.i32();
      rects.push({ x, y, w, h });
      if (x < rx) rx = x;
      if (y < ry) ry = y;
    }
    if (numRects === 0) {
      rx = off;
      ry = offY;
    }
    const numObjects = r.i32();
    const objects: MetaObj[] = [];
    for (let m = 0; m < numObjects; m++) {
      const type = r.i32();
      const x = r.i32() + off - rx;
      const y = r.i32() + offY - ry;
      objects.push({ type, x, y });
    }
    rooms.push({ name, level, rects, objects, x: rx, y: ry });
  }

  const numBuildings = r.i32();
  const buildings: BuildingDef[] = [];
  for (let n = 0; n < numBuildings; n++) {
    const numRooms2 = r.i32();
    const brooms: RoomDef[] = [];
    let bx = Number.MAX_SAFE_INTEGER;
    let by = Number.MAX_SAFE_INTEGER;
    for (let k = 0; k < numRooms2; k++) {
      const roomIndex = r.i32();
      const room = rooms[roomIndex];
      if (room) {
        brooms.push(room);
        if (room.x < bx) bx = room.x;
        if (room.y < by) by = room.y;
      }
    }
    buildings.push({ rooms: brooms, x: bx, y: by });
  }

  const nDensity = grid.chunksPerCell * grid.chunksPerCell;
  const zombieDensity = new Uint8Array(nDensity);
  for (let i = 0; i < nDensity && r.pos < r.length; i++) zombieDensity[i] = r.u8();

  return { cellX, cellY, version, tilesUsed, width, height, minLevel, maxLevel, rooms, buildings, zombieDensity, grid };
}

/** A B42 lotheader assembled by the re-grid driver, ready to serialise. */
export interface WritableLotHeader {
  cellX: number;
  cellY: number;
  tilesUsed: string[];
  width: number;
  height: number;
  minLevelNotEmpty: number;
  maxLevelNotEmpty: number;
  roomList: RoomDef[];
  buildings: BuildingDef[];
  zombieDensity: Uint8Array;
  grid: Grid;
}

export function writeLotHeader(h: WritableLotHeader): Uint8Array {
  const w = new ByteWriter();
  const minSquareX = h.cellX * h.grid.cellDim;
  const minSquareY = h.cellY * h.grid.cellDim;

  w.raw(LOTHEADER_MAGIC);
  w.i32(1); // version
  w.i32(h.tilesUsed.length);
  for (const t of h.tilesUsed) w.str(t);
  w.i32(h.width);
  w.i32(h.height);
  w.i32(h.minLevelNotEmpty);
  w.i32(h.maxLevelNotEmpty);

  w.i32(h.roomList.length);
  for (const room of h.roomList) {
    w.str(room.name);
    w.i32(room.level);
    w.i32(room.rects.length);
    for (const rect of room.rects) {
      w.i32(rect.x - minSquareX);
      w.i32(rect.y - minSquareY);
      w.i32(rect.w);
      w.i32(rect.h);
    }
    w.i32(room.objects.length);
    for (const o of room.objects) {
      w.i32(o.type);
      w.i32(o.x);
      w.i32(o.y);
    }
  }

  w.i32(h.buildings.length);
  for (const b of h.buildings) {
    w.i32(b.rooms.length);
    for (const room of b.rooms) w.i32(h.roomList.indexOf(room));
  }

  const nDensity = h.grid.chunksPerCell * h.grid.chunksPerCell;
  for (let i = 0; i < nDensity; i++) w.u8(h.zombieDensity[i] ?? 0);

  return w.toBytes();
}
