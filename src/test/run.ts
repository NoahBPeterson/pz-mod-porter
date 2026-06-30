// Test harness for the converter engine. Build then run: npm test
// (compiles to dist/test/run.js and executes against ../reference/b41).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript, findBlocks, getProp } from '../parser.js';
import { serializeNode } from '../serializer.js';
import { transformRecipe } from '../transforms/recipe.js';
import { transformItem } from '../transforms/item.js';
import { lintLua, rewriteLua } from '../transforms/lua.js';
import { convertMod } from '../convert.js';
import { renderReportMarkdown } from '../report.js';
import { transformRecipeCode } from '../transforms/recipecode.js';
import { convertTranslationTxt, isTranslationTxt } from '../transforms/translation.js';
import { decodeText } from '../encoding.js';
import { buildXpIndex } from '../transforms/xp-index.js';
import type { ModFile, TransformContext } from '../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REF = path.resolve(here, '../../../reference/b41');

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
}

function ctx(extra: Partial<TransformContext> = {}): TransformContext {
  return { moduleName: 'Base', knownItems: new Set<string>(), translations: {}, usedIds: new Set<string>(), ...extra };
}

// --- Parser ---------------------------------------------------------------
{
  const src = `module Base {
    imports { Base }
    item Axe { DisplayName = Axe, Weight = 2, Type = Weapon, }
    /* nested /* comment */ still commented */
    recipe Make Thing {
      Plank,
      Nails=3,
      Glue;2,
      keep [Recipe.GetItemTypes.Hammer]/ClawHammer,
      Result:Thing=2,
      Time:50,
      Category:Carpentry,
    }
  }`;
  const ast = parseScript(src);
  const items = findBlocks(ast, 'item');
  const recipes = findBlocks(ast, 'recipe');
  check('parser: finds item', items.length === 1);
  check('parser: finds recipe', recipes.length === 1);
  check('parser: item prop', items[0] !== undefined && getProp(items[0], 'Weight') === '2');
  check('parser: nested comment stripped', recipes.length === 1);
  const r0 = recipes[0];
  if (r0) {
    const { block } = transformRecipe(r0, ctx({ moduleName: 'M' }));
    const t = serializeNode(block, 0);
    check('recipe: ;N quantity -> item 2', /item 2 Base\.Glue/.test(t), t);
    check('recipe: =N quantity -> item 3', /item 3 Base\.Nails/.test(t));
  } else check('recipe present', false);
}

// --- Recipe transform over the full reference corpus ----------------------
const recipesPath = path.join(REF, 'scripts/recipes.txt');
if (fs.existsSync(recipesPath)) {
  const recipes = findBlocks(parseScript(fs.readFileSync(recipesPath, 'utf8')), 'recipe');
  check('corpus: many recipes parsed', recipes.length > 200, `got ${recipes.length}`);
  let okAll = true;
  let badName: string | null = null;
  const translations: Record<string, string> = {};
  const usedIds = new Set<string>();
  for (const r of recipes) {
    try {
      const { block } = transformRecipe(r, ctx({ translations, usedIds }));
      const wrapped = `module Base {\n${serializeNode(block, 1)}\n}`;
      const cr = findBlocks(parseScript(wrapped), 'craftRecipe');
      const hasIn = findBlocks(block, 'inputs').length === 1;
      const hasOut = findBlocks(block, 'outputs').length === 1;
      const idOk = /^[A-Za-z_][A-Za-z0-9_]*$/.test(block.name);
      if (cr.length !== 1 || !hasIn || !hasOut || !idOk) { okAll = false; badName = r.name; break; }
    } catch (e) { okAll = false; badName = `${r.name}: ${e instanceof Error ? e.message : String(e)}`; break; }
  }
  check('corpus: every recipe -> valid craftRecipe', okAll, badName ?? '');
  check('corpus: translations unique-keyed', Object.keys(translations).length === recipes.length);

  const sl = recipes.find((r) => r.name === 'Saw Logs');
  if (sl) {
    const { block } = transformRecipe(sl, ctx());
    const txt = serializeNode(block, 0);
    check('SawLogs: keyword craftRecipe', block.keyword === 'craftRecipe');
    check('SawLogs: saw tag kept', txt.includes('tags[Saw] mode:keep'));
    // Prop2:Log -> flags[Prop2] on the Log input (matches B42 vanilla exactly).
    check('SawLogs: log gets flags[Prop2]', /item 1 Base\.Log flags\[Prop2\]/.test(txt), txt);
    check('SawLogs: OnGiveXP -> xpAward', /xpAward = Woodwork:3/.test(txt));
    check('SawLogs: 3 planks out', /item 3 Base\.Plank/.test(txt));
    check('SawLogs: CanBeDoneFromFloor -> Tags', /Tags = CanBeDoneFromFloor/.test(txt));
  } else check('SawLogs present', false);
} else {
  check('reference corpus available', false, `missing ${recipesPath}`);
}

