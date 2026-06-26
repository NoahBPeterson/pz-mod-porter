// Reproject a map's coordinate-bearing metadata from the B41 300-cell grid to
// the B42 256-cell grid. The global square coordinate space is invariant, so
// only CELL-relative coordinates move.
//
//   objects.lua     — global square coords -> unchanged (handled by passthrough)
//   spawnregions.lua — only file paths -> unchanged
//   spawnpoints.lua — worldX/worldY (cell) + posX/posY (cell-relative) -> reproject
//   worldmap.xml    — <cell x y> + cell-relative <point> -> re-bucket per POTWorldMapData
import { B41, B42 } from './grid.js';

/** (cell, pos) on the old grid -> (cell, pos) on the new grid, via global coord. */
function regrid(cell: number, pos: number): [number, number] {
  const g = cell * B41.cellDim + pos;
  const nc = Math.floor(g / B42.cellDim);
  return [nc, g - nc * B42.cellDim];
}

export function reprojectSpawnpoints(text: string): string {
  return text.replace(
    /worldX\s*=\s*(\d+)\s*,\s*worldY\s*=\s*(\d+)\s*,\s*posX\s*=\s*(\d+)\s*,\s*posY\s*=\s*(\d+)/g,
    (_m, wx: string, wy: string, px: string, py: string) => {
      const [nwx, npx] = regrid(+wx, +px);
      const [nwy, npy] = regrid(+wy, +py);
      return `worldX = ${nwx}, worldY = ${nwy}, posX = ${npx}, posY = ${npy}`;
    },
  );
}

const CELL_RE = /<cell\s+x="(\d+)"\s+y="(\d+)"\s*>([\s\S]*?)<\/cell>/g;
const FEATURE_RE = /<feature>([\s\S]*?)<\/feature>/g;
const POINT_RE = /<point\s+x="(-?\d+)"\s+y="(-?\d+)"\s*\/>/g;
const COORDS_RE = /<coordinates>[\s\S]*?<\/coordinates>/;

/**
 * Reproject worldmap.xml. Each feature's cell-relative points are lifted to
 * global, the feature is added to every B42 cell its bounding box overlaps
 * (matching POTWorldMapData.addFeature), and points are rewritten relative to
 * each destination cell. Cosmetic (the in-game world map), so out-of-cell
 * points are written as-is like the engine does.
 */
export function reprojectWorldMapXml(text: string): string {
  const versionMatch = /<world\s+version="([^"]*)"/.exec(text);
  const version = versionMatch?.[1] ?? '1.0';

  // newCellKey -> feature XML fragments
  const newCells = new Map<string, string[]>();
  const addFeature = (cx: number, cy: number, frag: string): void => {
    const key = `${cx},${cy}`;
    const arr = newCells.get(key);
    if (arr) arr.push(frag);
    else newCells.set(key, [frag]);
  };

  for (let cm = CELL_RE.exec(text); cm; cm = CELL_RE.exec(text)) {
    const oldCellX = +cm[1]!;
    const oldCellY = +cm[2]!;
    const body = cm[3]!;
    for (let fm = FEATURE_RE.exec(body); fm; fm = FEATURE_RE.exec(body)) {
      const feature = fm[1]!;
      const pts: [number, number][] = [];
      for (let pm = POINT_RE.exec(feature); pm; pm = POINT_RE.exec(feature)) {
        pts.push([oldCellX * B41.cellDim + +pm[1]!, oldCellY * B41.cellDim + +pm[2]!]);
      }
      if (pts.length === 0) continue;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [gx, gy] of pts) {
        if (gx < minX) minX = gx;
        if (gy < minY) minY = gy;
        if (gx > maxX) maxX = gx;
        if (gy > maxY) maxY = gy;
      }
      const ncMinX = Math.floor(minX / B42.cellDim);
      const ncMinY = Math.floor(minY / B42.cellDim);
      const ncMaxX = Math.floor(maxX / B42.cellDim);
      const ncMaxY = Math.floor(maxY / B42.cellDim);
      for (let ny = ncMinY; ny <= ncMaxY; ny++) {
        for (let nx = ncMinX; nx <= ncMaxX; nx++) {
          const coords =
            '<coordinates>\n' +
            pts.map(([gx, gy]) => `     <point x="${gx - nx * B42.cellDim}" y="${gy - ny * B42.cellDim}"/>`).join('\n') +
            '\n    </coordinates>';
          addFeature(nx, ny, `  <feature>${feature.replace(COORDS_RE, coords)}</feature>`);
        }
      }
    }
  }

  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', `<world version="${version}">`];
  for (const [key, frags] of [...newCells].sort()) {
    const [x, y] = key.split(',');
    out.push(` <cell x="${x}" y="${y}">`, ...frags, ' </cell>');
  }
  out.push('</world>', '');
  return out.join('\n');
}
