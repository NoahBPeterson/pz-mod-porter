// Browser glue around the conversion engine (built to ../dist). Reads a mod
// (zip or folder), runs convertMod, classifies the result into an honest
// verdict, and packages the output back into a downloadable zip. Everything
// runs client-side — no file ever leaves the machine.
import JSZip from 'jszip';
import { convertMod } from '@engine/convert.js';
import { convertMapCells } from '@engine/map/convert.js';
import { reprojectSpawnpoints, reprojectWorldMapXml } from '@engine/map/reproject.js';
import { extractTilesheets } from '@engine/map/tiles-def.js';
import { reportHeadline } from '@engine/report.js';
import type { ConversionReport, ModFile, LuaFinding, Warning } from '@engine/types.js';
import type { MapWorkerRequest, MapWorkerResponse } from './map-worker.ts';

export type { ConversionReport, ModFile, LuaFinding, Warning };

const TEXT_EXT: ReadonlySet<string> = new Set([
  'txt', 'lua', 'json', 'info', 'md', 'csv', 'xml', 'ini',
]);
const isText = (name: string): boolean =>
  TEXT_EXT.has((name.split('.').pop() ?? '').toLowerCase());

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

export async function readZip(file: Blob): Promise<ModFile[]> {
  const zip = await JSZip.loadAsync(file);
  const out: ModFile[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (isText(entry.name)) out.push({ path: entry.name, text: await entry.async('string') });
    else out.push({ path: entry.name, text: null, bytes: await entry.async('uint8array') });
  }
  return out;
}

export async function readDir(fileList: FileList | File[]): Promise<ModFile[]> {
  const out: ModFile[] = [];
  for (const f of Array.from(fileList)) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    const path = rel && rel.length > 0 ? rel : f.name;
    if (isText(f.name)) out.push({ path, text: await f.text() });
    else out.push({ path, text: null, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  return out;
}

/**
 * Read a drag-and-dropped folder. `dataTransfer.files` cannot recurse into
 * directories — you must walk the FileSystemEntry tree from webkitGetAsEntry().
 * Entries MUST be captured synchronously during the drop event (the caller does
 * that and hands us the captured roots here).
 */
export async function readEntries(roots: readonly FileSystemEntry[]): Promise<ModFile[]> {
  const out: ModFile[] = [];
  for (const r of roots) await walkEntry(r, out);
  return out;
}

async function walkEntry(entry: FileSystemEntry, out: ModFile[]): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
    const path = entry.fullPath.replace(/^\//, '');
    if (isText(file.name)) out.push({ path, text: await file.text() });
    else out.push({ path, text: null, bytes: new Uint8Array(await file.arrayBuffer()) });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns at most ~100 entries per call; loop until empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) await walkEntry(child, out);
    }
  }
}

export function guessModName(files: readonly ModFile[]): string {
  const info = files.find((f) => /(^|\/)mod\.info$/i.test(f.path) && f.text != null);
  if (info?.text) {
    const m = /^\s*name\s*=\s*(.+)$/im.exec(info.text);
    if (m?.[1]) return m[1].trim();
  }
  const first = files.find((f) => f.path.includes('/'));
  return first ? (first.path.split('/')[0] ?? 'mod') : 'mod';
}

// ---------------------------------------------------------------------------
// Verdict + classification (the honest taxonomy)
// ---------------------------------------------------------------------------

export type Tier = 'clean' | 'notes' | 'review' | 'manual';

export interface FindingGroup {
  key: string;
  title: string;
  blurb: string;
  tier: Tier;
  items: { file?: string; line?: number; message: string; snippet?: string }[];
}

export interface ModResult {
  modName: string;
  sourceLabel: string;
  inputFiles: ModFile[];
  outputFiles: ModFile[];
  report: ConversionReport;
  headline: string;
  tier: Tier;
  verdict: string;
  groups: FindingGroup[];
  map: MapState;
  stats: { label: string; value: number; tone: 'ok' | 'info' | 'warn' | 'bad' }[];
}

const OVERRIDE = 'override-removed';

