// B41 -> B42 translation converter.
//
// B42 dropped the legacy `.txt` translation format entirely; translations are
// now JSON. A B41 file `Translate/<LANG>/<Cat>_<LANG>.txt` holds a Lua-ish table
//
//     <Var>_<LANG> = {
//         <Key> = "Value",
//         ...
//     }
//
// which B42 reads from `Translate/<LANG>/<Cat>.json` as `{ "<Key>": "Value" }`.
//
// Two things change beyond the syntax:
//   * Filename loses the `_<LANG>` suffix, and a couple of categories are
//     renamed to their canonical JSON file (IGUI/IG_UI -> IG_UI, Recipe ->
//     Recipes) — see CATEGORY_FILE.
//   * For identifier-keyed categories (ItemName / EvolvedRecipeName / Recipe /
//     DisplayName) B42 stores the BARE id, so the `<Cat>_` key prefix is
//     stripped (`ItemName_Base.Axe` -> `Base.Axe`). Every other category keeps
//     its full prefixed key (`IGUI_x`, `Tooltip_x`, `Sandbox_x`, ...). This is
//     verified against the B42 vanilla Translate/EN JSON files.
//
// Value parsing mirrors the engine's own tolerant reader: a value is the text
// between the FIRST and LAST quote on the line, so unescaped embedded quotes
// (common in B41 files) survive. We then decode C/Lua escapes and re-encode as
// JSON so the output is always valid JSON regardless of how sloppy the source.

import { sanitizeId } from './recipe.js';

/** PZ language codes (the `Translate/<LANG>/` directory names). */
const PZ_LANGS: ReadonlySet<string> = new Set([
  'AR', 'CA', 'CH', 'CN', 'CS', 'DA', 'DE', 'EN', 'ES', 'FI', 'FR', 'HU', 'ID',
  'IT', 'JP', 'KO', 'NL', 'NO', 'PH', 'PL', 'PT', 'PTBR', 'RO', 'RU', 'TH', 'TR', 'UA',
]);

/** Categories whose `<Cat>_` key prefix B42 strips (keys are bare ids). */
const STRIP_PREFIX: ReadonlySet<string> = new Set([
  'ItemName', 'EvolvedRecipeName', 'Recipe', 'DisplayName',
]);

/** Category (var) name -> canonical B42 JSON filename, when they differ. */
const CATEGORY_FILE: Readonly<Record<string, string>> = {
  IGUI: 'IG_UI',
  IG_UI: 'IG_UI',
  Recipe: 'Recipes',
  DisplayName: 'ItemName',
};

export interface TranslationConversion {
  /** Output path, e.g. `media/lua/shared/Translate/EN/ItemName.json`. */
  outPath: string;
  /** Canonical B42 JSON category (also the filename stem). */
  category: string;
  /** Language code taken from the `Translate/<LANG>/` directory. */
  lang: string;
  /** Parsed entries, with key prefixes already stripped where applicable. */
  entries: Record<string, string>;
}

const TRANSLATE_TXT_RE = /(^|\/)Translate\/([^/]+)\/[^/]+\.txt$/i;

/** Is this path a B41 `Translate/<LANG>/*.txt` translation file? */
export function isTranslationTxt(path: string): boolean {
  return TRANSLATE_TXT_RE.test(path.replace(/\\/g, '/'));
}

function langOf(path: string): string {
  const m = TRANSLATE_TXT_RE.exec(path.replace(/\\/g, '/'));
  return m?.[2] ?? 'EN';
}

// Remove block comments (`--[[ ]]`, `--[==[ ]==]`, `/* */`) anywhere, and `--`
// / `//` line comments to end of line, but never inside a string literal.
// Replaces removed spans with spaces (newlines preserved) so line structure —
// which the value parser relies on — is untouched.
function stripComments(src: string): string {
  const out = src.split('');
  const n = src.length;
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const longLevel = (pos: number): number => {
    if (src[pos] !== '[') return -1;
    let j = pos + 1, eq = 0;
    while (src[j] === '=') { eq++; j++; }
    return src[j] === '[' ? eq : -1;
  };
  let i = 0;
  let str: '"' | "'" | null = null;
  while (i < n) {
    const c = src[i];
    if (str) {
      if (c === '\\') { i += 2; continue; }
      if (c === str || c === '\n') str = null;
      i++; continue;
    }
    if (c === '"' || c === "'") { str = c; i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      const lvl = longLevel(i + 2);
      if (lvl >= 0) {
        const close = `]${'='.repeat(lvl)}]`;
        const end = src.indexOf(close, i + 4 + lvl);
        const stop = end < 0 ? n : end + close.length;
        blank(i, stop); i = stop; continue;
      }
      let end = src.indexOf('\n', i);
      if (end < 0) end = n;
      blank(i, end); i = end; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      // Only a CLOSED `/* */` is a comment. An unclosed `/*` (e.g. the common
      // `/***** /` decorative-banner typo) is left literal so it doesn't swallow
      // the rest of the file — the line just fails the `key = "value"` match.
      const end = src.indexOf('*/', i + 2);
      if (end < 0) { i += 2; continue; }
      blank(i, end + 2); i = end + 2; continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = n;
      blank(i, end); i = end; continue;
    }
    i++;
  }
  return out.join('');
}

