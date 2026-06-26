// Cross-mod XP index. Many recipe mods reference an OnGiveXP function defined in
// a *library* mod (or a sibling file) — and those functions are named like
// `Give3CookingXP`, with no "OnGiveXP" token, so the per-recipe scanner misses
// them. This indexes EVERY function definition across a set of mods (via the
// luaparse AST) and records its XP:
//   * `{ kind:'award' }`  — a single unconditional `AddXP(Perks.X, N)` literal
//     -> resolves to a static `xpAward = X:N` (nothing to inline).
//   * `{ kind:'inline' }` — runtime/complex XP (conditionals, computed amounts)
//     -> the function's source, so a dependency's function can be INLINED into
//     the converted mod and called by the OnCreate shim (self-contained).

import luaparse from 'luaparse';
import type { ModFile } from '../types.js';

export type XpEntry =
  | { kind: 'award'; award: string }
  | { kind: 'inline'; source: string };

interface AstNode { type: string; range: [number, number]; [k: string]: unknown }

const ADDXP = /:AddXP\s*\(\s*Perks\.([A-Za-z0-9_]+)\s*,\s*(\d+)\s*\)/;
// A body that reads runtime state or branches can't be a single static value.
const RUNTIME_HINT = /getPerkLevel|HasTrait|sandbox|getModData|\bif\b|\bfor\b|\bwhile\b/;

function lastSegment(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'Identifier') return node['name'] as string;
  if (node.type === 'MemberExpression') return (node['identifier'] as AstNode | undefined)?.['name'] as string | undefined;
  return undefined;
}

function walk(node: unknown, visit: (n: AstNode) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) walk(c, visit); return; }
  const n = node as Record<string, unknown>;
  if (typeof n['type'] === 'string') visit(n as AstNode);
  for (const k of Object.keys(n)) { if (k === 'range' || k === 'loc') continue; walk(n[k], visit); }
}

export function buildXpIndex(fileSets: readonly (readonly ModFile[])[]): Map<string, XpEntry> {
  const index = new Map<string, XpEntry>();
  for (const files of fileSets) {
    for (const f of files) {
      if (f.text == null || !/\.lua$/i.test(f.path)) continue;
      let ast: unknown;
      try { ast = luaparse.parse(f.text, { luaVersion: '5.1', ranges: true, comments: false }); } catch { continue; }
      const text = f.text;
      walk((ast as { body?: unknown }).body, (n) => {
        if (n.type !== 'FunctionDeclaration' || !n['identifier']) return;
        const name = lastSegment(n['identifier'] as AstNode);
        if (!name || index.has(name)) return;
        const src = text.slice(n.range[0], n.range[1]);
        if (!/AddXP/.test(src)) return; // only XP-granting functions
        const m = ADDXP.exec(src);
        const single = (src.match(/AddXP/g) ?? []).length === 1;
        if (m && m[1] && m[2] && single && !RUNTIME_HINT.test(src)) {
          index.set(name, { kind: 'award', award: `${m[1]}:${m[2]}` });
        } else {
          index.set(name, { kind: 'inline', source: src });
        }
      });
    }
  }
  return index;
}

/** Names of every top-level function defined in a mod's own Lua (for "is it ours"). */
export function ownDefinedNames(files: readonly ModFile[]): Set<string> {
  const set = new Set<string>();
  for (const f of files) {
    if (f.text == null || !/\.lua$/i.test(f.path)) continue;
    let ast: unknown;
    try { ast = luaparse.parse(f.text, { luaVersion: '5.1', ranges: true, comments: false }); } catch { continue; }
    walk((ast as { body?: unknown }).body, (n) => {
      if (n.type === 'FunctionDeclaration' && n['identifier']) {
        const name = lastSegment(n['identifier'] as AstNode);
        if (name) set.add(name);
      }
    });
  }
  return set;
}
