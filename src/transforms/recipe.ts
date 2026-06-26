// B41 `recipe` -> B42 `craftRecipe` transform. See design notes in the JS
// original; this is the strict-typed implementation.

import type { BlockNode, LineNode, PropNode, ScriptNode, TransformContext, XpShim } from '../types.js';
import { VANILLA_XP_AWARDS } from '../data/xp-awards.js';
import {
  TIMEDACTION_BY_SOUND_ANIM,
  TIMEDACTION_BY_ANIM,
  COLLIDING_KEYS,
} from '../data/timedaction-map.js';
import { inferTimedAction } from '../data/timedaction-heuristics.js';

const TAG_FUNC_RE = /^\[Recipe\.GetItemTypes\.([A-Za-z0-9_]+)\]$/;

// Resolve a B41 (Sound, AnimNode) pair to a B42 timedAction. Prefer the exact
// (sound, anim) match; fall back to anim-only. Returns the action plus whether
// the match was ambiguous (collision) so the caller can warn.
function resolveTimedAction(
  sound: string | undefined,
  anim: string | undefined,
): { action: string; ambiguous: boolean } | undefined {
  if (sound && anim) {
    const key = `${sound}|${anim}`;
    const action = TIMEDACTION_BY_SOUND_ANIM[key];
    if (action) return { action, ambiguous: COLLIDING_KEYS.has(key) };
  }
  if (anim) {
    const action = TIMEDACTION_BY_ANIM[anim];
    if (action) return { action, ambiguous: COLLIDING_KEYS.has(`anim:${anim}`) };
  }
  return undefined;
}

// Recognised B41 recipe property keys (anything else with `=` is an
// ingredient-with-quantity, not a property).
const RECIPE_PROP_KEYS: ReadonlySet<string> = new Set([
  'result', 'resultitem', 'time', 'category', 'timedaction', 'skillrequired',
  'needtobelearn', 'oncreate', 'ontest', 'oncanperform', 'ongivexp', 'sound',
  'animnode', 'nearitem', 'allowdestroyeditem', 'allowrottenitem',
  'allowfrozenitem', 'insameinventory', 'stoponwalk', 'stoponrun', 'name',
  'maxitems', 'removeresultitem', 'isheatsource', 'heat', 'prop1', 'prop2',
  'ishidden', 'obsolete', 'animmode', 'override', 'nobrokenitems',
]);

const PASSTHROUGH: ReadonlySet<string> = new Set([
  'OnCreate', 'OnTest', 'OnCanPerform', 'AllowDestroyedItem', 'AllowRottenItem',
  'AllowFrozenItem', 'InSameInventory', 'StopOnWalk', 'StopOnRun',
]);

// Valid B42 craftRecipe properties (lowercased), from the pz-scripts-data schema
// cross-checked against the engine's CraftRecipe.class string constants. A B41
// recipe that already uses one of these passes through silently (no warning).
const VALID_CRAFTRECIPE_PROPS: ReadonlySet<string> = new Set([
  'allowbatchcraft', 'animation', 'autolearnall', 'autolearnany', 'canwalk',
  'category', 'icon', 'metarecipe', 'needtobelearn', 'onaddtomenu', 'oncreate',
  'onfailed', 'ontest', 'onupdate', 'overlaystyle', 'recipegroup', 'researchany',
  'researchskilllevel', 'skillrequired', 'tags', 'time', 'timedaction',
  'tooltip', 'xpaward',
]);

// B41 recipe properties confirmed absent from B42 craftRecipe (not in the schema
// nor the engine constants). Dropped from output with specific guidance rather
// than emitted as dead/ignored properties.
const REMOVED_RECIPE_PROPS: Readonly<Record<string, string>> = {
  override: 'B42 overrides recipes automatically by matching craftRecipe ID — give this recipe the same ID as the one it replaces; the explicit Override flag is gone.',
  removeresultitem: 'RemoveResultItem is not a B42 craftRecipe property — remove/replace items inside an OnCreate function instead.',
  nobrokenitems: 'NoBrokenItems is gone — in B42 restrict ingredient condition with input flags (e.g. omit AllowDestroyedItem) on the relevant input.',
  heat: 'Heat is not a B42 craftRecipe property — cooking heat is modeled by the timedAction / workstation in B42.',
};

interface Ingredient {
  count: number;
  items: string[];
  tags: string[];
  mode: 'keep' | 'destroy';
  warnings: string[];
}

