// PZ script-format parser. See the grammar notes in the original design:
// brace-delimited `keyword name { ... }` blocks, `Key = Value` / `Key : Value`
// properties, bare comma-terminated lines (recipe ingredients), and nested
// `/* */` comments.

import type {
  AnyNode,
  BlockNode,
  LineNode,
  ParentNode,
  PropNode,
  RootNode,
  ScriptNode,
} from './types.js';

// Strip comments. PZ supports NESTED block comments, so track depth.
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '*') {
      let bdepth = 1;
      i += 2;
      while (i < n && bdepth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { bdepth++; i += 2; continue; }
        if (src[i] === '*' && src[i + 1] === '/') { bdepth--; i += 2; continue; }
        i++;
      }
      continue;
    }
    if (c === '/' && c2 === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

type Entry =
  | { kind: 'block'; header: string; inner: string }
  | { kind: 'entry'; text: string };

// Split a block body into top-level entries, respecting brace + bracket depth.
function splitEntries(body: string): Entry[] {
  const entries: Entry[] = [];
  let depth = 0;
  let buf = '';
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body[i];
    if (c === '[') { depth++; buf += c; i++; continue; }
    if (c === ']') { depth = Math.max(0, depth - 1); buf += c; i++; continue; }
    if (c === '{' && depth === 0) {
      let bdepth = 1;
      let j = i + 1;
      while (j < n && bdepth > 0) {
        const cj = body[j];
        if (cj === '{') bdepth++;
        else if (cj === '}') bdepth--;
        j++;
      }
      entries.push({ kind: 'block', header: buf.trim(), inner: body.slice(i + 1, j - 1) });
      buf = '';
      i = j;
      continue;
    }
    if (c === ',' && depth === 0) {
      const t = buf.trim();
      if (t) entries.push({ kind: 'entry', text: t });
      buf = '';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  const tail = buf.trim();
  if (tail) entries.push({ kind: 'entry', text: tail });
  return entries;
}

// Parse a single entry string into a PropNode or LineNode. A PROP requires a
// bare identifier before the first top-level `=` or `:`.
function parseEntry(text: string): PropNode | LineNode {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === '=' || c === ':')) {
      const key = text.slice(0, i).trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return { type: 'prop', key, op: c, value: text.slice(i + 1).trim() };
      }
      break;
    }
  }
  return { type: 'line', text: text.trim() };
}

function parseBlockHeader(header: string): { keyword: string; name: string } {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(header);
  if (!m) return { keyword: header.trim(), name: '' };
  return { keyword: m[1] ?? header.trim(), name: (m[2] ?? '').trim() };
}

function parseBody(body: string): ScriptNode[] {
  const children: ScriptNode[] = [];
  for (const e of splitEntries(body)) {
    if (e.kind === 'block') {
      const { keyword, name } = parseBlockHeader(e.header);
      children.push({ type: 'block', keyword, name, children: parseBody(e.inner) });
    } else {
      children.push(parseEntry(e.text));
    }
  }
  return children;
}

/** Parse a full script file into a ROOT node. */
export function parseScript(src: string): RootNode {
  return { type: 'root', children: parseBody(stripComments(src)) };
}

function hasChildren(node: AnyNode): node is ParentNode {
  return node.type === 'root' || node.type === 'block';
}

/** Collect all blocks of a given keyword (recursively, case-insensitive). */
export function findBlocks(node: AnyNode, keyword: string, acc: BlockNode[] = []): BlockNode[] {
  if (node.type === 'block' && node.keyword.toLowerCase() === keyword.toLowerCase()) {
    acc.push(node);
  }
  if (hasChildren(node)) {
    for (const c of node.children) findBlocks(c, keyword, acc);
  }
  return acc;
}

/** Get a property value (first match) from a block, case-insensitive. */
export function getProp(block: BlockNode, key: string): string | undefined {
  for (const c of block.children) {
    if (c.type === 'prop' && c.key.toLowerCase() === key.toLowerCase()) return c.value;
  }
  return undefined;
}