// --- Item transform -------------------------------------------------------
{
  const src = `module Base { item Pistol { Type = Weapon, DisplayName = Pistol, ReplaceOnUseOn = WaterSource-X, } }`;
  const item = findBlocks(parseScript(src), 'item')[0];
  if (item) {
    const { block, warnings, displayName } = transformItem(item);
    const txt = serializeNode(block, 0);
    check('item: Type -> ItemType base:weapon', txt.includes('ItemType = base:weapon'));
    check('item: no leftover Type', !/\bType = /.test(txt));
    // ReplaceOnUseOn is still valid in B42 -> passes through.
    check('item: ReplaceOnUseOn passes through', /ReplaceOnUseOn = WaterSource-X/.test(txt));
    // DisplayName removed in B42 -> captured for ItemName.json migration, dropped from script.
    check('item: DisplayName captured', displayName === 'Pistol');
    check('item: DisplayName dropped from script', !/DisplayName/.test(txt));
    check('item: DisplayName migration warned', warnings.some((w) => /DisplayName.*ItemName\.json/.test(w)));
  } else check('item parsed', false);

  // B2: TeachedRecipes -> LearnedRecipes with recipe-ref sanitization.
  const book = findBlocks(parseScript(
    'module Base { item Mag { Type = Literature, TeachedRecipes = Basic Mechanics;59meteor.MakeTire;BarbedWireWeapon, } }',
  ), 'item')[0];
  if (book) {
    const { block, warnings } = transformItem(book);
    const txt = serializeNode(block, 0);
    check('B2: TeachedRecipes -> LearnedRecipes', /LearnedRecipes = /.test(txt) && !/TeachedRecipes/.test(txt));
    check('B2: spaced name -> ID', /Basic Mechanics/.test(txt) === false && /BasicMechanics/.test(txt));
    check('B2: module qualifier preserved', /59meteor\.MakeTire/.test(txt));
    check('B2: clean ID untouched', /BarbedWireWeapon/.test(txt));
    check('B2: NeedToBeLearn reminder warned', warnings.some((w) => /NeedToBeLearn = true/.test(w)));
  } else check('B2 book parsed', false);
}