// Decode C/Lua string escapes to real characters. Unknown escapes keep their
// literal char (dropping the backslash), matching Lua semantics. The result is
// fed straight to JSON.stringify, so any character needing JSON escaping is
// re-encoded canonically.
function decodeEscapes(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const e = raw[i + 1];
    if (e === undefined) { out += '\\'; break; }
    switch (e) {
      case 'n': out += '\n'; i++; break;
      case 't': out += '\t'; i++; break;
      case 'r': out += '\r'; i++; break;
      case 'a': out += '\x07'; i++; break;
      case 'b': out += '\b'; i++; break;
      case 'f': out += '\f'; i++; break;
      case 'v': out += '\v'; i++; break;
      case '"': out += '"'; i++; break;
      case "'": out += "'"; i++; break;
      case '\\': out += '\\'; i++; break;
      case '/': out += '/'; i++; break;
      case 'u': {
        const hex = /^[0-9a-fA-F]{4}/.exec(raw.slice(i + 2));
        if (hex) { out += String.fromCharCode(parseInt(hex[0], 16)); i += 1 + hex[0].length; }
        else { out += 'u'; i++; }
        break;
      }
      case 'x': {
        const hex = /^[0-9a-fA-F]{1,2}/.exec(raw.slice(i + 2));
        if (hex) { out += String.fromCharCode(parseInt(hex[0], 16)); i += 1 + hex[0].length; }
        else { out += 'x'; i++; }
        break;
      }
      default:
        if (e >= '0' && e <= '9') {
          const dec = /^[0-9]{1,3}/.exec(raw.slice(i + 1));
          if (dec) { out += String.fromCharCode(parseInt(dec[0], 10) & 0xff); i += dec[0].length; break; }
        }
        out += e; i++; // unknown escape -> literal char, drop backslash
    }
  }
  return out;
}

// Translation keys are wildly permissive in the wild: besides the obvious word
// chars they carry module dots (`ItemName_Base.Axe`), hyphens (UUID-keyed
// `RM_803c516d-…`, `Recipe_Empty-Bag`), spaces (B41 recipe names), and even
// punctuation runs (`Recipe_02***Buy_02_clothing(red)`). Rather than enumerate,
// require a word-char start (excludes comment/`{` lines) and then anything that
// can't be a quote, `=`, or brace — the `= "…"` value match does the real
// filtering of non-entry lines.
const KEY_RE = /^[A-Za-z0-9_][^"={}]*$/;

// Parse the `Key = "Value"` body lines (engine-style: value = first quote ..
// last quote on the line). Returns ordered entries.
function parseEntries(body: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const line of body.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || !KEY_RE.test(key)) continue;
    const rhs = line.slice(eq + 1);
    const first = rhs.indexOf('"');
    const last = rhs.lastIndexOf('"');
    if (first < 0 || last <= first) continue;
    const raw = rhs.slice(first + 1, last);
    entries.push([key, decodeEscapes(raw)]);
  }
  return entries;
}

/**
 * Convert one B41 `Translate/<LANG>/*.txt` file to its B42 JSON form, or return
 * null if it isn't a translation file or yields no entries.
 */
export function convertTranslationTxt(path: string, text: string): TranslationConversion | null {
  if (!isTranslationTxt(path)) return null;
  const lang = langOf(path);
  const clean = stripComments(text.replace(/^﻿/, ''));

  // Var name = token before the opening `{`. Category = var minus `_<LANG>`.
  // Some mods ship a headerless file (bare `key = "value"` lines, no wrapper
  // table); fall back to the filename for the category and parse the whole body.
  const open = clean.indexOf('{');
  const head = open >= 0 ? clean.slice(0, open) : '';
  const varMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*$/.exec(head);
  const fileStem = (path.replace(/\\/g, '/').split('/').pop() ?? '').replace(/\.txt$/i, '');
  const varName = varMatch?.[1] ?? fileStem;
  // Strip a trailing `_<LANG>` to get the bare category. The suffix is the dir's
  // language, or any known PZ language code (mods sometimes mislabel, e.g. an
  // `_ES`-suffixed table sitting in the EN dir) — never a real category ends in
  // a language code, so this normalizes `ContextMenu_ES` -> `ContextMenu`.
  const usc = varName.lastIndexOf('_');
  const suffix = usc >= 0 ? varName.slice(usc + 1) : '';
  const category = suffix && (suffix.toUpperCase() === lang.toUpperCase() || PZ_LANGS.has(suffix.toUpperCase()))
    ? varName.slice(0, usc)
    : varName;

  let body: string;
  if (open < 0) {
    body = clean; // headerless: parse every `key = "value"` line.
  } else {
    const close = clean.lastIndexOf('}');
    body = close > open ? clean.slice(open + 1, close) : clean.slice(open + 1);
  }
  const parsed = parseEntries(body);
  if (parsed.length === 0) return null;

  // Recipe tables are written as either `Recipe_EN` or `Recipes_EN`, but the
  // KEYS always carry the singular `Recipe_` prefix. Their translation keys
  // mirror the B41 recipe NAME (which may contain spaces); the B42 craftRecipe
  // id is `sanitizeId(name)`, so the JSON key must be sanitized identically to
  // line up with the script-derived Recipes.json.
  const isRecipe = category === 'Recipe' || category === 'Recipes';
  const prefix = isRecipe ? 'Recipe_' : `${category}_`;
  const strip = isRecipe || STRIP_PREFIX.has(category);
  const entries: Record<string, string> = {};
  for (const [k0, v] of parsed) {
    let key = strip && k0.startsWith(prefix) ? k0.slice(prefix.length) : k0;
    // B41 recipe keys substitute `_` for the spaces in the recipe name, so
    // treat both as word separators before camel-casing to the B42 id.
    if (isRecipe) key = sanitizeId(key.replace(/_/g, ' '));
    if (key && entries[key] === undefined) entries[key] = v;
  }

  const jsonCat = CATEGORY_FILE[category] ?? category;
  const dir = path.replace(/\\/g, '/').replace(/\/[^/]+$/, '');
  return { outPath: `${dir}/${jsonCat}.json`, category: jsonCat, lang, entries };
}
