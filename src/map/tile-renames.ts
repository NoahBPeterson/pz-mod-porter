// B41 -> B42 tile remapping for map conversion.
//
// Grounded in data, not guesswork: across all 48 workshop map mods (6,657 cells
// parsed), exactly ONE base-game tilesheet was meaningfully removed in B42 —
// `jumbo_tree_01` (used by 38 mods). B42 has no tree tilesheet successor because
// trees are now PROCEDURAL: the engine regrows them from the Forest/DeepForest
// zones in objects.lua (which we pass through unchanged). So dropping baked tree
// tiles is the correct B42 behaviour, not a loss.
//
// Everything else "missing from B42 vanilla" is a third-party community tile
// pack (Erika's, pert_, Daddy's _ddd_, tkstiles _tk_, melos_, …) — a dependency
// the map needs installed in its B42 form, not a TIS rename.
import { B42_TILESHEETS } from './data/b42-tilesheets.js';

/** Tilesheet (name minus the trailing _<index>) of a full tile name. */
export function tilesheetOf(tileName: string): string {
  return tileName.replace(/_\d+$/, '');
}

/**
 * Base-game tilesheets removed in B42 with no static successor -> drop the tile.
 * Keep this list tight and evidence-backed; unknown tiles pass through.
 */
const DROP_SHEETS: ReadonlySet<string> = new Set([
  'jumbo_tree_01', // trees are procedural in B42 (regrown from forest zones)
]);

/**
 * Verified 1:1 base-game tilesheet renames (old -> new). Empty today: B42 kept
 * vanilla tile names intact apart from the removals above. Add pairs here only
 * when confirmed against the B42 tile definitions.
 */
const RENAME_SHEETS: ReadonlyMap<string, string> = new Map<string, string>([]);

export type TileClass = 'vanilla' | 'dropped' | 'renamed' | 'external';

export function classifyTile(name: string): TileClass {
  const sheet = tilesheetOf(name);
  if (DROP_SHEETS.has(sheet)) return 'dropped';
  if (RENAME_SHEETS.has(sheet)) return 'renamed';
  if (B42_TILESHEETS.has(sheet)) return 'vanilla';
  return 'external'; // mod's own custom tiles, or a community tile-pack dependency
}

/**
 * Remap a B41 tile name to its B42 name, or null to drop it. `external` tiles
 * (custom/community) pass through unchanged — they ship with the mod or come
 * from a tile pack and are not ours to rename.
 */
export function renameTile(name: string): string | null {
  const sheet = tilesheetOf(name);
  if (DROP_SHEETS.has(sheet)) return null;
  const to = RENAME_SHEETS.get(sheet);
  if (to !== undefined) return `${to}${name.slice(sheet.length)}`;
  return name;
}
