// Mod-folder orchestration: B41 mod file set -> B42 file set + report.

import { parseScript, findBlocks } from './parser.js';
import { serializeScript } from './serializer.js';
import { transformRecipe } from './transforms/recipe.js';
import { transformItem } from './transforms/item.js';
import { rewriteLua } from './transforms/lua.js';
import { transformRecipeCode } from './transforms/recipecode.js';
import { buildXpIndex, ownDefinedNames } from './transforms/xp-index.js';
import { convertTranslationTxt, isTranslationTxt } from './transforms/translation.js';
import type { XpEntry } from './transforms/xp-index.js';
import { VANILLA_XP_AWARDS } from './data/xp-awards.js';
import type {
  BlockNode, ConversionReport, ConvertResult, ModFile, RootNode, ScriptNode, TransformContext, XpShim,
} from './types.js';

const isScript = (p: string): boolean => /\/media\/scripts\/.*\.txt$/i.test('/' + p) || /(^|\/)scripts\/.*\.txt$/i.test(p);
const isLua = (p: string): boolean => /\.lua$/i.test(p);

function modRootOf(path: string): string {
  const idx = path.toLowerCase().indexOf('media/');
  return idx >= 0 ? path.slice(0, idx) : '';
}

export interface ModMeta {
  /** mod.info id, sanitized to a valid namespace (for custom ItemTags). */
  id?: string;
  /** Declared dependencies (require/loadModAfter/loadModBefore), `\`-prefix stripped. */
  deps: string[];
}

// Read the first mod.info: the id (custom-tag namespace) and its declared
// dependencies. A custom tag a mod references might actually be OWNED by one of
// these deps — in which case it needs THAT mod's namespace, not this one's — so
// we surface the dep ids in a warning (the converter can't resolve cross-mod
// ownership from a single mod in isolation).
function extractModMeta(files: readonly ModFile[]): ModMeta {
  for (const f of files) {
    if (f.text == null || !/(^|\/)mod\.info$/i.test(f.path)) continue;
    const id = /^\s*id\s*=\s*(.+?)\s*$/im.exec(f.text)?.[1]?.trim().replace(/[^A-Za-z0-9_]/g, '');
    const deps = [...f.text.matchAll(/^\s*(?:require|loadModAfter|loadModBefore)\s*=\s*(.+?)\s*$/gim)]
      .flatMap((m) => (m[1] ?? '').split(','))
      .map((s) => s.trim().replace(/^.*\\/, '')) // strip WORKSHOP_ID\ prefix -> bare MOD_ID
      .filter((s) => s.length > 0);
    return { ...(id ? { id } : {}), deps: [...new Set(deps)] };
  }
  return { deps: [] };
}

