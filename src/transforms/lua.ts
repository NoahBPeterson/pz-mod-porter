// B41 -> B42 Lua rewriter + linter.
//
// The B41->B42 Lua API is ~98% source-compatible, so we don't blindly rewrite
// calls. We DO apply the rewrites that are authoritative and safe:
//   * subscriptions to a removed engine event -> commented out + annotated
//     (the handler can never fire in B42, so disabling it is the correct
//     migration — there is no replacement event).
//   * `require()` of a base Lua file removed/merged in B42 -> commented out +
//     annotated (the require would error at load).
//   * verified 1:1 global renames from data/lua-renames.ts (currently minimal
//     by policy — see that file).
// Anything we can't safely auto-fix (e.g. a file that *overrides* a removed
// base file) is reported as a finding, not silently changed.

import type { LuaFinding, LuaRewrite, LuaRewriteResult } from '../types.js';
import { EVENTS_REMOVED } from '../data/events-removed.js';
import { LUA_REMOVED } from '../data/lua-removed.js';
import { LUA_GLOBAL_RENAMES } from '../data/lua-renames.js';
import { findSuccessor } from '../data/lua-successors.js';
import { B41_REMOVED_SYMBOLS } from '../data/b41-removed-symbols.js';

const removedEventSet: ReadonlySet<string> = new Set(EVENTS_REMOVED);
const removedBaseModules: ReadonlySet<string> = new Set(LUA_REMOVED.map((f) => f.replace(/\.lua$/i, '')));
const removedBaseFiles: ReadonlySet<string> = new Set(LUA_REMOVED.map((f) => f.toLowerCase()));
const renameEntries: ReadonlyArray<readonly [string, string]> = Object.entries(LUA_GLOBAL_RENAMES);