function tierOf(report: ConversionReport, obsoleteCount: number): Tier {
  const hasOverride = report.luaFindings.some((f) => f.rule === OVERRIDE);
  if (hasOverride) return 'manual';
  const hasRemoved = report.luaFindings.some(
    (f) => f.rule === 'removed-event' || f.rule === 'removed-event-trigger' || f.rule === 'require-removed',
  );
  const hasError =
    report.warnings.some((w) => w.level === 'error') ||
    report.luaFindings.some((f) => f.level === 'error');
  if (hasRemoved || hasError) return 'review';
  if (report.warnings.length > 0 || obsoleteCount > 0) return 'notes';
  return 'clean';
}

const VERDICT: Record<Tier, string> = {
  clean: 'Fully converted. Every recipe, item and Lua construct had a known Build 42 successor — nothing for you to touch.',
  notes: 'Converted and ready to use. A few transforms are worth a glance (animation fallbacks, renames, de-dupes) but the mod works as-is.',
  review: 'Converted, but some Lua references a Build 42-deleted event or module. The mod loads; review the flagged lines to confirm intent.',
  manual: 'Mostly converted, but this mod re-implements a subsystem Build 42 rebuilt from scratch. A human needs to port that hand-written Lua — there is no 1:1 mapping.',
};

function warningKey(w: Warning): { key: string; title: string; blurb: string } {
  const m = w.message;
  if (/no timedAction inferable/i.test(m))
    return {
      key: 'timed',
      title: 'Animation fell back to the generic craft action',
      blurb: 'No Sound / AnimNode / tool / skill signal existed in B41 to infer a specific timedAction, so the recipe uses the generic “Making” animation. Behaviour is correct; only the animation is generic.',
    };
  if (/TeachedRecipes|LearnedRecipes/i.test(m))
    return {
      key: 'rename',
      title: 'Renamed B41 properties to their B42 names',
      blurb: 'A direct rename was applied (e.g. TeachedRecipes → LearnedRecipes). The mod is fully ported; this note is a receipt.',
    };
  if (/duplicate recipe name|renamed/i.test(m))
    return {
      key: 'dedupe',
      title: 'De-duplicated colliding recipe IDs',
      blurb: 'B42 craftRecipe IDs must be unique; a colliding name was suffixed. Fully converted.',
    };
  if (/Prop1|Prop2|Source=|flags/i.test(m))
    return {
      key: 'prop',
      title: 'Mapped Prop1 / Prop2 to input flags',
      blurb: 'B41 ingredient props were translated to B42 input flags[].',
    };
  return { key: 'misc', title: 'Other advisory notes', blurb: 'Informational notes emitted during conversion.' };
}

function classifyFindings(report: ConversionReport, obsoleteCount: number): FindingGroup[] {
  const groups: FindingGroup[] = [];

  const overrides = report.luaFindings.filter((f) => f.rule === OVERRIDE);
  if (overrides.length)
    groups.push({
      key: 'override',
      title: 'Re-implemented subsystem (needs a human)',
      blurb: 'This file overrides a base-game Lua file that B42 deleted or rebuilt (fireplace, blacksmith, crafting UI, fishing, recipe code). The concept has no B42 equivalent to map onto, so porting it is a re-implementation, not a translation.',
      tier: 'manual',
      items: overrides.map((f) => toItem(f)),
    });

  const removed = report.luaFindings.filter(
    (f) => f.rule === 'removed-event' || f.rule === 'removed-event-trigger' || f.rule === 'require-removed',
  );
  if (removed.length)
    groups.push({
      key: 'removed',
      title: 'References a B42-removed event or module',
      blurb: 'These call an event or require a base Lua file that no longer exists in B42. They are commented out + annotated so the mod still loads; review to confirm nothing critical is lost.',
      tier: 'review',
      items: removed.map((f) => toItem(f)),
    });

  // Advisory warnings, bucketed.
  const byKey = new Map<string, FindingGroup>();
  for (const w of report.warnings) {
    const { key, title, blurb } = warningKey(w);
    let g = byKey.get(key);
    if (!g) {
      g = { key: `warn-${key}`, title, blurb, tier: w.level === 'error' ? 'review' : 'notes', items: [] };
      byKey.set(key, g);
    }
    g.items.push({ ...(w.file ? { file: w.file } : {}), message: w.message });
  }
  groups.push(...byKey.values());

  if (obsoleteCount > 0)
    groups.push({
      key: 'obsolete',
      title: 'Disabled recipe preserved (Obsolete)',
      blurb: 'B41 used Obsolete:true to turn a recipe off. Dropping the property would silently re-enable it, so the whole recipe block is commented out instead — keeping it disabled, exactly as the author intended.',
      tier: 'notes',
      items: Array.from({ length: obsoleteCount }, (_, i) => ({ message: `Recipe #${i + 1} commented out to stay disabled.` })),
    });

  return groups;
}