// Scan a mod's Lua for its own `OnGiveXP` functions so recipe conversion can
// resolve mod-defined references (not just vanilla ones). Maps the function's
// last name-segment -> `Skill:amount` from the first `AddXP(Perks.X, N)`.
const XP_FN_RE = /OnGiveXP[.:]([A-Za-z0-9_]+)\s*(?:=\s*function)?\s*(?:\()/g;
const ADDXP_RE = /AddXP\s*\(\s*Perks\.([A-Za-z0-9_]+)\s*,\s*(\d+)/;

function collectModXpAwards(files: readonly ModFile[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const f of files) {
    if (f.text == null || !isLua(f.path)) continue;
    const text = f.text;
    for (const m of text.matchAll(XP_FN_RE)) {
      const name = m[1];
      if (!name || map[name] !== undefined) continue;
      const window = text.slice(m.index ?? 0, (m.index ?? 0) + 600);
      const xp = ADDXP_RE.exec(window);
      if (xp && xp[1] && xp[2]) map[name] = `${xp[1]}:${xp[2]}`;
    }
  }
  return map;
}

// Names of functions defined anywhere in the mod's Lua (both the full dotted
// path and its last segment), so the recipe transform can tell which OnGiveXP
// functions ship with the mod and are therefore shimmable.
const FN_DEF_RE = /(?:function\s+([A-Za-z_][\w.:]*)|([A-Za-z_][\w.:]*)\s*=\s*function)\s*\(/g;
function collectModDefinedFns(files: readonly ModFile[]): Set<string> {
  const set = new Set<string>();
  for (const f of files) {
    if (f.text == null || !isLua(f.path)) continue;
    for (const m of f.text.matchAll(FN_DEF_RE)) {
      const name = m[1] ?? m[2];
      if (!name) continue;
      set.add(name);
      const last = name.split(/[.:]/).pop();
      if (last) set.add(last);
    }
  }
  return set;
}

// Render the generated XP shim Lua file. Each shim re-binds B41's
// (recipe, ingredients, result, player) from B42's OnCreate `params` and calls
// the original function(s). Everything is pcall-guarded so a missing/renamed
// function degrades to "no XP" rather than a runtime error.
// A Lua adapter exposing the B41 `Recipe` API on top of B42's CraftRecipe, so
// original OnGiveXP/OnCreate bodies that call `recipe:<method>()` keep working
// unmodified. Method mapping decoded from the B42 engine (CraftRecipe API):
// rename getTimeToMake->getTime, size->getInputCount, getSource->getInputs():get,
// getResult->getOutputs():get(0), isCanBeDoneFromFloor->tag scan. Methods that
// B42 removed (runtime mutation: add/remove/contains, plus Load/icon override)
// degrade to no-op/nil rather than erroring.
const B41_RECIPE_ADAPTER = `B41Compat = B41Compat or {}

-- B41 recipe "source" (an ingredient slot) over a B42 InputScript.
-- B41 source:get(i) returned an item-type string -> B42 getPossibleInputItems():get(i):getFullName().
function B41Compat.wrapSource(inputScript)
    if not inputScript then return nil end
    local items = inputScript:getPossibleInputItems()
    local s = {}
    function s:size() return items and items:size() or 0 end
    function s:get(i) local it = items and items:get(i) or nil; return it and it:getFullName() or nil end
    function s:getItems() return items end
    function s:getRawScript() return inputScript end
    return s
end

-- B41 recipe "result" over a B42 OutputScript + the actual created item.
-- Type queries route to the created InventoryItem (same method names); count
-- comes from the OutputScript.
function B41Compat.wrapResult(outputScript, created)
    local r = {}
    function r:getCount() return outputScript and outputScript:getIntAmount() or 1 end
    function r:getFullType() return created and created:getFullType() or nil end
    function r:getType() return created and created:getType() or nil end
    function r:getModule() return created and created:getModule() or nil end
    function r:getDrainableCount() return created and created.getCurrentUses and created:getCurrentUses() or nil end
    function r:getItem() return created end
    function r:getRawScript() return outputScript end
    return r
end

function B41Compat.wrapRecipe(craftRecipeData)
    local crd = craftRecipeData
    local cr = crd and crd:getRecipe() or nil
    if not cr then return nil end
    local p = {}
    function p:getName() return cr:getName() end
    function p:getOriginalname() return cr:getName() end
    function p:getFullType() return cr:getName() end
    function p:getCategory() return cr:getCategory() end
    function p:getTimeToMake() return cr:getTime() end
    function p:needToBeLearn() return cr:needToBeLearn() end
    function p:getInputCount() return cr:getInputCount() end
    function p:size() return cr:getInputCount() end
    function p:isCanBeDoneFromFloor()
        local t = cr:getTags()
        if t then for i=0, t:size()-1 do if t:get(i) == "CanBeDoneFromFloor" then return true end end end
        return false
    end
    -- Recursive adapters: the returned objects also changed type in B42.
    function p:getSource(n)
        local i = cr:getInputs()
        return i and i:size() > n and B41Compat.wrapSource(i:get(n)) or nil
    end
    function p:getResult()
        local o = cr:getOutputs()
        local out = o and o:size() > 0 and o:get(0) or nil
        return out and B41Compat.wrapResult(out, crd and crd:getFirstCreatedItem() or nil) or nil
    end
    -- Removed in B42 (no runtime equivalent) -> safe degradation:
    function p:add() end
    function p:remove() end
    function p:contains() return false end
    function p:getNearItem() return nil end
    function p:Load() end
    function p:overrideIconTexture() end
    return p
end
`;

function renderXpShims(shims: readonly XpShim[], inlinedFns: readonly string[]): string {
  const L: string[] = [];
  L.push('-- Auto-generated by PZ Mod Porter (B41 -> B42).');
  L.push('-- Preserves runtime-computed OnGiveXP/OnCreate logic that cannot become a static');
  L.push('-- xpAward, by calling the original B41 function from a B42 craftRecipe OnCreate hook.');
  L.push('-- `recipe` is a B41-API adapter over B42 CraftRecipe (see B41Compat.wrapRecipe).');
  L.push(B41_RECIPE_ADAPTER);
  if (inlinedFns.length > 0) {
    L.push('-- Inlined from a dependency mod (B42-converted) so XP works without it:');
    for (const fn of inlinedFns) { L.push(fn); L.push(''); }
  }
  L.push('B41XP = B41XP or {}');
  L.push('');
  for (const s of shims) {
    L.push(`function B41XP.${s.id}(params)`);
    L.push('    local player = params.character');
    L.push('    local crd = params.craftRecipeData');
    L.push('    local ingredients = crd and crd:getAllConsumedItems() or nil');
    L.push('    local result = crd and crd:getFirstCreatedItem() or nil -- B41 `result`; created before OnCreate fires');
    L.push('    local recipe = B41Compat.wrapRecipe(crd) -- B41 Recipe API over B42 CraftRecipe');
    if (s.onCreateRef !== undefined) {
      // B42 calls OnCreate with (craftRecipeData, character) — and the AST pass
      // rewrites Recipe.OnCreate.* to that signature — so chain it natively.
      L.push(`    pcall(function() ${s.onCreateRef}(crd, player) end) -- original OnCreate (B42 args)`);
    }
    L.push(`    pcall(function() ${s.xpFnRef}(recipe, ingredients, result, player) end) -- original OnGiveXP`);
    L.push('end');
    L.push('');
  }
  return L.join('\n') + '\n';
}

function collectKnownItems(scriptFiles: readonly ModFile[]): Set<string> {
  const known = new Set<string>();
  for (const f of scriptFiles) {
    if (f.text == null) continue;
    let ast: RootNode;
    try { ast = parseScript(f.text); } catch { continue; }
    for (const item of findBlocks(ast, 'item')) if (item.name) known.add(item.name);
  }
  return known;
}

function transformModule(
  moduleBlock: BlockNode,
  moduleCtx: TransformContext,
  report: ConversionReport,
  relPath: string,
): void {
  const newChildren: ScriptNode[] = [];
  for (const child of moduleBlock.children) {
    if (child.type !== 'block') { newChildren.push(child); continue; }
    const kw = child.keyword.toLowerCase();
    if (kw === 'recipe') {
      const { block, warnings } = transformRecipe(child, moduleCtx);
      report.recipes.converted++;
      for (const w of warnings) report.warnings.push({ file: relPath, level: 'warn', message: w });
      newChildren.push(block);
    } else if (kw === 'item') {
      const tagOpts: { modId?: string; customTags?: Set<string> } = {};
      if (moduleCtx.modId !== undefined) tagOpts.modId = moduleCtx.modId;
      if (moduleCtx.customItemTags !== undefined) tagOpts.customTags = moduleCtx.customItemTags;
      const { block, warnings, id, displayName } = transformItem(child, tagOpts);
      report.items.scanned++;
      if (warnings.length > 0) report.items.changed++;
      for (const w of warnings) report.warnings.push({ file: relPath, level: 'warn', message: w });
      if (displayName !== undefined && id) {
        report.displayNames[`${moduleCtx.moduleName}.${id}`] = displayName;
      }
      newChildren.push(block);
    } else {
      newChildren.push(child);
    }
  }
  moduleBlock.children = newChildren;
}

function transformScriptAst(
  ast: RootNode,
  base: Omit<TransformContext, 'moduleName'>,
  report: ConversionReport,
  relPath: string,
): void {
  for (const child of ast.children) {
    if (child.type === 'block' && child.keyword.toLowerCase() === 'module') {
      transformModule(child, { ...base, moduleName: child.name || 'Base' }, report, relPath);
    }
  }
}

// Merge every translation source into Translate/<LANG>/<Cat>.json files:
//   * converted .txt tables (modder-authored, highest among generated),
//   * script-derived recipe display names -> Recipes.json,
//   * migrated item DisplayName -> ItemName.json (EN).
// A pre-existing .json the mod already shipped at the same path wins outright
// (its keys seed the bucket first); within the generated sources the first
// writer of a key wins, in the order above.
function emitTranslations(
  outFiles: ModFile[],
  report: ConversionReport,
  modRoot: string,
  txtConversions: ReadonlyArray<ReturnType<typeof convertTranslationTxt>>,
): void {
  interface Bucket { path: string; entries: Record<string, string>; existed: boolean; }
  const buckets = new Map<string, Bucket>();

  const bucketFor = (outPath: string): Bucket => {
    const key = outPath.toLowerCase();
    const cached = buckets.get(key);
    if (cached) return cached;
    const existing = outFiles.find((f) => f.path.toLowerCase() === key);
    const entries: Record<string, string> = {};
    let existed = false;
    if (existing && existing.text != null) {
      existed = true;
      try { Object.assign(entries, JSON.parse(existing.text) as Record<string, string>); } catch { /* replace unparseable json */ }
    }
    const b: Bucket = { path: existing ? existing.path : outPath, entries, existed };
    buckets.set(key, b);
    return b;
  };
  const fill = (b: Bucket, entries: Readonly<Record<string, string>>): void => {
    for (const k of Object.keys(entries)) if (b.entries[k] === undefined) b.entries[k] = entries[k] ?? '';
  };

  // B42 reads Recipes.json by the craftRecipe id, so a translation only applies
  // if it's KEYED by that id. The modder's Recipes_<LANG>.txt keys use the B41
  // form (recipe name with spaces -> underscores, e.g. `Make_Thing`), which we
  // can't unambiguously map back (was `_` a space or a real underscore?). So we
  // reconcile each key against the mod's real craftRecipe ids (from the script
  // transform) by alphanumeric-normalized match. This is what makes localized
  // recipe names actually show — without it a non-EN entry stays under the old
  // key, B42 never queries it, and the translation is silently dropped. (An
  // incidental effect is that the EN entry lands on the same id as the
  // script-derived name and the two merge — but that merge does nothing on its
  // own; the point is the key, not the de-duplication.)
  const norm = (s: string): string => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const recipeIdByNorm = new Map<string, string>();
  for (const id of Object.keys(report.translations)) recipeIdByNorm.set(norm(id), id);

  for (const conv of txtConversions) {
    if (!conv) continue;
    let entries = conv.entries;
    if (conv.category === 'Recipes' && recipeIdByNorm.size > 0) {
      entries = {};
      for (const [k, v] of Object.entries(conv.entries)) entries[recipeIdByNorm.get(norm(k)) ?? k] = v;
    }
    fill(bucketFor(conv.outPath), entries);
  }
  if (Object.keys(report.translations).length > 0) {
    fill(bucketFor(`${modRoot}media/lua/shared/Translate/EN/Recipes.json`), report.translations);
  }
  if (Object.keys(report.displayNames).length > 0) {
    fill(bucketFor(`${modRoot}media/lua/shared/Translate/EN/ItemName.json`), report.displayNames);
  }

  for (const b of buckets.values()) {
    const count = Object.keys(b.entries).length;
    if (count === 0) continue;
    const json = JSON.stringify(b.entries, null, 4) + '\n';
    const existing = outFiles.find((f) => f.path.toLowerCase() === b.path.toLowerCase());
    if (existing) existing.text = json;
    else outFiles.push({ path: b.path, text: json });
    report.artifacts.push(`${b.existed ? 'Updated' : 'Created'} ${b.path} (${count} ${count === 1 ? 'entry' : 'entries'}).`);
  }
}

export interface ConvertOptions {
  /** Cross-mod XP index (from buildXpIndex over dependency/other mods). */
  xpIndex?: ReadonlyMap<string, XpEntry>;
}

export function convertMod(files: readonly ModFile[], options: ConvertOptions = {}): ConvertResult {
  const report: ConversionReport = {
    recipes: { converted: 0 },
    items: { scanned: 0, changed: 0 },
    lua: { scanned: 0, findings: 0, rewritten: 0 },
    scripts: { scanned: 0 },
    warnings: [],
    luaFindings: [],
    luaRewrites: [],
    artifacts: [],
    translations: {},
    displayNames: {},
  };

  const scriptFiles = files.filter((f) => f.text != null && isScript(f.path));
  const xpShims: XpShim[] = [];

  // XP index: this mod's own functions (always) + a cross-mod index (deps), so
  // OnGiveXP refs defined in a library — named e.g. Give3CookingXP, with no
  // "OnGiveXP" token — resolve to a static xpAward, or get inlined+shimmed.
  const ownNames = ownDefinedNames(files);
  const ownXpIndex = buildXpIndex([files]);
  const indexAwards: Record<string, string> = {};
  const inlineCandidates = new Map<string, string>(); // cross-mod runtime fns to inline
  const addEntry = (name: string, e: XpEntry, external: boolean): void => {
    if (e.kind === 'award') { if (indexAwards[name] === undefined) indexAwards[name] = e.award; }
    else if (external && !ownNames.has(name)) { if (!inlineCandidates.has(name)) inlineCandidates.set(name, e.source); }
  };
  for (const [name, e] of options.xpIndex ?? new Map()) addEntry(name, e, true);
  for (const [name, e] of ownXpIndex) addEntry(name, e, false);

  const modMeta = extractModMeta(files);
  const modId = modMeta.id;
  const customItemTags = new Set<string>();
  const base: Omit<TransformContext, 'moduleName'> = {
    knownItems: collectKnownItems(scriptFiles),
    usedIds: new Set<string>(),
    translations: report.translations,
    xpAwards: { ...VANILLA_XP_AWARDS, ...indexAwards, ...collectModXpAwards(files) },
    xpShimFns: new Set<string>([...collectModDefinedFns(files), ...inlineCandidates.keys()]),
    xpShims,
    customItemTags,
    ...(modId !== undefined ? { modId } : {}),
  };

  const outFiles: ModFile[] = [];
  let modRoot = '';
  const txtConversions: ReturnType<typeof convertTranslationTxt>[] = [];

  for (const f of files) {
    if (f.text == null) { outFiles.push(f); continue; }

    // B41 `.txt` translations -> B42 `.json` (B42 dropped .txt). Convert and
    // drop the original; on parse failure keep the .txt and warn so nothing is
    // silently lost.
    if (isTranslationTxt(f.path)) {
      if (!modRoot) modRoot = modRootOf(f.path);
      const conv = convertTranslationTxt(f.path, f.text);
      if (conv) txtConversions.push(conv);
      else { outFiles.push(f); report.warnings.push({ file: f.path, level: 'warn', message: 'Could not parse translation table; left as .txt (B42 will not read it).' }); }
      continue;
    }

    if (isScript(f.path)) {
      report.scripts.scanned++;
      if (!modRoot) modRoot = modRootOf(f.path);
      let ast: RootNode;
      try {
        ast = parseScript(f.text);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        report.warnings.push({ file: f.path, level: 'error', message: `Failed to parse script: ${message}` });
        outFiles.push(f);
        continue;
      }
      transformScriptAst(ast, base, report, f.path);
      outFiles.push({ path: f.path, text: serializeScript(ast) });
      continue;
    }

    if (isLua(f.path)) {
      report.lua.scanned++;
      // AST pass first (recipecode mods): rewrites Recipe.OnCreate signatures +
      // namespace guards + removes the dead require. Falls back to null if the
      // file isn't a recipecode file or doesn't parse.
      let working = f.text;
      let astChanged = false;
      const rc = transformRecipeCode(working);
      if (rc) {
        working = rc.text;
        astChanged = true;
        report.lua.rewritten += rc.changes.length;
        for (const c of rc.changes) report.luaRewrites.push({ file: f.path, line: 0, kind: 'recipecode', message: c });
      }
      // Line-level pass (events, other removed requires, overrides).
      const { text, rewrites, findings } = rewriteLua(working, f.path);
      report.lua.findings += findings.length;
      report.lua.rewritten += rewrites.length;
      for (const x of findings) report.luaFindings.push({ ...x, file: f.path });
      for (const r of rewrites) report.luaRewrites.push({ ...r, file: f.path });
      const finalChanged = astChanged || rewrites.length > 0;
      outFiles.push(finalChanged ? { path: f.path, text } : f);
      continue;
    }

    outFiles.push(f);
  }

  // Emit the generated XP shim Lua file, if any runtime OnGiveXP were shimmed.
  if (xpShims.length > 0) {
    // Inline any cross-mod (dependency) runtime functions the shims call, so the
    // converted mod is self-contained. Each is B42-converted before inlining.
    const inlinedFns: string[] = [];
    const inlinedNames = new Set<string>();
    for (const s of xpShims) {
      const name = s.xpFnRef.split('.').pop() ?? s.xpFnRef;
      const source = inlineCandidates.get(name);
      if (source && !inlinedNames.has(name)) {
        inlinedNames.add(name);
        const converted = transformRecipeCode(source);
        inlinedFns.push(converted ? converted.text : source);
      }
    }
    const shimPath = `${modRoot}media/lua/shared/B41ToB42_XPShims.lua`;
    outFiles.push({ path: shimPath, text: renderXpShims(xpShims, inlinedFns) });
    report.artifacts.push(
      `Created ${shimPath} with ${xpShims.length} OnGiveXP→OnCreate XP shim(s)` +
      (inlinedFns.length > 0 ? `, inlining ${inlinedFns.length} dependency function(s)` : '') +
      ' preserving runtime-computed XP.',
    );
  }

  // If any recipe used the IsHidden -> OnAddToMenu salvage, ship the helper.
  if (outFiles.some((f) => f.text != null && f.text.includes('B41Compat.hideFromMenu'))) {
    const hidePath = `${modRoot}media/lua/client/B41ToB42_HideFromMenu.lua`;
    if (!outFiles.some((f) => f.path === hidePath)) {
      outFiles.push({ path: hidePath, text:
        '-- Auto-generated (B41->B42): replicates B41 IsHidden:true. A craftRecipe\n' +
        '-- with OnAddToMenu returning false is craftable (via item interaction) but\n' +
        '-- hidden from the crafting menu.\n' +
        'B41Compat = B41Compat or {}\nfunction B41Compat.hideFromMenu() return false end\n' });
      report.artifacts.push(`Created ${hidePath} — IsHidden recipes kept usable but hidden from the menu via OnAddToMenu.`);
    }
  }

  // Register the mod's custom ItemTags. B42 requires custom tags to be
  // namespaced + registered (bare ones resolve to the reserved `base:` namespace
  // and silently fail); item Tags= were already rewritten to `<modId>:<tag>`.
  if (customItemTags.size > 0 && modId) {
    const tags = [...customItemTags].sort();
    const regPath = `${modRoot}media/registries.lua`;
    const existing = outFiles.find((f) => f.path.toLowerCase() === regPath.toLowerCase());
    const L = [
      '-- Auto-generated by PZ Mod Porter (B41 -> B42).',
      "-- Registers this mod's custom ItemTags. B42 requires custom tags to be",
      '-- namespaced and registered; the matching item Tags= were rewritten to',
      `-- "${modId}:<tag>". registries.lua loads before scripts.`,
      ...tags.map((t) => `ItemTag.register("${modId}:${t}")`),
      '',
    ];
    const text = L.join('\n');
    if (existing) existing.text = `${existing.text}\n${text}`;
    else outFiles.push({ path: regPath, text });
    report.artifacts.push(
      `${existing ? 'Updated' : 'Created'} ${regPath} registering ${tags.length} custom ItemTag(s): ${tags.slice(0, 8).join(', ')}${tags.length > 8 ? ', …' : ''}.`,
    );
    // Cross-mod caveat: a custom tag may actually be OWNED by a dependency, in
    // which case it needs the dependency's namespace (not this mod's) and must
    // NOT be re-registered here. We can't tell from one mod in isolation, so we
    // name the dependency mods to convert/coordinate with.
    const tagList = `${tags.slice(0, 12).join(', ')}${tags.length > 12 ? `, … (${tags.length} total)` : ''}`;
    const depNote = modMeta.deps.length > 0
      ? ` This mod's mod.info declares dependencies: ${modMeta.deps.join(', ')}. If any of these tags is defined by one of those mods, it must use THAT mod's namespace instead — convert those mods to B42 too and give the shared tag a single common namespace.`
      : ' If any of these tags is shared with another mod, every mod using it must adopt the same namespace.';
    report.warnings.push({
      file: regPath,
      level: 'warn',
      message: `Namespaced ${tags.length} custom ItemTag(s) to "${modId}:" and registered them in registries.lua: ${tagList}.${depNote}`,
    });
  }

  emitTranslations(outFiles, report, modRoot, txtConversions);

  return { files: outFiles, report };
}
