// AST-based transform for B41 "recipecode" mods (require "recipecode" + a set of
// `Recipe.OnCreate.X(items, result, player)` style functions).
//
// Built on luaparse (Lua 5.1 = the Kahlua/LuaJ dialect PZ uses). We parse to an
// AST with source ranges, then splice surgical edits back into the original
// text so all untouched formatting is preserved. Three structural fixes:
//   1. `require "recipecode"`  ->  Recipe namespace guards (recipecode is gone,
//      so it no longer creates the `Recipe` table).
//   2. `function Recipe.OnCreate.X(items, result, player)` -> B42 signature
//      `(craftRecipeData, character)` + `local` rebinds for the params the body
//      actually uses (exactly what real B42 ports do by hand).
//   3. namespace guards for every `Recipe.<Cat>` the file defines.
//
// OnGiveXP functions are deliberately NOT signature-rewritten here — the script
// side already handles them (static xpAward or an OnCreate shim that calls them
// with B41 args). We only guard their namespace.

import luaparse from 'luaparse';
import { REROOT_BY_NAME, METHOD_REROOTS, CHAINED_REROOTS, NILCHECK_REROOT, ATTACH_CLIP_REROOT } from '../data/lua-reroots.js';

interface Range { range: [number, number]; }
type Node = Range & { type: string; [k: string]: unknown };

const ONCREATE_BINDS: readonly string[] = [
  'craftRecipeData and craftRecipeData:getAllConsumedItems() or nil', // items
  'craftRecipeData and craftRecipeData:getFirstCreatedItem() or nil', // result
  'character',                                                        // player
];

export interface RecipeCodeResult {
  text: string;
  changes: string[];
}

interface Edit { start: number; end: number; replacement: string; }

// Flatten a `Recipe.OnCreate.X` MemberExpression chain to ['Recipe','OnCreate','X'].
function dottedName(node: Node | null | undefined): string[] | undefined {
  if (!node) return undefined;
  if (node.type === 'Identifier') return [node['name'] as string];
  if (node.type === 'MemberExpression' && node['indexer'] === '.') {
    const base = dottedName(node['base'] as Node);
    const id = (node['identifier'] as Node | undefined)?.['name'] as string | undefined;
    if (base && id) return [...base, id];
  }
  return undefined;
}

// Recursively visit every AST node.
function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) walk(c, visit); return; }
  const n = node as Record<string, unknown>;
  if (typeof n['type'] === 'string') visit(n as Node);
  for (const k of Object.keys(n)) {
    if (k === 'range' || k === 'loc') continue;
    walk(n[k], visit);
  }
}

function lineIndent(src: string, pos: number): string {
  const lineStart = src.lastIndexOf('\n', pos - 1) + 1;
  const m = /^[ \t]*/.exec(src.slice(lineStart, pos));
  return m ? m[0] : '';
}

/**
 * Transform a recipecode-style Lua file. Returns null if the file isn't a
 * recipecode file (no require + no Recipe.* defs) or if it fails to parse
 * (caller then falls back to the line-level rewriter).
 */
