// When a mod overrides a base Lua file that B42 removed, the file's symbol is
// (in 131 of 132 cases, verified) genuinely gone — the subsystem was rebuilt
// with new names, not merged into a renamed file. So there is no 1:1 successor
// FILE to re-point to; what's useful is naming the B42 SUBSYSTEM that replaced
// it. These pointers are curated from the B42 reference (each successor symbol/
// system was verified to exist).
//
// Keyed by lowercased base filename. A prefix match (longest-first) covers
// families like ISFireplaceLightFrom*. Unlisted files fall back to a generic
// "symbol removed in B42" message.

export interface LuaSuccessor {
  system: string;
  pointer: string;
}

// Exact-filename overrides take priority, then prefix families.
export const LUA_SUCCESSOR_PREFIXES: ReadonlyArray<readonly [string, LuaSuccessor]> = [
  ['isblacksmith', { system: 'Crafting/Smithing', pointer: 'The capability survives, the ISBlacksmithMenu Lua menu does not. B42 handles welding/smithing through: skill `MetalWelding` (recipe `xpAward = MetalWelding:N`), item `Base.CraftingWeldingTorch` (a `DrainableComboItem` — query fuel via getUsedDelta()/getCurrentUses()), `timedAction Welding`/`Welding_Surface`, and Lua predicate `predicateBlowTorch()`. Re-implement as `craftRecipe` blocks; for "torch with most fuel" iterate torches comparing getCurrentUses().' }],
  ['isbsfurnace', { system: 'Crafting/Smithing', pointer: 'B42 rebuilt smithing/furnace into craftRecipe + workstation entities. Define the furnace as an `entity`; smithing recipes as `craftRecipe` with skill `MetalWelding`/`Blacksmith` and `Base.CraftingWeldingTorch` inputs.' }],
  ['isanvil', { system: 'Crafting/Smithing', pointer: 'B42 rebuilt anvil/smithing into craftRecipe + workstation entities; ISAnvil is gone. Use `craftRecipe` blocks with the `Blacksmith`/`MetalWelding` skill and `timedAction SmithingHammer`.' }],
  ['iscraftingcategoryui', { system: 'Crafting UI', pointer: 'B42 replaced the crafting menu with a multi-panel ISCraftingUI (ISCraftLogicPanel, ISCraftRecipePanel, …). Hook ISCraftingUI, not ISCraftingCategoryUI.' }],
  ['iscraftingui', { system: 'Crafting UI', pointer: 'B42 rebuilt the crafting window as a multi-panel ISCraftingUI; the old single-window API is gone.' }],
  ['isfishing', { system: 'Fishing', pointer: 'B42 reworked fishing (see media/lua fishing/*). The ISFishingAction/ISFishingUI tables were removed; re-point to the new fishing system.' }],
  ['isfireplace', { system: 'Fire / Campfire', pointer: 'B42 rebuilt fire/campfire handling via BuildRecipeCode.campfire and the new fuel/light system. The ISFireplace* actions no longer exist.' }],
  ['isdrum', { system: 'Metal Drum (removed)', pointer: 'B42 removed the metal-drum subsystem (ISDrum*/ISEmptyDrum/ISAddLogsInDrum). There is no direct replacement; rebuild on the generic fluid-container/craftRecipe systems.' }],
  ['ismetaldrum', { system: 'Metal Drum (removed)', pointer: 'B42 removed the metal-drum subsystem; rebuild on fluid containers / craftRecipe.' }],
  ['cmetaldrum', { system: 'Metal Drum (removed)', pointer: 'B42 removed the metal-drum global-object system (CMetalDrum*). No direct replacement.' }],
  ['campingtent', { system: 'Camping', pointer: 'B42 reworked camping/tents; the campingTent/ISAddTentAction code was removed. Re-point to the B42 camping system.' }],
  ['isaddtent', { system: 'Camping', pointer: 'B42 reworked camping/tents; ISAddTentAction no longer exists.' }],
];

export function findSuccessor(fileName: string): LuaSuccessor | undefined {
  const base = fileName.toLowerCase().replace(/\.lua$/, '');
  // longest prefix wins
  let best: LuaSuccessor | undefined;
  let bestLen = -1;
  for (const [prefix, succ] of LUA_SUCCESSOR_PREFIXES) {
    if (base.startsWith(prefix) && prefix.length > bestLen) { best = succ; bestLen = prefix.length; }
  }
  return best;
}