export interface RecipeResult {
  block: BlockNode;
  warnings: string[];
  id: string;
  displayName: string;
  /** Recipe used IsHidden -> emitted OnAddToMenu; caller must ship the helper. */
  usedHideMenu?: boolean;
}

function qualify(name: string, ctx: Pick<TransformContext, 'moduleName' | 'knownItems'>): string {
  if (!name || name.includes('.')) return name;
  if (ctx.knownItems.has(name)) return `${ctx.moduleName}.${name}`;
  return `Base.${name}`;
}

export function sanitizeId(name: string): string {
  const id = name
    .replace(/[^A-Za-z0-9_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return id || 'Recipe';
}

function parseIngredient(
  text: string,
  ctx: Pick<TransformContext, 'moduleName' | 'knownItems'>,
): Ingredient | null {
  const warnings: string[] = [];
  let mode: 'keep' | 'destroy' = 'destroy';
  let s = text.trim();
  if (!s) return null;

  const kw = /^(keep|destroy|remove)\s+(.*)$/i.exec(s);
  if (kw) {
    const k = (kw[1] ?? '').toLowerCase();
    if (k === 'keep') mode = 'keep';
    s = (kw[2] ?? '').trim();
  }

  // Whole-line quantity: `Nails=5` or `Nails;5`.
  let count = 1;
  const qty = /[;=]\s*(\d+)\s*$/.exec(s);
  if (qty && qty.index !== undefined) {
    count = parseInt(qty[1] ?? '1', 10);
    s = s.slice(0, qty.index).trim();
  }

  const items: string[] = [];
  const tags: string[] = [];
  for (const rawAlt of s.split('/')) {
    const alt = rawAlt.trim();
    if (!alt) continue;
    const tagFn = TAG_FUNC_RE.exec(alt);
    if (tagFn && tagFn[1]) { tags.push(tagFn[1]); continue; }
    const lit = /^\[(.+)\]$/.exec(alt);
    if (lit && lit[1]) {
      for (const it of lit[1].split(/[;,]/)) {
        const t = it.trim();
        if (t) items.push(qualify(t, ctx));
      }
      continue;
    }
    const ialt = /^(.+?)\s*[;=]\s*(\d+)$/.exec(alt);
    if (ialt && ialt[1] && ialt[2]) {
      count = parseInt(ialt[2], 10);
      items.push(qualify(ialt[1].trim(), ctx));
      continue;
    }
    if (/[()]/.test(alt) || alt.startsWith('Recipe.')) {
      warnings.push(`Ingredient "${alt}" is a Lua reference; review manually.`);
      continue;
    }
    items.push(qualify(alt, ctx));
  }

  if (items.length === 0 && tags.length === 0) {
    warnings.push(`Could not interpret ingredient line: "${text}".`);
    return null;
  }
  if (items.length > 0 && tags.length > 0) {
    // B42 does not allow [items] and tags[] in a single input slot (0 such
    // lines in all of vanilla B42). The tag group is the broader set, so emit
    // tags[...] and flag the specific items for verification.
    warnings.push(`Ingredient "${text}": B42 can't combine specific items and a tag group in one slot — kept tags[${tags.join(';')}] and dropped [${items.join(';')}]. Verify those items carry the tag, or add a separate input.`);
  }
  return { count, items, tags, mode, warnings };
}

function ingredientToLine(ing: Ingredient): LineNode {
  let spec: string;
  if (ing.items.length > 0 && ing.tags.length > 0) {
    // Mixed slot is invalid in B42 (see parseIngredient warning) — keep the
    // broader tag group, which is valid.
    spec = `tags[${ing.tags.join(';')}]`;
  } else if (ing.items.length === 1) {
    spec = ing.items[0] ?? '';
  } else if (ing.items.length > 1) {
    spec = `[${ing.items.join(';')}]`;
  } else {
    spec = `tags[${ing.tags.join(';')}]`;
  }
  const modePart = ing.mode === 'keep' ? ' mode:keep' : '';
  return { type: 'line', text: `item ${ing.count} ${spec}${modePart}` };
}

function mapSkillRequired(value: string): string {
  return value
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => p.replace(/\s*=\s*/, ':'))
    .join(';');
}

function resultToOutput(value: string, ctx: Pick<TransformContext, 'moduleName' | 'knownItems'>): LineNode {
  const m = /^(.+?)\s*=\s*(\d+)\s*$/.exec(value);
  const name = (m && m[1] ? m[1] : value).trim();
  const count = m && m[2] ? parseInt(m[2], 10) : 1;
  return { type: 'line', text: `item ${count} ${qualify(name, ctx)}` };
}

// Append a B42 input flag to an `item ...` line, merging into any existing
// flags[...] block (B42 puts flags last).
function appendFlag(text: string, flag: string): string {
  const m = /flags\[([^\]]*)\]/.exec(text);
  if (m) {
    const set = new Set((m[1] ?? '').split(';').filter((s) => s.length > 0));
    set.add(flag);
    return text.replace(/flags\[[^\]]*\]/, `flags[${[...set].join(';')}]`);
  }
  return `${text} flags[${flag}]`;
}

