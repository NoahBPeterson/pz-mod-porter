// Fallback heuristics for inferring a B42 `timedAction` when a B41 recipe has
// no Sound/AnimNode to resolve against. Signal priority: kept-tool > skill >
// category (most-physical to least). Every target action was verified to exist
// in B42's timedAction definitions. Entries that would only map to the generic
// `Making` are omitted (no point — that's already the fallback).

// Kept-tool crafting tag (lowercased, from `Recipe.GetItemTypes.X`/items) -> action.
export const TOOL_TIMEDACTION: Readonly<Record<string, string>> = {
  weldingmask: 'Welding',
  blowtorch: 'Welding',
  mortarpestle: 'MixingMortarPestle',
  spoon: 'MixingBowl',
  scissors: 'SewingCloth',
  sewingneedle: 'SewingCloth',
  needle: 'SewingCloth',
  saw: 'SawSmallItemMetal',
  hacksaw: 'SawSmallItemMetal',
};

// SkillRequired skill name (lowercased) -> action.
export const SKILL_TIMEDACTION: Readonly<Record<string, string>> = {
  cooking: 'MixingBowl',
  metalwelding: 'Welding',
  tailoring: 'SewingCloth',
  electricity: 'MakingElectrical',
  blacksmith: 'SmithingHammer',
  carving: 'SharpenStakeWood',
};

// Recipe Category (lowercased) -> action. Broadest signal, lowest priority.
export const CATEGORY_TIMEDACTION: Readonly<Record<string, string>> = {
  cooking: 'MixingBowl',
  smithing: 'SmithingHammer',
  blacksmith: 'SmithingHammer',
  metalwork: 'Welding',
  welding: 'Welding',
  tailoring: 'SewingCloth',
  electrical: 'MakingElectrical',
  chemistry: 'MixingBowl',
  carving: 'SharpenStakeWood',
  stoneworking: 'Chisel_Surface',
  masonry: 'Make_With_Brick',
  pottery: 'Craft_PotteryBench',
  glassmaking: 'Craft_Glassmaking',
  jewelry: 'MakingJewellery',
  jewellery: 'MakingJewellery',
};

/**
 * Infer a timedAction from a recipe's kept tools, required skill, and category,
 * in that priority order. Returns undefined if nothing matches (-> caller uses
 * the generic `Making` default).
 */
export function inferTimedAction(
  keptTools: readonly string[],
  skill: string | undefined,
  category: string | undefined,
): string | undefined {
  for (const t of keptTools) {
    const a = TOOL_TIMEDACTION[t.toLowerCase()];
    if (a) return a;
  }
  if (skill) {
    const a = SKILL_TIMEDACTION[skill.toLowerCase()];
    if (a) return a;
  }
  if (category) {
    const a = CATEGORY_TIMEDACTION[category.toLowerCase()];
    if (a) return a;
  }
  return undefined;
}