const FN_DEF_RE = /(?:function\s+([A-Za-z_][\w.:]*)|([A-Za-z_][\w.:]*)\s*=\s*function)\s*\(/g;
const EVENT_RE = /Events\.([A-Za-z_][A-Za-z0-9_]*)\.(?:Add|Remove)\s*\(/;
const TRIGGER_RE = /triggerEvent\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/;
const REQUIRE_RE = /\b(?:require|loadfile)\s*\(?\s*["']([^"']+)["']/;
const INDENT_RE = /^(\s*)/;

// Count the net change in parenthesis depth on a line, ignoring parens inside
// string literals and `--` comments (good enough for PZ mod Lua).
function parenDelta(line: string): number {
  let depth = 0;
  let str: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (str) {
      if (c === '\\') { i++; continue; }
      if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'") { str = c; continue; }
    if (c === '-' && line[i + 1] === '-') break; // line comment
    if (c === '(') depth++;
    else if (c === ')') depth--;
  }
  return depth;
}

const indentOf = (line: string): string => (INDENT_RE.exec(line)?.[1]) ?? '';

export function rewriteLua(src: string, relPath = ''): LuaRewriteResult {
  const lines = src.split('\n');
  const rewrites: LuaRewrite[] = [];
  const findings: LuaFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    // 1) Removed-event subscription -> comment out the whole statement.
    const ev = EVENT_RE.exec(line);
    if (ev && ev[1] && removedEventSet.has(ev[1])) {
      const end = statementEnd(lines, i);
      commentRange(lines, i, end, indentOf(line),
        `[B41->B42] Event "${ev[1]}" was removed in B42 — handler disabled (no replacement event).`);
      rewrites.push({ line: i + 1, kind: 'comment-event', message: `Commented out handler for removed event "${ev[1]}".` });
      i = end + 1; // skip the annotation line we inserted + processed range
      continue;
    }

    // 2) triggerEvent of a removed event -> flag only (no-op, harmless to leave).
    const trig = TRIGGER_RE.exec(line);
    if (trig && trig[1] && removedEventSet.has(trig[1])) {
      findings.push({
        level: 'warn', line: i + 1, rule: 'removed-event-trigger',
        message: `triggerEvent("${trig[1]}") fires a removed event — no-op in B42.`,
        snippet: line.trim(),
      });
    }

    // 3) require()/loadfile() of a removed base file -> comment out the statement.
    const req = REQUIRE_RE.exec(line);
    if (req && req[1]) {
      const mod = req[1].replace(/\.lua$/i, '').replace(/[\\/]/g, '/');
      const base = mod.split('/').pop() ?? '';
      if (base && removedBaseModules.has(base)) {
        const end = statementEnd(lines, i);
        commentRange(lines, i, end, indentOf(line),
          `[B41->B42] Base file "${base}.lua" was removed/merged in B42 — require disabled. Re-point to the B42 equivalent.`);
        rewrites.push({ line: i + 1, kind: 'comment-require', message: `Commented out require of removed base file "${base}.lua".` });
        i = end + 1;
        continue;
      }
    }

    // 4) Verified 1:1 global renames.
    for (const [oldName, newName] of renameEntries) {
      const re = new RegExp(`(?<![.:\\w])${oldName}(?=\\s*\\()`, 'g');
      if (re.test(line)) {
        lines[i] = line.replace(re, newName);
        rewrites.push({ line: i + 1, kind: 'rename', message: `Renamed ${oldName}() -> ${newName}() (B42).` });
      }
    }
  }

  // 5) This file overrides a removed base file — can't auto-fix, but report the
  //    B42 subsystem that replaced it (its symbol is genuinely gone, not moved).
  const fileName = relPath.split('/').pop() ?? '';
  if (fileName && removedBaseFiles.has(fileName.toLowerCase())) {
    const succ = findSuccessor(fileName);
    const tail = succ
      ? ` Successor system — ${succ.system}: ${succ.pointer}`
      : ` Its global was removed entirely in B42 (the subsystem was rebuilt under new names) — there is no successor file to re-point to.`;
    // Bounded diff: which vanilla functions does this override redefine vs add?
    const delta = diffOverride(src, fileName);
    const deltaMsg = delta
      ? ` Diff vs vanilla B41: redefines ${delta.redefines.length} vanilla function(s)${delta.redefines.length ? ` (${delta.redefines.slice(0, 6).join(', ')}${delta.redefines.length > 6 ? ', …' : ''})` : ''}; adds ${delta.adds.length} new. Those are the functions to re-implement against the successor system.`
      : '';
    findings.push({
      level: 'error', line: 0, rule: 'override-removed',
      message: `This file overrides base "${fileName}", which B42 removed.${tail}${deltaMsg}`,
    });
  }

  return { text: lines.join('\n'), rewrites, findings };
}

// Find the last line index of a statement starting at `start`, by balancing
// parens across lines. A statement ends on the first line where the running
// paren depth returns to <= 0 — so a single line with balanced parens (or none,
// e.g. `require "x"`) ends at itself, and a call whose args span lines extends
// until the closing paren.
function statementEnd(lines: readonly string[], start: number): number {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    depth += parenDelta(lines[i] ?? '');
    if (depth <= 0) return i;
  }
  return start;
}

// Comment out lines [start..end] in place with `-- `, and insert an annotation
// line above `start`. Mutates `lines`.
function commentRange(lines: string[], start: number, end: number, indent: string, note: string): void {
  for (let i = start; i <= end && i < lines.length; i++) {
    const l = lines[i] ?? '';
    lines[i] = l.length > 0 ? `-- ${l}` : '--';
  }
  lines.splice(start, 0, `${indent}-- ${note}`);
}

// Bounded mod-vs-vanilla symbol diff for an overridden (removed) base file.
// Compares the function symbols the mod defines against the vanilla B41 set.
// This part IS mechanical and finite; re-implementing the result against B42 is
// the part that isn't (see notes in this file's header / the override message).
function diffOverride(
  src: string,
  fileName: string,
): { redefines: string[]; adds: string[] } | undefined {
  const vanilla = B41_REMOVED_SYMBOLS[fileName];
  if (!vanilla) return undefined;
  const vanillaSet = new Set(vanilla);
  const modSyms = new Set<string>();
  for (const m of src.matchAll(FN_DEF_RE)) {
    const name = m[1] ?? m[2];
    if (name) modSyms.add(name);
  }
  const redefines: string[] = [];
  const adds: string[] = [];
  for (const s of modSyms) (vanillaSet.has(s) ? redefines : adds).push(s);
  return { redefines: redefines.sort(), adds: adds.sort() };
}

// Back-compat lint-only view (used by tests / anything that only wants findings).
export function lintLua(src: string, relPath = ''): LuaFinding[] {
  const { rewrites, findings } = rewriteLua(src, relPath);
  const fromRewrites: LuaFinding[] = rewrites
    .filter((r) => r.kind !== 'rename')
    .map((r) => ({
      level: 'error' as const,
      line: r.line,
      rule: r.kind === 'comment-event' ? ('removed-event' as const) : ('require-removed' as const),
      message: r.message,
    }));
  return [...fromRewrites, ...findings];
}