// A B41 `Prop1:<value>` names which ingredient is the property source. Attach
// the corresponding B42 `flags[Prop1/Prop2]` to the matching input line.
function attachPropFlag(inputs: ScriptNode[], target: string, flag: 'Prop1' | 'Prop2'): boolean {
  const token = target.replace(/^Base\./i, '').trim();
  if (!token) return false;
  const re = new RegExp(`\\b${token}\\b`, 'i');
  for (const input of inputs) {
    if (input.type === 'line' && re.test(input.text)) {
      input.text = appendFlag(input.text, flag);
      return true;
    }
  }
  return false;
}

// A2: resolve a B41 OnGiveXP reference to a B42 `xpAward` value.
// `Recipe.OnGiveXP.SawLogs` / `MyMod.OnGiveXP.Foo` -> looked up by last segment.
// Returns: { award } to emit `xpAward = award`; { award: null } to emit nothing
// (B41 awarded no XP); undefined when the function is unknown (keep warning).
function resolveXpAward(
  ref: string,
  table: Readonly<Record<string, string | null>>,
): { award: string | null } | undefined {
  const name = ref.split('.').pop() ?? ref;
  if (Object.prototype.hasOwnProperty.call(table, name)) return { award: table[name] ?? null };
  return undefined;
}

export function transformRecipe(recipe: BlockNode, ctx: TransformContext): RecipeResult {
  const localCtx = { moduleName: ctx.moduleName, knownItems: ctx.knownItems };
  const warnings: string[] = [];

  const xpTable = ctx.xpAwards ?? VANILLA_XP_AWARDS;
  const inputs: ScriptNode[] = [];
  const outputs: ScriptNode[] = [];
  const props: PropNode[] = [];
  const tagsAccum: string[] = [];
  const pendingFlags: Array<{ flag: 'Prop1' | 'Prop2'; target: string }> = [];
  let animNode: string | undefined;
  let soundValue: string | undefined;
  let onCreateRef: string | undefined;
  let onGiveXpRef: string | undefined;
  let categoryValue: string | undefined;
  let skillValue: string | undefined;
  const keptTools: string[] = [];
  let obsolete = false;
  let hiddenFromMenu = false;
  let hasTimedAction = false;
  let hasTime = false;

  const displayName = recipe.name;
  let id = sanitizeId(displayName);
  if (ctx.usedIds.has(id)) {
    let i = 2;
    while (ctx.usedIds.has(`${id}_${i}`)) i++;
    warnings.push(`[${id}] duplicate recipe name; renamed to "${id}_${i}" to keep B42 IDs unique.`);
    id = `${id}_${i}`;
  }
  ctx.usedIds.add(id);

  for (const child of recipe.children) {
    const isQtyIngredient =
      child.type === 'prop' && child.op === '=' && !RECIPE_PROP_KEYS.has(child.key.toLowerCase());

    if (child.type === 'line' || isQtyIngredient) {
      const text = child.type === 'line' ? child.text : `${child.key}=${child.value}`;
      const ing = parseIngredient(text, localCtx);
      if (ing) {
        warnings.push(...ing.warnings.map((w) => `[${id}] ${w}`));
        // Kept tools (mode:keep) drive the timedAction heuristic — record tag
        // names and bare item basenames.
        if (ing.mode === 'keep') {
          for (const t of ing.tags) keptTools.push(t);
          for (const it of ing.items) keptTools.push(it.replace(/^Base\./i, ''));
        }
        inputs.push(ingredientToLine(ing));
      } else {
        warnings.push(`[${id}] dropped ingredient: "${text}"`);
      }
      continue;
    }

    if (child.type !== 'prop') continue;
    const key = child.key;
    const val = child.value;
    switch (key.toLowerCase()) {
      case 'result':
      case 'resultitem':
        outputs.push(resultToOutput(val, localCtx));
        break;
      case 'time':
        props.push({ type: 'prop', key: 'time', op: '=', value: String(Math.round(parseFloat(val) || 0)) });
        hasTime = true;
        break;
      case 'category':
        props.push({ type: 'prop', key: 'category', op: '=', value: val });
        categoryValue = val.split(/[;,]/)[0]?.trim();
        break;
      case 'timedaction':
        props.push({ type: 'prop', key: 'timedAction', op: '=', value: val });
        hasTimedAction = true;
        break;
      case 'skillrequired':
        props.push({ type: 'prop', key: 'SkillRequired', op: '=', value: mapSkillRequired(val) });
        skillValue = val.split(/[=:;]/)[0]?.trim();
        break;
      case 'needtobelearn':
        props.push({ type: 'prop', key: 'needTobeLearn', op: '=', value: val.toLowerCase() });
        break;
      case 'oncreate':
        // A2: captured; resolved with OnGiveXP after the loop (may be wrapped).
        onCreateRef = val;
        break;
      case 'ontest':
      case 'oncanperform':
        props.push({ type: 'prop', key, op: '=', value: val });
        break;
      case 'ongivexp':
        // A2: captured; resolved to xpAward or an OnCreate shim after the loop.
        onGiveXpRef = val;
        break;
      case 'canbedonefromfloor':
        if (val.toLowerCase() === 'true') tagsAccum.push('CanBeDoneFromFloor');
        break;
      case 'inhandcraft':
        if (val.toLowerCase() === 'true') tagsAccum.push('InHandCraft');
        break;
      case 'prop1':
      case 'prop2': {
        // A5/A7: Prop1:<item> -> flags[Prop1] on the matching input. The
        // `Source=N` form has unclear semantics; flag it instead.
        const flag = key.toLowerCase() === 'prop1' ? 'Prop1' : 'Prop2';
        if (/^source\b/i.test(val)) {
          warnings.push(`[${id}] ${key} "${val}" uses the Source= form; attach flags[${flag}] to the intended input manually.`);
        } else {
          pendingFlags.push({ flag, target: val });
        }
        break;
      }
      case 'animnode':
      case 'animmode':
        // A3: AnimNode (and its mod alias AnimMode — never both) name the craft
        // animation. Captured so it drives the (Sound, AnimNode) -> timedAction
        // resolution, which is where the animation is actually preserved.
        animNode = val;
        break;
      case 'sound':
        // A3: captured; B42 has no per-recipe sound field, but the value helps
        // pick the matching timedAction (which carries the sound).
        soundValue = val;
        break;
      case 'nearitem':
        warnings.push(`[${id}] NearItem "${val}" — in B42 use Tags (e.g. a workstation tag); review.`);
        break;
      case 'obsolete':
        // Obsolete recipes were DISABLED in B41. B42 has no flag, and dropping it
        // would re-ENABLE the recipe — so comment the whole block out instead.
        if (val.toLowerCase() === 'true') obsolete = true;
        break;
      case 'ishidden':
        // IsHidden recipes are usable context/double-click actions kept out of the
        // crafting menu. B42's successor is OnAddToMenu (return false to hide).
        if (val.toLowerCase() === 'true') hiddenFromMenu = true;
        break;
      default: {
        const lk = key.toLowerCase();
        const removedNote = REMOVED_RECIPE_PROPS[lk];
        if (removedNote !== undefined) {
          // A9: confirmed-invalid B42 property — drop it with guidance.
          warnings.push(`[${id}] "${key}" — ${removedNote}`);
        } else if (VALID_CRAFTRECIPE_PROPS.has(lk) || PASSTHROUGH.has(key)) {
          // Valid B42 craftRecipe property — pass through silently.
          props.push({ type: 'prop', key, op: '=', value: val });
        } else {
          warnings.push(`[${id}] unmapped property "${key}:${val}" passed through as-is — verify it is a valid B42 craftRecipe property.`);
          props.push({ type: 'prop', key, op: '=', value: val });
        }
      }
    }
  }

  if (tagsAccum.length > 0) {
    props.push({ type: 'prop', key: 'Tags', op: '=', value: tagsAccum.join(';') });
  }

  // A2: resolve OnGiveXP + OnCreate together.
  //  - static value (vanilla table / clean mod literal) -> `xpAward`
  //  - runtime mod function that ships with the mod      -> `OnCreate` shim
  //  - otherwise                                         -> flag
  if (onGiveXpRef !== undefined) {
    const resolved = resolveXpAward(onGiveXpRef, xpTable);
    if (resolved !== undefined) {
      if (resolved.award !== null) props.push({ type: 'prop', key: 'xpAward', op: '=', value: resolved.award });
      if (onCreateRef !== undefined) props.push({ type: 'prop', key: 'OnCreate', op: '=', value: onCreateRef });
    } else {
      const fnName = onGiveXpRef.split('.').pop() ?? onGiveXpRef;
      const shippable = ctx.xpShimFns?.has(fnName) === true || ctx.xpShimFns?.has(onGiveXpRef) === true;
      if (shippable && ctx.xpShims) {
        const shim: XpShim = { id, xpFnRef: onGiveXpRef };
        if (onCreateRef !== undefined) shim.onCreateRef = onCreateRef;
        ctx.xpShims.push(shim);
        props.push({ type: 'prop', key: 'OnCreate', op: '=', value: `B41XP.${id}` });
        warnings.push(`[${id}] runtime OnGiveXP "${onGiveXpRef}" preserved via an OnCreate shim (B41XP.${id}); all four B41 args are re-bound (recipe via a B41-API adapter over B42 CraftRecipe). recipe:add/remove/contains have no B42 equivalent and no-op.`);
      } else {
        warnings.push(`[${id}] OnGiveXP "${onGiveXpRef}" isn't a static value and its function isn't defined in this mod's Lua; set xpAward or an OnCreate hook manually.`);
        if (onCreateRef !== undefined) props.push({ type: 'prop', key: 'OnCreate', op: '=', value: onCreateRef });
      }
    }
  } else if (onCreateRef !== undefined) {
    props.push({ type: 'prop', key: 'OnCreate', op: '=', value: onCreateRef });
  }

  // A5/A7: attach collected Prop1/Prop2 flags to their matching input lines.
  for (const pf of pendingFlags) {
    if (!attachPropFlag(inputs, pf.target, pf.flag)) {
      warnings.push(`[${id}] ${pf.flag} target "${pf.target}" did not match any input; attach flags[${pf.flag}] manually.`);
    }
  }

  // A1/A3: choose the timedAction. Priority:
  //   1. exact (Sound, AnimNode) match to a B42 timedAction
  //   2. heuristic from kept-tool / skill / category
  //   3. generic "Making" (with a warning — nothing to infer from)
  if (!hasTimedAction) {
    const resolved = resolveTimedAction(soundValue, animNode);
    if (resolved) {
      props.unshift({ type: 'prop', key: 'timedAction', op: '=', value: resolved.action });
      if (resolved.ambiguous) {
        warnings.push(`[${id}] timedAction "${resolved.action}" inferred from Sound/AnimNode, but that pairing matches multiple B42 actions — verify it's the right one.`);
      }
    } else {
      const inferred = inferTimedAction(keptTools, skillValue, categoryValue);
      if (inferred) {
        // Best-effort animation pick from tool/skill/category. Cosmetic only
        // (the craft still works), so this is applied silently.
        props.unshift({ type: 'prop', key: 'timedAction', op: '=', value: inferred });
      } else {
        props.unshift({ type: 'prop', key: 'timedAction', op: '=', value: 'Making' });
        warnings.push(`[${id}] no timedAction inferable (no Sound/AnimNode/tool/skill/category signal); defaulted to "Making".`);
      }
    }
  }
  if (!hasTime) {
    warnings.push(`[${id}] no Time in source; B42 will use a default craft time.`);
  }

  // IsHidden -> keep usable but out of the crafting menu via OnAddToMenu.
  if (hiddenFromMenu) {
    props.push({ type: 'prop', key: 'OnAddToMenu', op: '=', value: 'B41Compat.hideFromMenu' });
  }

  const children: ScriptNode[] = [...props];
  children.push({ type: 'block', keyword: 'inputs', name: '', children: inputs });
  children.push({ type: 'block', keyword: 'outputs', name: '', children: outputs });

  const block: BlockNode = { type: 'block', keyword: 'craftRecipe', name: id, children };
  // Obsolete -> comment the whole block out (was disabled in B41; dropping the
  // flag would re-enable it).
  if (obsolete) {
    block.commentedOut = `recipe was Obsolete:true (disabled in B41). B42 has no Obsolete flag; ` +
      `kept disabled by commenting out (dropping the flag would re-enable it).`;
  }
  ctx.translations[id] = displayName;

  const result: RecipeResult = { block, warnings, id, displayName };
  if (hiddenFromMenu) result.usedHideMenu = true;
  return result;
}