// Baked map cells: pre-rendered binary world data tied to the engine's grid
// geometry. B42 re-dimensioned that grid (cells 300²→256², chunks 10²→8²), so
// B41 cells are coordinate- AND format-incompatible — they cannot be byte-
// transformed, only re-baked from the map's source project in the B42 tools.
const MAP_CELL = /(^|\/)media\/maps\/.+\.(lotpack|lotheader)$/i;
const MAP_CHUNK = /(^|\/)media\/maps\/.+chunkdata_.*\.bin$/i;
export const isMapCell = (f: ModFile): boolean => MAP_CELL.test(f.path) || MAP_CHUNK.test(f.path);

function mapFindingGroup(count: number, sample: string): FindingGroup {
  return {
    key: 'map',
    title: 'Map cells need re-gridding — use “Convert map” below',
    blurb:
      'This is a map mod. Build 42 re-dimensioned the world grid — cells 300×300→256×256 squares, chunks 10×10→8×8 — so B41’s baked .lotpack / .lotheader / chunkdata cells are coordinate- and format-incompatible with B42’s loader. They are NOT fixed by the text conversion. BUT they can be re-gridded: this tool ports Build 42’s own map converter (the engine’s zombie.pot package) and rebuilds every cell on the new grid — verified lossless on real maps (820k squares, 0 loss). Click “Convert map cells” to do it. Caveat: tiles B42 renamed/removed (notably some trees/vegetation) come through by name and may be missing until remapped; the mod’s own custom tiles are preserved.',
    tier: 'manual',
    items: [{ file: sample, message: `${count} baked map files — click “Convert map cells to B42” to re-grid them (300→256).` }],
  };
}

interface MapDone {
  cells: number;
  squares: number;
  warnings: number;
  tilesDropped: number;
  externalSheets: string[];
  reprojected: number;
  declaredRequires: string[];
}

function mapConvertedGroup(d: MapDone): FindingGroup {
  const items: FindingGroup['items'] = [
    { message: `${d.cells} B42 cells rebuilt from ${d.squares.toLocaleString()} squares — losslessly re-gridded 300→256.` },
  ];
  if (d.tilesDropped > 0)
    items.push({
      message: `${d.tilesDropped.toLocaleString()} removed-tile instances dropped (chiefly jumbo_tree — B42 regrows trees procedurally from the Forest zones in objects.lua, which are preserved).`,
    });
  if (d.reprojected > 0)
    items.push({
      message: `${d.reprojected} metadata file(s) reprojected to the 256-grid (spawnpoints / worldmap); stale worldmap binary cache dropped for regeneration. objects.lua uses global coords and is unchanged.`,
    });
  if (d.declaredRequires.length > 0)
    items.push({ message: `mod.info declares require = ${d.declaredRequires.join(', ')} — install the Build 42 versions of these mods.` });
  if (d.externalSheets.length > 0)
    items.push({
      message: `References ${d.externalSheets.length} tilesheet(s) not shipped by this mod or in B42 vanilla — from an external tile pack: ${d.externalSheets.slice(0, 14).join(', ')}${d.externalSheets.length > 14 ? ` … (+${d.externalSheets.length - 14} more)` : ''}. The mod's own tiles (in its .tiles defs) are not listed here.`,
    });
  return {
    key: 'map-done',
    title: 'Map cells re-gridded to Build 42 ✓ (experimental)',
    blurb:
      'Every baked cell was rebuilt on the B42 256-grid using the port of TIS’s own converter — geometry, buildings, floors, walls and roads preserved exactly (verified lossless). Tiles B42 removed are dropped per an evidence-backed table; non-vanilla tiles come from the mod’s own or third-party tile packs (listed below) which need their B42 versions installed.',
    tier: 'notes',
    items,
  };
}

