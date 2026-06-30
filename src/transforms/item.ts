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

export function transformItem(item: BlockNode): ItemResult {
  const warnings: string[] = [];
  const id = item.name;
  const newChildren: ScriptNode[] = [];
  let displayName: string | undefined;

  for (const child of item.children) {
    if (child.type !== 'prop') { newChildren.push(child); continue; }
    const lk = child.key.toLowerCase();

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