// --- A2/A3/A5/A6: newly-automated recipe conversions -----------------------
{
  const mk = (body: string) => {
    const r = findBlocks(parseScript(`module Base { recipe R { ${body} } }`), 'recipe')[0];
    if (!r) throw new Error('no recipe');
    return transformRecipe(r, ctx());
  };

  // A2: OnGiveXP -> xpAward via vanilla table.
  {
    const t = serializeNode(mk('Plank, Result:Plank, OnGiveXP:Recipe.OnGiveXP.SawLogs,').block, 0);
    check('A2: OnGiveXP SawLogs -> xpAward Woodwork:3', /xpAward = Woodwork:3/.test(t), t);
  }
  // A2: None -> no xpAward, no warning.
  {
    const res = mk('Plank, Result:Plank, OnGiveXP:Recipe.OnGiveXP.None,');
    check('A2: None -> no xpAward', !/xpAward/.test(serializeNode(res.block, 0)));
    check('A2: None -> no OnGiveXP warning', !res.warnings.some((w) => w.includes('OnGiveXP')));
  }
  // A2: unknown mod function -> still warns.
  {
    const res = mk('Plank, Result:Plank, OnGiveXP:MyMod.OnGiveXP.Mystery,');
    check('A2: unknown OnGiveXP warns', res.warnings.some((w) => /OnGiveXP "MyMod\.OnGiveXP\.Mystery" isn't a static value/.test(w)));
  }
  // A3: (Sound, AnimNode) -> timedAction via the generated B42 map.
  {
    const t = serializeNode(mk('Plank, Result:Plank, Sound:Sawing, AnimNode:SawLog,').block, 0);
    check('A3: (Sawing,SawLog) -> timedAction SawLogs', /timedAction = SawLogs/.test(t) && !/= Making/.test(t), t);
  }
  // A3: Sound alone with anim resolves; e.g. SmashBottle = (BreakGlassItem, Making).
  {
    const t = serializeNode(mk('WineEmpty, Result:SmashedBottle, Sound:BreakGlassItem, AnimNode:Making,').block, 0);
    check('A3: (BreakGlassItem,Making) -> SmashBottle', /timedAction = SmashBottle/.test(t), t);
  }
  // A3: anim-only fallback (no Sound) still resolves.
  {
    const t = serializeNode(mk('Plank, Result:Plank, AnimNode:SawLog,').block, 0);
    check('A3: anim-only SawLog -> SawLogs', /timedAction = SawLogs/.test(t));
  }
  // A3: unmappable Sound + no other signal -> Making.
  {
    const t = serializeNode(mk('Plank, Result:Plank,').block, 0);
    check('A3: no signal -> Making', /timedAction = Making/.test(t));
  }
  // A1-heuristic: category -> timedAction.
  {
    const t = serializeNode(mk('Flour, Result:Bread, Category:Cooking,').block, 0);
    check('A1h: Category Cooking -> MixingBowl', /timedAction = MixingBowl/.test(t) && !/= Making/.test(t), t);
  }
  // A1-heuristic: skill beats category.
  {
    const t = serializeNode(mk('Metal, Result:Pipe, Category:Survivalist, SkillRequired:MetalWelding=2,').block, 0);
    check('A1h: skill MetalWelding -> Welding', /timedAction = Welding/.test(t), t);
  }
  // A1-heuristic: kept tool beats skill+category.
  {
    const t = serializeNode(mk('Cloth, keep [Recipe.GetItemTypes.MortarPestle], Result:Paste, Category:Cooking,').block, 0);
    check('A1h: tool MortarPestle -> MixingMortarPestle', /timedAction = MixingMortarPestle/.test(t), t);
  }
  // A1-heuristic: unknown category -> Making (no false inference).
  {
    const t = serializeNode(mk('Money, Result:Cash, Category:Buy Clothing,').block, 0);
    check('A1h: unknown category -> Making', /timedAction = Making/.test(t));
  }
  // A5: Prop1:item -> flags[Prop1] on matching input.
  {
    const t = serializeNode(mk('Screwdriver, Plank, Result:Plank, Prop1:Screwdriver,').block, 0);
    check('A5: Prop1 -> flags on matching input', /item 1 Base\.Screwdriver flags\[Prop1\]/.test(t), t);
  }
  // A6: mixed item+tag slot -> tags only, never combined.
  {
    const t = serializeNode(mk('keep [Recipe.GetItemTypes.SharpKnife]/MeatCleaver, Result:X,').block, 0);
    check('A6: mixed slot -> tags only', /item 1 tags\[SharpKnife\] mode:keep/.test(t) && !/\] tags\[/.test(t), t);
  }
  // A9: Tooltip is a valid B42 prop -> passes through, no warning.
  {
    const res = mk('Plank, Result:Plank, Tooltip:Tooltip_Craft_X,');
    check('A9: Tooltip passes through', /Tooltip = Tooltip_Craft_X/.test(serializeNode(res.block, 0)));
    check('A9: Tooltip no warning', !res.warnings.some((w) => /Tooltip/.test(w)));
  }
  // A9: Override/Heat dropped with guidance.
  {
    const res = mk('Plank, Result:Plank, Override:true, Heat:1.5,');
    const t = serializeNode(res.block, 0);
    check('A9: Override dropped', !/Override/.test(t));
    check('A9: Heat dropped', !/Heat/.test(t));
  }
  // AnimMode is an AnimNode alias -> feeds timedAction inference (not dropped/raw).
  {
    const res = mk('Plank, Result:Plank, Sound:Sawing, AnimMode:SawLog,');
    const t = serializeNode(res.block, 0);
    check('AnimMode: aliases AnimNode -> drives timedAction', /timedAction = SawLogs/.test(t) && !/AnimMode/.test(t));
  }
  // Obsolete:true -> whole recipe commented out (not re-enabled).
  {
    const res = mk('Plank, Result:Plank, Obsolete:true,');
    const t = serializeNode(res.block, 0);
    check('Obsolete: block commented out', /\/\* \[B41->B42\] recipe was Obsolete:true/.test(t) && /\*\/$/.test(t.trim()));
    check('Obsolete: craftRecipe inside the comment', /\/\*[\s\S]*craftRecipe[\s\S]*\*\//.test(t));
  }
  // IsHidden:true -> OnAddToMenu salvage (usable but hidden), not dropped.
  {
    const res = mk('Plank, Result:Plank, IsHidden:true,');
    const t = serializeNode(res.block, 0);
    check('IsHidden: OnAddToMenu emitted', /OnAddToMenu = B41Compat\.hideFromMenu/.test(t));
    check('IsHidden: flagged usedHideMenu', res.usedHideMenu === true);
  }
}

// --- AST recipecode transform ---------------------------------------------
{
  const src = [
    'require "recipecode"',
    '',
    'function Recipe.OnCreate.MakeThing(items, result, player)',
    '    player:getInventory():AddItems("X", 1)',
    'end',
    'function Recipe.OnGiveXP.GiveCooking(recipe, ingredients, result, player)',
    '    player:getXp():AddXP(Perks.Cooking, 5)',
    'end',
  ].join('\n');
  const r = transformRecipeCode(src);
  if (r) {
    const t = r.text;
    check('recipecode: require -> namespace guard', /Recipe = Recipe or \{\}/.test(t) && !/^require "recipecode"/m.test(t));
    check('recipecode: guards both namespaces', /Recipe\.OnCreate = Recipe\.OnCreate or \{\}/.test(t) && /Recipe\.OnGiveXP = Recipe\.OnGiveXP or \{\}/.test(t));
    check('recipecode: OnCreate -> B42 signature', /function Recipe\.OnCreate\.MakeThing\(craftRecipeData, character\)/.test(t));
    check('recipecode: player rebound from character', /local player = character/.test(t));
    check('recipecode: OnGiveXP signature untouched', /function Recipe\.OnGiveXP\.GiveCooking\(recipe, ingredients, result, player\)/.test(t));
    check('recipecode: body preserved', t.includes('player:getInventory():AddItems("X", 1)'));
  } else check('recipecode: parsed', false);

  // unused params are NOT rebound (no noise)
  {
    const r2 = transformRecipeCode('require "recipecode"\nfunction Recipe.OnCreate.Y(items, result, player)\n  result:setCooked(true)\nend');
    check('recipecode: only used params rebound', r2 != null && /local result = craftRecipeData/.test(r2.text) && !/local player =/.test(r2.text) && !/local items =/.test(r2.text));
  }
  // non-recipecode file -> null (falls back to line-level)
  check('recipecode: non-recipecode -> null', transformRecipeCode('local x = 1\nprint(x)') === null);

  // AST global re-roots (verified mappings) — even with no recipecode present.
  {
    const r = transformRecipeCode('if getPlayerCraftingUI(0):getIsVisible() then end');
    check('reroot: getPlayerCraftingUI -> ISEntityUI.GetWindowInstance', r != null &&
      r.text.includes('ISEntityUI.GetWindowInstance(0, "HandcraftWindow"):getIsVisible()'));
  }
  {
    const r = transformRecipeCode('getPlayerSafetyUI(playerNum):toggleSafety()');
    check('reroot: getPlayerSafetyUI -> getSpecificPlayer():getSafety', r != null &&
      r.text.includes('getSpecificPlayer(playerNum):getSafety():toggleSafety()'));
  }
  // method re-roots: weapon part getters -> getWeaponPart("X")
  {
    const r = transformRecipeCode('result:attachWeaponPart(item:getScope())\nresult:attachWeaponPart(item:getCanon())');
    check('reroot: getScope -> getWeaponPart("Scope")', r != null && r.text.includes('item:getWeaponPart("Scope")'));
    check('reroot: getCanon -> getWeaponPart("Canon")', r != null && r.text.includes('item:getWeaponPart("Canon")'));
    check('reroot: receiver preserved', r != null && r.text.includes('result:attachWeaponPart(item:getWeaponPart("Scope"))'));
  }
  // chained: weapon:getClip():getType()/getFullType() -> weapon:getMagazineType()
  {
    const r = transformRecipeCode('local t = weapon:getClip():getType()\nlocal f = item:getClip():getFullType()');
    check('reroot: getClip():getType() -> getMagazineType()', r != null && r.text.includes('weapon:getMagazineType()'));
    check('reroot: getClip():getFullType() -> getMagazineType()', r != null && r.text.includes('item:getMagazineType()'));
  }
  // getClip():getDisplayName() -> getItemNameFromFullType(getMagazineType())
  {
    const r = transformRecipeCode('local n = weapon:getClip():getDisplayName()');
    check('reroot: getClip():getDisplayName() -> getItemNameFromFullType', r != null &&
      r.text.includes('getItemNameFromFullType(weapon:getMagazineType())'));
  }
  // getClip() ~= nil / == nil -> isContainsClip() / not isContainsClip()
  {
    const r = transformRecipeCode('if item:getClip() ~= nil then end\nif weapon:getClip() == nil then end');
    check('reroot: getClip() ~= nil -> isContainsClip()', r != null && r.text.includes('if item:isContainsClip() then'));
    check('reroot: getClip() == nil -> not isContainsClip()', r != null && r.text.includes('if not weapon:isContainsClip() then'));
  }
  // attachWeaponPart(X:getClip()) -> magazine copy
  {
    const r = transformRecipeCode('result:attachWeaponPart(item:getClip())');
    check('reroot: attachWeaponPart(getClip()) -> magazine copy', r != null &&
      r.text.includes('result:setMagazineType(item:getMagazineType()); result:setContainsClip(item:isContainsClip())'));
  }
  // truly-bare getClip() (e.g. AnimationTrack) with no nil-check/attach -> LEFT ALONE
  {
    const r = transformRecipeCode('local c = track:getClip()');
    check('reroot: bare animation getClip left alone', r === null || r.text.includes('track:getClip()'));
  }
  // method re-root only fires on no-arg calls (avoid clobbering unrelated methods)
  {
    const r = transformRecipeCode('x:getScope(99)');
    check('reroot: arged getScope untouched', r === null || r.text.includes('x:getScope(99)'));
  }

  // re-root composes with recipecode in one file
  {
    const r = transformRecipeCode('require "recipecode"\nfunction Recipe.OnCreate.X(items, result, player)\n  if getPlayerCraftingUI(0) then result:setName("y") end\nend');
    check('reroot+recipecode compose', r != null &&
      /Recipe = Recipe or \{\}/.test(r.text) &&
      /function Recipe\.OnCreate\.X\(craftRecipeData, character\)/.test(r.text) &&
      r.text.includes('ISEntityUI.GetWindowInstance(0, "HandcraftWindow")'));
  }
}

// --- Lua lint -------------------------------------------------------------
{
  const sample = [
    'Events.OnGetTableResult.Add(handler)',
    'Events.OnPlayerUpdate.Add(handler)',
    'require "TimedActions/ISAnvil"',
    'local x = require("ISUI/ISInventoryPage")',
  ].join('\n');
  const f = lintLua(sample, 'media/lua/client/MyMod.lua');
  const rules = f.map((x) => x.rule);
  check('lua: removed event flagged', rules.includes('removed-event'));
  check('lua: OnPlayerUpdate not flagged', !f.some((x) => x.message.includes('OnPlayerUpdate')));
  check('lua: require removed-base flagged', rules.includes('require-removed'));
  const f2 = lintLua('-- patch', 'media/lua/client/ISAnvil.lua');
  check('lua: override of removed base flagged', f2.some((x) => x.rule === 'override-removed'));
  // Override-removed reports the B42 successor system when known.
  const fb = lintLua('-- patch', 'media/lua/client/ISBlacksmithMenu.lua');
  check('lua: override reports successor system', fb.some((x) => x.rule === 'override-removed' && /Smithing.*craftRecipe/.test(x.message)));
  const ff = lintLua('-- patch', 'media/lua/client/ISFireplaceLightFromPetrol.lua');
  check('lua: fireplace family -> Fire/Campfire', ff.some((x) => /Fire \/ Campfire/.test(x.message)));
  // Unknown removed file -> honest "no successor" message.
  const fu = lintLua('-- patch', 'media/lua/client/AStormIsComing.lua');
  check('lua: unknown removed -> no-successor note', fu.some((x) => x.rule === 'override-removed' && /no successor file/.test(x.message)));
}

// --- Lua REWRITER (actually edits the file) -------------------------------
{
  const src = [
    'local x = 1',
    'Events.OnGetTableResult.Add(function(a, b)',
    '    doThing(a)',
    'end)',
    'Events.OnPlayerUpdate.Add(handler)',
    'local M = require "TimedActions/ISAnvil"',
    'print("ok")',
  ].join('\n');
  const { text, rewrites } = rewriteLua(src, 'media/lua/client/Mod.lua');
  const out = text.split('\n');
  check('rewrite: removed-event statement commented (multi-line)',
    out.filter((l) => l.startsWith('-- Events.OnGetTableResult')).length === 1 &&
    out.some((l) => l.startsWith('--') && l.includes('doThing(a)')) &&
    out.some((l) => l === '-- end)'));
  check('rewrite: annotation inserted', out.some((l) => l.includes('[B41->B42] Event "OnGetTableResult"')));
  check('rewrite: kept-event untouched', out.some((l) => l === 'Events.OnPlayerUpdate.Add(handler)'));
  check('rewrite: removed require commented', out.some((l) => l.startsWith('-- local M = require')));
  check('rewrite: normal code preserved', out.includes('local x = 1') && out.includes('print("ok")'));
  check('rewrite: counts events + require', rewrites.length === 2);
  // A clean file is returned unchanged (no spurious edits).
  const clean = rewriteLua('Events.OnPlayerUpdate.Add(f)\nlocal y = getPlayer()', 'a.lua');
  check('rewrite: clean file unchanged', clean.rewrites.length === 0 && clean.text.includes('getPlayer()'));
}

// --- End-to-end convertMod ------------------------------------------------
{
  const mod: ModFile[] = [
    { path: 'M/mod.info', text: 'name=Demo\nid=demo' },
    { path: 'M/media/scripts/recipes.txt', text:
      'module D { imports { Base } recipe Make Widget { Plank, Nails=2, Result:Widget, Time:40, Category:Carpentry, } item Widget { Type = Normal, } }' },
    { path: 'M/media/lua/client/D.lua', text: 'Events.OnGetDBSchema.Add(f)\nEvents.OnPlayerUpdate.Add(g)' },
    { path: 'M/media/textures/i.png', text: null, bytes: new Uint8Array([0, 1, 2]) },
  ];
  const { files, report } = convertMod(mod);
  const recipes = files.find((f) => /recipes\.txt$/.test(f.path));
  const json = files.find((f) => /Recipes\.json$/.test(f.path));
  const png = files.find((f) => f.path.endsWith('.png'));
  check('e2e: recipe -> craftRecipe', recipes?.text != null && /craftRecipe MakeWidget/.test(recipes.text));
  check('e2e: item Type migrated', recipes?.text != null && /ItemType = base:normal/.test(recipes.text));
  check('e2e: Recipes.json emitted', json?.text != null && (JSON.parse(json.text) as Record<string, string>)['MakeWidget'] === 'Make Widget');
  check('e2e: removed-event Lua rewritten', report.lua.rewritten >= 1 && report.luaRewrites.some((r) => r.kind === 'comment-event'));
  const luaOut = files.find((f) => f.path.endsWith('D.lua'));
  check('e2e: rewritten Lua emitted', luaOut?.text != null && luaOut.text.includes('-- Events.OnGetDBSchema'));
  check('e2e: binary preserved untouched', png?.text == null && png?.bytes?.length === 3);
  check('e2e: report renders', renderReportMarkdown(report, 'Demo').includes('craftRecipe'));
  check('e2e: counts', report.recipes.converted === 1 && report.lua.scanned === 1);
}

// --- A2 runtime-XP -> OnCreate shim (needs convertMod's mod-Lua scan) -------
{
  const mod: ModFile[] = [
    { path: 'M/media/scripts/r.txt', text:
      'module D { recipe Make Foo { Plank, Result:Foo, OnGiveXP:DMod.RuntimeXP, } recipe Make Bar { Plank, Result:Bar, OnGiveXP:Recipe.OnGiveXP.SawLogs, } }' },
    { path: 'M/media/lua/client/x.lua', text:
      'DMod = {}\nfunction DMod.RuntimeXP(recipe, ingredients, result, player)\n  local xp = computeStuff() * player:getPerkLevel(Perks.Cooking)\n  player:getXp():AddXP(Perks.Cooking, xp)\nend' },
  ];
  const { files, report } = convertMod(mod);
  const scr = files.find((f) => /r\.txt$/.test(f.path));
  const shim = files.find((f) => /B41ToB42_XPShims\.lua$/.test(f.path));
  // Mod runtime fn -> OnCreate shim; vanilla deleted fn (SawLogs) -> static xpAward.
  check('A2 shim: mod fn -> OnCreate = B41XP', scr?.text != null && /OnCreate = B41XP\.MakeFoo/.test(scr.text));
  check('A2 shim: vanilla fn -> static xpAward', scr?.text != null && /xpAward = Woodwork:3/.test(scr.text));
  check('A2 shim: shim file generated', shim?.text != null && shim.text.includes('function B41XP.MakeFoo(params)'));
  check('A2 shim: shim calls original fn', shim?.text != null && shim.text.includes('DMod.RuntimeXP(recipe, ingredients, result, player)'));
  check('A2 shim: shim binds player from params', shim?.text != null && shim.text.includes('local player = params.character'));
  check('A2 shim: reported as artifact', report.artifacts.some((a) => /XP shim/.test(a)));
  // B41 Recipe adapter emitted, with verified method mapping + safe degradation.
  check('A2 shim: recipe adapter emitted', shim?.text != null && shim.text.includes('function B41Compat.wrapRecipe(craftRecipeData)'));
  check('A2 shim: getTimeToMake -> getTime', shim?.text != null && /getTimeToMake.*cr:getTime\(\)/.test(shim.text));
  check('A2 shim: size -> getInputCount', shim?.text != null && /function p:size\(\) return cr:getInputCount\(\)/.test(shim.text));
  check('A2 shim: removed methods no-op', shim?.text != null && /function p:add\(\) end/.test(shim.text) && /function p:contains\(\) return false/.test(shim.text));
  check('A2 shim: recipe bound via adapter', shim?.text != null && shim.text.includes('local recipe = B41Compat.wrapRecipe(crd)'));
  // Recursive adapters for the types getSource()/getResult() return.
  check('A2 shim: wrapSource emitted', shim?.text != null && shim.text.includes('function B41Compat.wrapSource(inputScript)'));
  check('A2 shim: wrapResult emitted', shim?.text != null && shim.text.includes('function B41Compat.wrapResult(outputScript, created)'));
  check('A2 shim: source:get -> getFullName', shim?.text != null && /it:getFullName\(\)/.test(shim.text));
  check('A2 shim: source:size -> getPossibleInputItems', shim?.text != null && /getPossibleInputItems\(\)/.test(shim.text));
  check('A2 shim: result type -> created item', shim?.text != null && /created:getFullType\(\)/.test(shim.text));
  check('A2 shim: result count -> getIntAmount', shim?.text != null && /outputScript:getIntAmount\(\)/.test(shim.text));
  check('A2 shim: getSource returns wrapped source', shim?.text != null && /B41Compat\.wrapSource\(i:get\(n\)\)/.test(shim.text));
}

// --- Cross-mod XP resolution + dependency inlining ------------------------
{
  const lib: ModFile[] = [
    { path: 'L/media/lua/server/XPLib.lua', text:
      'function Give3CookingXP(recipe, ing, res, p) p:getXp():AddXP(Perks.Cooking, 3) end\n' +
      'function RuntimeLibXP(recipe, ing, res, p) local x = p:getPerkLevel(Perks.Tailoring); p:getXp():AddXP(Perks.Tailoring, x) end' },
  ];
  const idx = buildXpIndex([lib]);
  check('xpindex: clean lib fn -> award', idx.get('Give3CookingXP')?.kind === 'award');
  check('xpindex: runtime lib fn -> inline', idx.get('RuntimeLibXP')?.kind === 'inline');

  const recipeMod: ModFile[] = [
    { path: 'M/media/scripts/r.txt', text:
      'module D { recipe Make A { Bowl, Result:A, OnGiveXP:Give3CookingXP, } recipe Make B { Bowl, Result:B, OnGiveXP:RuntimeLibXP, } }' },
  ];
  const { files } = convertMod(recipeMod, { xpIndex: idx });
  const scr = files.find((f) => /r\.txt$/.test(f.path));
  const shim = files.find((f) => /XPShims/.test(f.path));
  check('xpindex: clean cross-mod -> static xpAward', scr?.text != null && /xpAward = Cooking:3/.test(scr.text));
  check('xpindex: runtime cross-mod -> OnCreate shim', scr?.text != null && /OnCreate = B41XP\.MakeB/.test(scr.text));
  check('xpindex: dependency fn inlined', shim?.text != null && shim.text.includes('function RuntimeLibXP') && shim.text.includes('Inlined from a dependency'));
  // Without the index, the clean lib fn isn't resolvable (control check).
  const { files: f2 } = convertMod(recipeMod);
  const scr2 = f2.find((f) => /r\.txt$/.test(f.path));
  check('xpindex: without index, clean fn unresolved', scr2?.text != null && !/xpAward = Cooking:3/.test(scr2.text));
}

// --- Translation .txt -> .json --------------------------------------------
{
  const P = 'M/media/lua/shared/Translate/EN/';
  // ItemName: strip the `ItemName_` prefix; keep the Module.Id remainder.
  const itemName = convertTranslationTxt(`${P}ItemName_EN.txt`,
    'ItemName_EN = {\n  ItemName_Base.Axe = "Fire Axe",\n  ItemName_Base.Pan = "Frying Pan",\n}');
  check('trans: ItemName outPath', itemName?.outPath === `${P}ItemName.json`);
  check('trans: ItemName prefix stripped', itemName?.entries['Base.Axe'] === 'Fire Axe' && itemName?.entries['Base.Pan'] === 'Frying Pan');
  check('trans: ItemName lang from dir', itemName?.lang === 'EN');

  // IG_UI: var IGUI -> file IG_UI; the IGUI_ key prefix is KEPT.
  const igui = convertTranslationTxt(`${P}IG_UI_EN.txt`, 'IGUI_EN = {\n  IGUI_CraftUI_Title = "Craft",\n}');
  check('trans: IGUI -> IG_UI.json', igui?.outPath === `${P}IG_UI.json`);
  check('trans: IGUI prefix kept', igui?.entries['IGUI_CraftUI_Title'] === 'Craft');

  // Recipe: var Recipe -> file Recipes; `Recipe_` prefix stripped.
  const rec = convertTranslationTxt(`${P}Recipes_EN.txt`, 'Recipe_EN = {\n  Recipe_MakeHood = "Make Hood",\n}');
  check('trans: Recipe -> Recipes.json', rec?.outPath === `${P}Recipes.json`);
  check('trans: Recipe prefix stripped', rec?.entries['MakeHood'] === 'Make Hood');

  // Moveables: digit-leading bare keys, no prefix to strip.
  const mov = convertTranslationTxt(`${P}Moveables_EN.txt`, 'Moveables_EN = {\n  50s_Barstool = "Old Stool",\n}');
  check('trans: Moveables digit key', mov?.entries['50s_Barstool'] === 'Old Stool');

  // Tooltip: kept prefix + value with embedded unescaped quotes (engine-style
  // first..last quote extraction) survive as valid JSON.
  const tip = convertTranslationTxt(`${P}Tooltip_EN.txt`, 'Tooltip_EN = {\n  Tooltip_X = "Press "go" now",\n}');
  check('trans: embedded quotes preserved', tip?.entries['Tooltip_X'] === 'Press "go" now');

  // Comments (-- line, /* */, --[[ ]] block) ignored; brace on next line.
  const sandbox = convertTranslationTxt(`${P}Sandbox_EN.txt`,
    'Sandbox_EN =\n{\n  -- a line comment\n  /* block */ Sandbox_A = "Alpha", -- trailing\n  --[[ off\n  Sandbox_Hidden = "no", ]]\n  Sandbox_B = "Beta",\n}');
  check('trans: comments stripped', sandbox?.entries['Sandbox_A'] === 'Alpha' && sandbox?.entries['Sandbox_B'] === 'Beta');
  check('trans: commented entry omitted', sandbox?.entries['Sandbox_Hidden'] === undefined);

  // Escapes: \n decoded then JSON-re-encoded (round-trips through JSON.parse).
  const esc = convertTranslationTxt(`${P}UI_EN.txt`, 'UI_EN = {\n  UI_Multi = "line1\\nline2",\n}');
  check('trans: \\n decoded', esc?.entries['UI_Multi'] === 'line1\nline2');

  // Non-EN language taken from the directory, not the filename/var.
  const es = convertTranslationTxt('M/media/lua/shared/Translate/ES/ItemName_ES.txt', 'ItemName_ES = {\n  ItemName_Base.Axe = "Hacha",\n}');
  check('trans: ES dir', es?.lang === 'ES' && es?.outPath === 'M/media/lua/shared/Translate/ES/ItemName.json');

  check('trans: isTranslationTxt true', isTranslationTxt('x/Translate/EN/ItemName_EN.txt'));
  check('trans: isTranslationTxt false (scripts)', !isTranslationTxt('x/media/scripts/items.txt'));

  // Permissive keys: UUID/hyphen, punctuation runs, and colons all survive.
  const rm = convertTranslationTxt(`${P}Recorded_Media_EN.txt`,
    '// itemDisplayName\nRM_803c516d-a209-4ba8-9695-8865653d0fce = "Home VHS",\n');
  check('trans: headerless UUID-hyphen key', rm?.entries['RM_803c516d-a209-4ba8-9695-8865653d0fce'] === 'Home VHS');
  const cos = convertTranslationTxt(`${P}Items_EN.txt`, 'Items_EN = {\n  DisplayName_Wand:Sectumsempra_(Female) = "Sectumsempra",\n}');
  check('trans: colon+paren key', cos?.entries['DisplayName_Wand:Sectumsempra_(Female)'] === 'Sectumsempra');

  // Empty stub table -> null (nothing to emit, not an error).
  check('trans: empty table -> null', convertTranslationTxt(`${P}Tooltip_EN.txt`, 'Tooltip_EN = {\n}') === null);
  // A `language.txt`-style config (no quoted entries) -> null, so convert() keeps
  // the original file (B42 still reads language.txt).
  check('trans: non-table config -> null', convertTranslationTxt(`${P}language.txt`, 'text = English\ncharset = UTF-8') === null);
}

// --- convertMod: translations end-to-end ----------------------------------
{
  const mod: ModFile[] = [
    { path: 'M/media/scripts/i.txt', text: 'module Base { item Axe { Type = Weapon, DisplayName = Trusty Axe, } item Pan { Type = Normal, DisplayName = Old Pan, } }' },
    { path: 'M/media/lua/shared/Translate/EN/ItemName_EN.txt', text: 'ItemName_EN = {\n  ItemName_Base.Pan = "Frying Pan",\n}' },
    { path: 'M/media/lua/shared/Translate/EN/IG_UI_EN.txt', text: 'IGUI_EN = {\n  IGUI_Foo = "Bar",\n}' },
  ];
  const { files } = convertMod(mod);
  const txtLeft = files.filter((f) => /Translate\/.*\.txt$/.test(f.path));
  check('e2e-trans: .txt dropped', txtLeft.length === 0);
  const itemNameJson = files.find((f) => /Translate\/EN\/ItemName\.json$/.test(f.path));
  const parsed = itemNameJson?.text != null ? (JSON.parse(itemNameJson.text) as Record<string, string>) : {};
  // Modder's explicit ItemName_EN.txt wins; DisplayName fills the gap (Axe).
  check('e2e-trans: ItemName.json from .txt', parsed['Base.Pan'] === 'Frying Pan');
  check('e2e-trans: DisplayName migrated to ItemName.json', parsed['Base.Axe'] === 'Trusty Axe');
  const iguiJson = files.find((f) => /Translate\/EN\/IG_UI\.json$/.test(f.path));
  check('e2e-trans: IG_UI.json emitted', iguiJson?.text != null && /"IGUI_Foo": "Bar"/.test(iguiJson.text));
  const scriptOut = files.find((f) => /scripts\/i\.txt$/.test(f.path));
  check('e2e-trans: DisplayName stripped from item script', scriptOut?.text != null && !/DisplayName/.test(scriptOut.text));
}

// --- Text decoding (encoding detection) -----------------------------------
{
  const enc = new TextEncoder();
  const u16le = (s: string, bom: boolean): Uint8Array => {
    const body = new Uint8Array(s.length * 2 + (bom ? 2 : 0));
    let o = 0;
    if (bom) { body[o++] = 0xff; body[o++] = 0xfe; }
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); body[o++] = c & 0xff; body[o++] = c >> 8; }
    return body;
  };
  const u16be = (s: string, bom: boolean): Uint8Array => {
    const body = new Uint8Array(s.length * 2 + (bom ? 2 : 0));
    let o = 0;
    if (bom) { body[o++] = 0xfe; body[o++] = 0xff; }
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); body[o++] = c >> 8; body[o++] = c & 0xff; }
    return body;
  };
  const sample = 'ItemName_KO = {\n  Foo = "Bar",\n}';
  check('enc: plain UTF-8', decodeText(enc.encode(sample)) === sample);
  check('enc: UTF-8 BOM stripped', decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('Hi')])) === 'Hi');
  check('enc: UTF-16 LE w/ BOM', decodeText(u16le(sample, true)) === sample);
  check('enc: UTF-16 BE w/ BOM', decodeText(u16be(sample, true)) === sample);
  check('enc: UTF-16 LE no BOM (NUL heuristic)', decodeText(u16le(sample, false)) === sample);
  check('enc: UTF-16 BE no BOM (NUL heuristic)', decodeText(u16be(sample, false)) === sample);
  // windows-1252 byte 0xFA = "ú" — invalid UTF-8, recovered via the ES charset.
  check('enc: legacy 1252 by lang', decodeText(new Uint8Array([0x61, 0x7a, 0xfa, 0x63, 0x61, 0x72]), 'x/Translate/ES/ItemName_ES.txt') === 'azúcar');
  // Genuinely-accented UTF-8 is preserved (not mistaken for legacy).
  check('enc: UTF-8 accents preserved', decodeText(enc.encode('café'), 'x/Translate/FR/UI_FR.txt') === 'café');
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}  —  ${pass} passed, ${fail} failed`);
if (failures.length > 0) { console.log(failures.map((s) => '  ✗ ' + s).join('\n')); process.exit(1); }