export function transformRecipeCode(src: string): RecipeCodeResult | null {
  let ast: { body: unknown };
  try {
    ast = luaparse.parse(src, { luaVersion: '5.1', ranges: true, comments: false }) as { body: unknown };
  } catch {
    return null; // non-standard syntax -> let the line-level path handle it
  }

  const edits: Edit[] = [];
  const changes: string[] = [];
  const namespaces = new Set<string>(); // Recipe.<Cat> categories defined
  let requireRange: [number, number] | null = null;

  const handleFn = (nameParts: string[] | undefined, fnNode: Node | undefined): void => {
    if (!nameParts || nameParts.length !== 3 || nameParts[0] !== 'Recipe' || !fnNode) return;
    const cat = nameParts[1]!;
    namespaces.add(cat);
    if (cat !== 'OnCreate') return; // only OnCreate signatures get rewritten

    const params = (fnNode['parameters'] as Node[] | undefined) ?? [];
    const [fnStart, fnEnd] = fnNode.range;
    const open = src.indexOf('(', fnStart);
    const close = src.indexOf(')', open);
    if (open < 0 || close < 0 || close > fnEnd) return;

    const bodySrc = src.slice(close + 1, fnEnd);
    const rebinds: string[] = [];
    params.forEach((p, idx) => {
      const name = p['name'] as string | undefined;
      const bind = ONCREATE_BINDS[idx];
      if (!name || !bind) return;
      if (new RegExp(`\\b${name}\\b`).test(bodySrc)) rebinds.push(`local ${name} = ${bind}`);
    });

    const indent = lineIndent(src, fnStart) + '    ';
    const rebindText = rebinds.length ? '\n' + rebinds.map((r) => indent + r).join('\n') : '';
    edits.push({ start: open, end: close + 1, replacement: `(craftRecipeData, character)${rebindText}` });
    changes.push(`Recipe.OnCreate.${nameParts[2]}: B41 (${params.map((p) => p['name']).join(', ')}) -> B42 (craftRecipeData, character)${rebinds.length ? ` + ${rebinds.length} rebind(s)` : ''}`);
  };

  walk(ast.body, (n) => {
    // function Recipe.Cat.Name(...)
    if (n.type === 'FunctionDeclaration' && n['identifier']) {
      handleFn(dottedName(n['identifier'] as Node), n);
    }
    // Recipe.Cat.Name = function(...)
    if (n.type === 'AssignmentStatement') {
      const vars = n['variables'] as Node[] | undefined;
      const inits = n['init'] as Node[] | undefined;
      if (vars?.length === 1 && inits?.length === 1 && inits[0]?.type === 'FunctionDeclaration') {
        handleFn(dottedName(vars[0]), inits[0] as Node);
      }
    }
    if (n.type === 'CallExpression') {
      const base = n['base'] as Node | undefined;
      // Global re-roots: getPlayerCraftingUI(n) / getPlayerSafetyUI(n).
      if (base?.type === 'Identifier') {
        const rule = REROOT_BY_NAME.get(base['name'] as string);
        if (rule) {
          const args = ((n['arguments'] as Node[] | undefined) ?? []).map((a) => src.slice(a.range[0], a.range[1]));
          edits.push({ start: n.range[0], end: n.range[1], replacement: rule.rewrite(args) });
          changes.push(`Re-rooted ${rule.note}`);
        }
      }
      if (base?.type === 'MemberExpression' && base['indexer'] === ':') {
        const method = (base['identifier'] as Node | undefined)?.['name'] as string | undefined;
        const outerNoArgs = ((n['arguments'] as Node[] | undefined) ?? []).length === 0;
        const inner = base['base'] as Node | undefined;
        // Chained re-root: <recv>:getClip():getType() -> <recv>:getMagazineType().
        let chained = false;
        if (method && outerNoArgs && inner?.type === 'CallExpression') {
          const innerBase = inner['base'] as Node | undefined;
          if (innerBase?.type === 'MemberExpression' && innerBase['indexer'] === ':' &&
              ((inner['arguments'] as Node[] | undefined) ?? []).length === 0) {
            const innerMethod = (innerBase['identifier'] as Node | undefined)?.['name'] as string | undefined;
            const rule = CHAINED_REROOTS.find((r) => r.inner === innerMethod && r.finalizer === method);
            if (rule) {
              const recv = innerBase['base'] as Node;
              edits.push({ start: n.range[0], end: n.range[1], replacement: rule.build(src.slice(recv.range[0], recv.range[1])) });
              changes.push(`Re-rooted ${rule.note}`);
              chained = true;
            }
          }
        }
        // Single method re-roots: <expr>:getScope() -> <expr>:getWeaponPart("Scope").
        const build = method ? METHOD_REROOTS.get(method) : undefined;
        if (!chained && build && outerNoArgs) {
          const recv = base['base'] as Node;
          edits.push({ start: n.range[0], end: n.range[1], replacement: build(src.slice(recv.range[0], recv.range[1])) });
          changes.push(`Re-rooted :${method}() -> :getWeaponPart(...) (B42 weapon part API)`);
        }
        // Magazine copy: <a>:attachWeaponPart(<b>:getClip()) -> setMagazineType+setContainsClip.
        if (!chained && method === ATTACH_CLIP_REROOT.outerMethod) {
          const arg0 = ((n['arguments'] as Node[] | undefined) ?? [])[0];
          if (arg0?.type === 'CallExpression') {
            const ab = arg0['base'] as Node | undefined;
            if (ab?.type === 'MemberExpression' && ab['indexer'] === ':' &&
                (ab['identifier'] as Node | undefined)?.['name'] === ATTACH_CLIP_REROOT.innerMethod &&
                ((arg0['arguments'] as Node[] | undefined) ?? []).length === 0) {
              const target = base['base'] as Node;
              const source = ab['base'] as Node;
              edits.push({ start: n.range[0], end: n.range[1],
                replacement: ATTACH_CLIP_REROOT.build(src.slice(target.range[0], target.range[1]), src.slice(source.range[0], source.range[1])) });
              changes.push(`Re-rooted ${ATTACH_CLIP_REROOT.note}`);
            }
          }
        }
      }
    }

    // Nil-check: <recv>:getClip() ~= nil  ->  <recv>:isContainsClip().
    if (n.type === 'BinaryExpression' && (n['operator'] === '~=' || n['operator'] === '==')) {
      const sides = [n['left'] as Node | undefined, n['right'] as Node | undefined];
      const callSide = sides.find((s) => s?.type === 'CallExpression' &&
        (s['base'] as Node | undefined)?.type === 'MemberExpression' &&
        ((s['base'] as Node)['identifier'] as Node | undefined)?.['name'] === NILCHECK_REROOT.method);
      const nilSide = sides.find((s) => s?.type === 'NilLiteral');
      if (callSide && nilSide) {
        const recv = (callSide['base'] as Node)['base'] as Node;
        const recvText = src.slice(recv.range[0], recv.range[1]);
        const repl = n['operator'] === '~=' ? NILCHECK_REROOT.truthy(recvText) : NILCHECK_REROOT.falsy(recvText);
        edits.push({ start: n.range[0], end: n.range[1], replacement: repl });
        changes.push(`Re-rooted getClip() ${n['operator'] as string} nil -> isContainsClip() (B42 magazine presence)`);
      }
    }

    // require "recipecode" / require("recipecode")
    if (!requireRange && (n.type === 'StringCallExpression' || n.type === 'CallExpression')) {
      const base = n['base'] as Node | undefined;
      if (base?.type === 'Identifier' && base['name'] === 'require') {
        const arg = (n['argument'] as Node | undefined) ?? ((n['arguments'] as Node[] | undefined)?.[0]);
        let val = arg?.['value'] as string | null | undefined;
        if (val == null && typeof arg?.['raw'] === 'string') {
          val = (arg['raw'] as string).replace(/^['"]|['"]$/g, '');
        }
        if (val === 'recipecode') requireRange = n.range;
      }
    }
  });

  const hasRecipecode = namespaces.size > 0 || requireRange !== null;
  // Nothing to do (not a recipecode file and no re-rootable globals).
  if (!hasRecipecode && edits.length === 0) return null;

  if (hasRecipecode) {
    const guardLines = ['Recipe = Recipe or {}', ...[...namespaces].sort().map((c) => `Recipe.${c} = Recipe.${c} or {}`)];
    const guardBlock = `-- [B41->B42] recipecode removed; Recipe namespace provided locally:\n${guardLines.join('\n')}`;
    if (requireRange) {
      edits.push({ start: requireRange[0], end: requireRange[1], replacement: guardBlock });
      changes.push('Replaced require "recipecode" with local Recipe namespace guards.');
    } else {
      edits.push({ start: 0, end: 0, replacement: guardBlock + '\n' });
      changes.push('Injected Recipe namespace guards (recipecode no longer provides them).');
    }
  }

  // Apply edits descending so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  return { text: out, changes };
}