function toItem(f: LuaFinding): FindingGroup['items'][number] {
  return {
    ...(f.file ? { file: f.file } : {}),
    line: f.line,
    message: f.message,
    ...(f.snippet ? { snippet: f.snippet } : {}),
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface MapState {
  /** the mod ships baked B41 cells */
  convertible: boolean;
  /** they have been re-gridded to B42 in this result */
  converted: boolean;
  cells: number;
  squares: number;
}

function assembleResult(
  modName: string,
  sourceLabel: string,
  inputFiles: ModFile[],
  outputFiles: ModFile[],
  report: ConversionReport,
  mapsConverted: MapDone | null,
): ModResult {
  const obsoleteCount = outputFiles.reduce(
    (n, f) => n + (f.text ? (f.text.match(/\/\* \[B41->B42\]/g)?.length ?? 0) : 0),
    0,
  );

  const mapCells = inputFiles.filter(isMapCell);
  const isMap = mapCells.length > 0;
  const done = mapsConverted !== null;

  let tier: Tier;
  let verdict: string;
  const groups = classifyFindings(report, obsoleteCount);

  if (isMap && !done) {
    // Baked cells present, not yet re-gridded — never report clean.
    tier = 'manual';
    verdict = `Scripts & Lua converted. This map mod also ships ${mapCells.length} baked B41 cells that won’t load in Build 42 as-is (the world grid changed: cells 300²→256², chunks 10²→8²). They CAN be re-gridded in-browser — hit “Convert map cells” to rebuild them on the B42 grid.`;
    groups.unshift(mapFindingGroup(mapCells.length, mapCells[0]?.path ?? ''));
  } else if (isMap && mapsConverted) {
    tier = tierOf(report, obsoleteCount);
    if (tier === 'clean') tier = 'notes';
    verdict = `Map re-gridded to Build 42 (experimental): ${mapsConverted.cells} cells rebuilt from ${mapsConverted.squares.toLocaleString()} squares, plus scripts & Lua. Geometry is preserved losslessly; review the tile-pack/vegetation notes below.`;
    groups.unshift(mapConvertedGroup(mapsConverted));
  } else {
    tier = tierOf(report, obsoleteCount);
    verdict = VERDICT[tier];
  }

  const errs =
    report.warnings.filter((w) => w.level === 'error').length +
    report.luaFindings.filter((f) => f.level === 'error').length;
  const reviews = report.warnings.length + report.luaFindings.length - errs;

  return {
    modName,
    sourceLabel,
    inputFiles,
    outputFiles,
    report,
    headline: reportHeadline(report),
    tier,
    verdict,
    groups,
    map: {
      convertible: isMap,
      converted: done,
      cells: mapsConverted?.cells ?? 0,
      squares: mapsConverted?.squares ?? 0,
    },
    stats: [
      { label: 'recipes → craftRecipe', value: report.recipes.converted, tone: 'ok' },
      { label: 'items migrated', value: report.items.scanned, tone: 'ok' },
      { label: 'Lua auto-rewrites', value: report.lua.rewritten, tone: report.lua.rewritten ? 'info' : 'ok' },
      { label: 'blocking issues', value: errs, tone: errs ? 'bad' : 'ok' },
      { label: 'to review', value: reviews, tone: reviews ? 'warn' : 'ok' },
    ],
  };
}

export function runConversion(inputFiles: ModFile[], sourceLabel: string): ModResult {
  const modName = guessModName(inputFiles);
  const { files: outputFiles, report } = convertMod(inputFiles);
  return assembleResult(modName, sourceLabel, inputFiles, outputFiles, report, null);
}

/**
 * Re-grid the mod's baked B41 map cells to Build 42 (ports TIS's zombie.pot
 * converter). Runs in a Web Worker so the UI never freezes; streams per-cell
 * progress. Returns a fresh ModResult whose outputFiles contain the rebuilt
 * cells. Falls back to inline conversion where Worker is unavailable.
 */
export async function convertModMaps(
  result: ModResult,
  onProgress?: (done: number, total: number) => void,
): Promise<ModResult> {
  const dirs = new Map<string, ModFile[]>();
  for (const f of result.outputFiles) {
    if (!isMapCell(f) || !f.bytes) continue;
    const dir = f.path.slice(0, f.path.lastIndexOf('/'));
    const arr = dirs.get(dir);
    if (arr) arr.push(f);
    else dirs.set(dir, [f]);
  }

  // Tilesheets the mod ships itself (from its .tiles defs) — so we don't flag
  // the mod's own content as an external dependency. This is where a mod
  // actually declares its tiles; mod.info's require= rarely covers them.
  const ownSheets = new Set<string>();
  for (const f of result.outputFiles) {
    if (f.bytes && /\.tiles$/i.test(f.path)) for (const s of extractTilesheets(f.bytes)) ownSheets.add(s);
  }
  const ownSheetList = [...ownSheets];
  const declaredRequires = parseRequires(result.inputFiles);

  const remove = new Set<string>();
  const added: ModFile[] = [];
  let cells = 0;
  let squares = 0;
  let warnings = 0;
  let tilesDropped = 0;
  const external = new Map<string, number>();

  const worker = typeof Worker !== 'undefined'
    ? new Worker(new URL('./map-worker.ts', import.meta.url), { type: 'module' })
    : null;
  let reqId = 0;

  try {
    for (const [dir, cellFiles] of dirs) {
      const input: [string, Uint8Array][] = [];
      for (const f of cellFiles) {
        if (f.bytes) input.push([f.path.slice(dir.length + 1), f.bytes]);
        remove.add(f.path);
      }
      const id = ++reqId;
      const out = worker
        ? await runOnWorker(worker, id, dir, input, ownSheetList, onProgress)
        : runInline(input, ownSheets, onProgress);

      cells += out.stats.newCells;
      squares += out.stats.squares;
      warnings += out.warnings.length;
      tilesDropped += out.stats.tilesDropped;
      out.stats.externalSheets.forEach((s, i) => external.set(s, Math.max(external.get(s) ?? 0, 1000 - i)));
      for (const [base, bytes] of out.files) added.push({ path: `${dir}/${base}`, text: null, bytes });
    }
  } finally {
    worker?.terminate();
  }

  // Reproject the map dirs' coordinate-bearing metadata (main thread — it's
  // cheap text work). objects.lua / spawnregions.lua need no change (global
  // coords / paths only); the stale binary worldmap cache is dropped so the
  // game regenerates it from the reprojected XML.
  const mapDirs = new Set(dirs.keys());
  let reprojected = 0;
  const newOutput: ModFile[] = [];
  for (const f of result.outputFiles) {
    if (remove.has(f.path)) continue;
    const slash = f.path.lastIndexOf('/');
    const dir = f.path.slice(0, slash);
    const base = f.path.slice(slash + 1);
    if (mapDirs.has(dir)) {
      if (f.text != null && /^spawnpoints\.lua$/i.test(base)) {
        newOutput.push({ path: f.path, text: reprojectSpawnpoints(f.text) });
        reprojected++;
        continue;
      }
      if (f.text != null && /^worldmap.*\.xml$/i.test(base)) {
        newOutput.push({ path: f.path, text: reprojectWorldMapXml(f.text) });
        reprojected++;
        continue;
      }
      if (/^worldmap.*\.xml\.bin(\.bak)?$/i.test(base)) continue; // stale cache -> regenerated
    }
    newOutput.push(f);
  }
  newOutput.push(...added);

  const externalSheets = [...external.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  return assembleResult(result.modName, result.sourceLabel, result.inputFiles, newOutput, result.report, {
    cells,
    squares,
    warnings,
    tilesDropped,
    externalSheets,
    reprojected,
    declaredRequires,
  });
}

/** mod IDs declared in any mod.info `require=` line (the in-game dependency field). */
function parseRequires(files: readonly ModFile[]): string[] {
  const ids = new Set<string>();
  for (const f of files) {
    if (f.text == null || !/(^|\/)mod\.info$/i.test(f.path)) continue;
    const m = /^\s*require\s*=\s*(.+)$/im.exec(f.text);
    if (m?.[1]) for (const id of m[1].split(',')) {
      const t = id.trim();
      if (t) ids.add(t);
    }
  }
  return [...ids];
}

interface ConvertedDir {
  files: Map<string, Uint8Array>;
  stats: { newCells: number; squares: number; tilesDropped: number; externalSheets: string[] };
  warnings: string[];
}

function runInline(
  input: [string, Uint8Array][],
  ownSheets: ReadonlySet<string>,
  onProgress?: (d: number, t: number) => void,
): ConvertedDir {
  return convertMapCells(new Map(input), onProgress ? { ownSheets, onProgress } : { ownSheets });
}

function runOnWorker(
  worker: Worker,
  id: number,
  dir: string,
  input: [string, Uint8Array][],
  ownSheets: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<ConvertedDir> {
  return new Promise<ConvertedDir>((resolve, reject) => {
    const onMsg = (e: MessageEvent): void => {
      const d = e.data as MapWorkerResponse;
      if (d.id !== id) return;
      if (d.type === 'progress') onProgress?.(d.done, d.total);
      else if (d.type === 'error') {
        worker.removeEventListener('message', onMsg);
        reject(new Error(d.message));
      } else {
        worker.removeEventListener('message', onMsg);
        resolve({ files: new Map(d.files), stats: d.stats, warnings: d.warnings });
      }
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ id, dir, input, ownSheets } satisfies MapWorkerRequest);
  });
}

// ---------------------------------------------------------------------------
// File-level diff model
// ---------------------------------------------------------------------------

export type FileStatus = 'added' | 'modified' | 'unchanged';

export interface FileEntry {
  path: string;
  status: FileStatus;
  /** true for non-text assets (images, .pack, baked cells, …) */
  binary: boolean;
  before: string | null;
  after: string | null;
  /** output bytes for binary files — used for byte-compare and image preview */
  bytes?: Uint8Array;
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function diffFiles(input: readonly ModFile[], output: readonly ModFile[]): FileEntry[] {
  const inByPath = new Map(input.map((f) => [f.path, f]));
  const entries: FileEntry[] = output.map((out) => {
    const prev = inByPath.get(out.path);
    if (out.text == null) {
      // binary: actually compare bytes instead of assuming "unchanged"
      let status: FileStatus;
      if (!prev) status = 'added';
      else if (prev.text != null) status = 'modified';
      else status = bytesEqual(prev.bytes, out.bytes) ? 'unchanged' : 'modified';
      return { path: out.path, status, binary: true, before: null, after: null, ...(out.bytes ? { bytes: out.bytes } : {}) };
    }
    let status: FileStatus;
    if (!prev) status = 'added';
    else if (prev.text == null) status = 'modified';
    else status = prev.text === out.text ? 'unchanged' : 'modified';
    return { path: out.path, status, binary: false, before: prev?.text ?? null, after: out.text };
  });
  // Sort: added (generated) first, then modified, then unchanged.
  const rank: Record<FileStatus, number> = { added: 0, modified: 1, unchanged: 2 };
  return entries.sort((a, b) => rank[a.status] - rank[b.status] || a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export async function buildZip(result: ModResult): Promise<Blob> {
  const zip = new JSZip();
  for (const f of result.outputFiles) {
    if (f.text != null) zip.file(f.path, f.text);
    else if (f.bytes) zip.file(f.path, f.bytes);
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

export const sanitize = (s: string): string => (s || 'mod').replace(/[^A-Za-z0-9_.-]+/g, '_');

// ---------------------------------------------------------------------------
// Issue reporting
// ---------------------------------------------------------------------------

export const ISSUES_URL = 'https://github.com/NoahBPeterson/pz-mod-porter/issues';

const TIER_LABEL: Record<Tier, string> = {
  clean: 'fully converted',
  notes: 'minor notes',
  review: 'review advised',
  manual: 'needs manual porting',
};

const appVersion = (): string => (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev');
const userAgent = (): string => (typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a');

/** Full plain-text diagnostic — downloaded so the user can attach it to an issue. */
export function buildDiagnostic(result: ModResult): string {
  const L: string[] = [];
  L.push('PZ Mod Porter — conversion diagnostic');
  L.push('='.repeat(42));
  L.push(`Mod:      ${result.modName}`);
  L.push(`Source:   ${result.sourceLabel}`);
  L.push(`App:      pz-mod-porter @ ${appVersion()}`);
  L.push(`Browser:  ${userAgent()}`);
  L.push(`Verdict:  [${result.tier}] ${TIER_LABEL[result.tier]}`);
  L.push(`          ${result.verdict}`);
  L.push('');
  L.push(`Stats:    ${result.headline}`);
  if (result.map.convertible) {
    L.push(`Map:      convertible · ${result.map.converted ? `converted (${result.map.cells} cells, ${result.map.squares.toLocaleString()} squares)` : 'NOT yet re-gridded'}`);
  }
  L.push('');
  L.push('Findings:');
  if (result.groups.length === 0) L.push('  (none — fully converted)');
  for (const g of result.groups) {
    L.push(`  [${g.tier}] ${g.title}  (${g.items.length})`);
    L.push(`      ${g.blurb}`);
    for (const it of g.items.slice(0, 40)) {
      const loc = it.file ? `${it.file}${typeof it.line === 'number' && it.line > 0 ? `:${it.line}` : ''} — ` : '';
      L.push(`      • ${loc}${it.message}`);
      if (it.snippet) L.push(`          ${it.snippet.trim().slice(0, 140)}`);
    }
    if (g.items.length > 40) L.push(`      … and ${g.items.length - 40} more`);
    L.push('');
  }
  const files = diffFiles(result.inputFiles, result.outputFiles);
  const byStatus = files.reduce<Record<string, number>>((m, f) => ((m[f.status] = (m[f.status] ?? 0) + 1), m), {});
  L.push(`Files:    ${files.length} (${Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(', ')})`);
  return L.join('\n');
}

/** A GitHub "new issue" URL with the key diagnostics pre-filled (kept short). */
export function issueUrl(result: ModResult): string {
  const title = `[Conversion] ${result.modName} — ${TIER_LABEL[result.tier]}`;
  const flagged = result.groups.filter((g) => g.tier === 'manual' || g.tier === 'review');
  const show = (flagged.length ? flagged : result.groups).slice(0, 6);

  const b: string[] = [];
  b.push('<!-- Describe what went wrong (e.g. how it behaved in-game) here. -->');
  b.push('');
  b.push(`**Mod:** ${result.modName}`);
  b.push(`**Verdict:** \`${result.tier}\` — ${result.verdict}`);
  b.push(`**Stats:** ${result.headline}`);
  b.push(`**App:** pz-mod-porter @ ${appVersion()}`);
  b.push(`**Browser:** ${userAgent()}`);
  b.push('');
  b.push('**Flagged by the converter:**');
  if (show.length === 0) b.push('_Nothing — it reported fully converted._');
  for (const g of show) {
    b.push(`- **${g.title}** (${g.items.length})`);
    for (const it of g.items.slice(0, 3)) {
      const loc = it.file ? `\`${it.file}\` — ` : '';
      b.push(`  - ${loc}${it.message}`);
    }
  }
  b.push('');
  b.push('> 📎 A full diagnostic `.txt` was just downloaded — please drag it into this issue.');

  let body = b.join('\n');
  if (body.length > 5500) body = `${body.slice(0, 5500)}\n…(truncated — see the attached .txt)`;
  const q = new URLSearchParams({ title, body, labels: 'conversion' });
  return `${ISSUES_URL}/new?${q.toString()}`;
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
