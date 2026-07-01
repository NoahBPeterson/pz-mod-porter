// B41 -> B42 item-block transform.
//   * `Type = X`        ->  `ItemType = base:<lowercase x>`   (verified 1:1)
//   * `TeachedRecipes`  ->  `LearnedRecipes`, with each recipe reference
//      run through the recipe name->ID sanitizer so the book points at the
//      converted craftRecipe IDs (verified rename: both names appear in the
//      B42 item schema AND the engine's Item.class).
//   * a few genuinely-removed properties are dropped with a warning.
// Everything else passes through.

import type { BlockNode, ScriptNode } from '../types.js';
import { sanitizeId } from './recipe.js';
import { VANILLA_ITEM_TAGS } from '../data/vanilla-item-tags.js';

/** Options threaded into the item transform for ItemTag namespacing. */
export interface ItemTagOptions {
  /** The mod's id — the namespace applied to its custom tags. */
  modId?: string;
  /** Collector for custom tags found (so convert() can emit registries.lua). */
  customTags?: Set<string>;
}

// Rewrite a `Tags = a;b;c` value. Vanilla tags resolve bare in B42 (the script
// loader maps `Optics` -> `base:optics`), so those are left untouched. A bare
// CUSTOM tag silently fails to resolve in B42 — `register()` forbids the default
// `base:` namespace — so each custom tag is namespaced to `<modId>:<tag>` and
// recorded for registration in registries.lua. Already-namespaced tags (`x:y`)
// pass through.
function rewriteItemTags(value: string, opts: ItemTagOptions): { value: string; custom: string[] } {
  const custom: string[] = [];
  const out = value.split(';').map((raw) => {
    const tag = raw.trim();
    if (!tag || tag.includes(':')) return raw;
    if (VANILLA_ITEM_TAGS.has(tag.toLowerCase())) return raw;
    if (!opts.modId) return raw; // no namespace available — leave bare (caller warns)
    custom.push(tag);
    opts.customTags?.add(tag);
    return raw.replace(tag, `${opts.modId}:${tag}`);
  });
  return { value: out.join(';'), custom };
}

// NOTE: B42 added the FluidContainer component, but the legacy item properties
// (ReplaceOnUseOn, ReplaceTypes, OnlyAcceptCategory, CountDownSound, ...) are
// still read by the engine (verified in Item.class), so they pass through
// untouched rather than being dropped.

export interface ItemResult {
  block: BlockNode;
  warnings: string[];
  id: string;
  /** B41 `DisplayName` value, if present — B42 removed it; migrate to ItemName.json. */
  displayName?: string;
}

// Convert a B41 `TeachedRecipes` value (`;`-separated recipe references) to a
// B42 `LearnedRecipes` value. craftRecipe IDs can't contain spaces, so each
// reference's name part is sanitized exactly like the recipe IDs are, while any
// `Module.`/`Module:` qualifier is preserved.
function convertRecipeRefs(value: string): { value: string; changed: boolean } {
  let changed = false;
  const out = value
    .split(';')
    .map((raw) => raw.trim())
    .filter((r) => r.length > 0)
    .map((ref) => {
      const sep = Math.max(ref.lastIndexOf('.'), ref.lastIndexOf(':'));
      const prefix = sep >= 0 ? ref.slice(0, sep + 1) : '';
      const name = sep >= 0 ? ref.slice(sep + 1) : ref;
      const id = sanitizeId(name);
      if (id !== name) changed = true;
      return `${prefix}${id}`;
    });
  return { value: out.join(';'), changed };
}

export function transformItem(item: BlockNode, tagOpts: ItemTagOptions = {}): ItemResult {
  const warnings: string[] = [];
  const id = item.name;
  const newChildren: ScriptNode[] = [];
  let displayName: string | undefined;

  for (const child of item.children) {
    if (child.type !== 'prop') { newChildren.push(child); continue; }
    const lk = child.key.toLowerCase();

    if (lk === 'tags') {
      const { value, custom } = rewriteItemTags(child.value, tagOpts);
      newChildren.push({ type: 'prop', key: child.key, op: child.op, value });
      if (custom.length > 0) {
        warnings.push(`[${id}] custom ItemTag(s) ${custom.join(', ')} -> ${tagOpts.modId}: and registered in registries.lua (B42 rejects unregistered/bare custom tags).`);
      }
      continue;
    }

    if (lk === 'displayname') {
      // Removed in B42 — the item name now comes from Translate/<LANG>/ItemName.json.
      // Drop the property and hand the value back so convert() can migrate it.
      displayName = child.value.trim();
      warnings.push(`[${id}] DisplayName removed (B42); migrated to Translate/EN/ItemName.json.`);
      continue;
    }

    if (lk === 'type') {
      newChildren.push({
        type: 'prop',
        key: 'ItemType',
        op: '=',
        value: `base:${child.value.trim().toLowerCase()}`,
      });
      continue;
    }

    if (lk === 'teachedrecipes') {
      const { value, changed } = convertRecipeRefs(child.value);
      newChildren.push({ type: 'prop', key: 'LearnedRecipes', op: '=', value });
      const note = changed ? ' (recipe references normalized to B42 craftRecipe IDs)' : '';
      warnings.push(`[${id}] TeachedRecipes -> LearnedRecipes${note}; ensure each referenced craftRecipe has NeedToBeLearn = true.`);
      continue;
    }

    newChildren.push(child);
  }

  return {
    block: { type: 'block', keyword: item.keyword, name: item.name, children: newChildren },
    warnings, id,
    ...(displayName !== undefined ? { displayName } : {}),
  };
}
