// Curated B41 -> B42 global re-root rules, verified by reverse-engineering the
// B42 source (each successor was confirmed in B42's own Lua/engine). These are
// NOT 1:1 renames — the call is re-rooted onto where B42 relocated the concept,
// so they're applied at the AST level (a CallExpression -> a new expression
// built from the original argument).

export interface RerootRule {
  /** The removed B41 global function name. */
  global: string;
  /** Build the B42 replacement expression from the original call's arg sources. */
  rewrite: (args: readonly string[]) => string;
  /** Short provenance note (for the change log). */
  note: string;
}

export const LUA_REROOTS: readonly RerootRule[] = [
  {
    // B42 folded crafting into the Entity-UI system; the per-player window is
    // keyed by name. Verified against B42's own "Crafting UI" keybind handler
    // (XpSystem/XpUpdate.lua): ISEntityUI.GetWindowInstance(0, "HandcraftWindow").
    global: 'getPlayerCraftingUI',
    rewrite: (a) => `ISEntityUI.GetWindowInstance(${a[0] ?? '0'}, "HandcraftWindow")`,
    note: 'getPlayerCraftingUI(n) -> ISEntityUI.GetWindowInstance(n, "HandcraftWindow")',
  },
  {
    // Weapon safety moved from a UI object onto the character. Verified:
    // IsoPlayer:getSafety() returns a zombie.characters.Safety with the same
    // toggleSafety()/isEnabled() methods the old UI exposed.
    global: 'getPlayerSafetyUI',
    rewrite: (a) => `getSpecificPlayer(${a[0] ?? '0'}):getSafety()`,
    note: 'getPlayerSafetyUI(n) -> getSpecificPlayer(n):getSafety()',
  },
];

export const REROOT_BY_NAME: ReadonlyMap<string, RerootRule> = new Map(
  LUA_REROOTS.map((r) => [r.global, r]),
);

// Method re-roots: `<expr>:oldMethod()` -> `<expr>:getWeaponPart("Location")`.
// B42 unified B41's named weapon-part getters into getWeaponPart(location), where
// getWeaponPart(s) does `attachments.get(s)`. Verified by DECOMPILING the engine
// (CFR), not javap:
//   * each old getter is declared in ZERO B42 classes (truly removed), AND
//   * the location strings are exactly B41's PartType set: Canon/RecoilPad/
//     Scope/Sling/Stock.
// `getClip` is deliberately EXCLUDED: it still exists as AnimationTrack.getClip()
// (collision), and B41's getClip was the *magazine* — not a part mount — so there
// is no getWeaponPart location for it. (Magazine handling is flagged, not rewritten.)
const PART_GETTERS: Readonly<Record<string, string>> = {
  getScope: 'Scope',
  getCanon: 'Canon',
  getStock: 'Stock',
  getSling: 'Sling',
  getRecoilpad: 'RecoilPad',
  getRecoilPad: 'RecoilPad',
};

export const METHOD_REROOTS: ReadonlyMap<string, (receiver: string) => string> = new Map(
  Object.entries(PART_GETTERS).map(([method, part]) => [method, (r: string) => `${r}:getWeaponPart("${part}")`]),
);

// Chained method re-roots: `<recv>:inner():finalizer()` -> `<recv>:replacement()`.
// B42 replaced the weapon's clip OBJECT (B41 getClip()) with a magazine TYPE
// string. Verified in the decompiled engine: getMagazineType() { return
// this.magazineType }. So `weapon:getClip():getType()` (the dominant use — the
// modder wants the magazine type) collapses to `weapon:getMagazineType()`.
// Bare `getClip()` (the magazine object) and `getClip():getDisplayName()` have
// no clean equivalent (the object no longer lives on the weapon) and are left
// untouched for manual review.
export interface ChainedReroot {
  inner: string;
  finalizer: string;
  /** Build the replacement expression from the inner-call receiver text. */
  build: (receiver: string) => string;
  note: string;
}

export const CHAINED_REROOTS: readonly ChainedReroot[] = [
  // The magazine type the modder wanted.
  { inner: 'getClip', finalizer: 'getType', build: (r) => `${r}:getMagazineType()`, note: 'getClip():getType() -> getMagazineType()' },
  { inner: 'getClip', finalizer: 'getFullType', build: (r) => `${r}:getMagazineType()`, note: 'getClip():getFullType() -> getMagazineType()' },
  // Display name of the magazine: look it up from the type (verified global).
  { inner: 'getClip', finalizer: 'getDisplayName', build: (r) => `getItemNameFromFullType(${r}:getMagazineType())`, note: 'getClip():getDisplayName() -> getItemNameFromFullType(getMagazineType())' },
];

// `<recv>:getClip()` compared to nil -> `<recv>:isContainsClip()` ("a magazine is
// loaded"). Verified: isContainsClip(){ return this.containsClip }.
export const NILCHECK_REROOT = {
  method: 'getClip',
  truthy: (recv: string) => `${recv}:isContainsClip()`,       // getClip() ~= nil
  falsy: (recv: string) => `not ${recv}:isContainsClip()`,    // getClip() == nil
} as const;

// `<a>:attachWeaponPart(<b>:getClip())` -> copy the magazine state, since B42
// magazines aren't weapon parts: setMagazineType + setContainsClip.
export const ATTACH_CLIP_REROOT = {
  outerMethod: 'attachWeaponPart',
  innerMethod: 'getClip',
  build: (target: string, source: string) =>
    `${target}:setMagazineType(${source}:getMagazineType()); ${target}:setContainsClip(${source}:isContainsClip())`,
  note: 'attachWeaponPart(getClip()) -> setMagazineType()+setContainsClip() (B42 magazine copy)',
} as const;
