// Shared types for the PZ B41->B42 converter engine.

/** Operator separating a property key from its value in PZ script. */
export type PropOp = ':' | '=';

export interface RootNode {
  readonly type: 'root';
  children: ScriptNode[];
}

export interface BlockNode {
  readonly type: 'block';
  keyword: string;
  name: string;
  children: ScriptNode[];
  /** If set, the whole block is wrapped in a `/* reason ... *​/` comment (disabled). */
  commentedOut?: string;
}

export interface PropNode {
  readonly type: 'prop';
  key: string;
  op: PropOp;
  value: string;
}

export interface LineNode {
  readonly type: 'line';
  text: string;
  /** Emit without a trailing comma (e.g. import members). */
  noComma?: boolean;
}

export interface RawNode {
  readonly type: 'raw';
  text: string;
}

export type ScriptNode = BlockNode | PropNode | LineNode | RawNode;
export type AnyNode = RootNode | ScriptNode;

/** A node that can contain children (root or block). */
export type ParentNode = RootNode | BlockNode;

/**
 * One file in a mod's tree. `text` is null for binary assets, which pass
 * through untouched (their bytes live in `bytes`).
 */
export interface ModFile {
  path: string;
  text: string | null;
  bytes?: Uint8Array;
}

export type Severity = 'error' | 'warn';

/** A free-text finding tied to a file (script transforms). */
export interface Warning {
  file: string;
  level: Severity;
  message: string;
}

/** A line-located finding from Lua linting (not auto-fixed). */
export interface LuaFinding {
  level: Severity;
  line: number;
  rule: 'removed-event' | 'removed-event-trigger' | 'require-removed' | 'override-removed';
  message: string;
  snippet?: string;
  file?: string;
}

/** An edit the Lua rewriter actually applied to a file. */
export interface LuaRewrite {
  file?: string;
  line: number;
  kind: 'comment-event' | 'comment-require' | 'rename' | 'recipecode';
  message: string;
}

export interface LuaRewriteResult {
  text: string;
  rewrites: LuaRewrite[];
  findings: LuaFinding[];
}

export interface ConversionReport {
  recipes: { converted: number };
  items: { scanned: number; changed: number };
  lua: { scanned: number; findings: number; rewritten: number };
  scripts: { scanned: number };
  warnings: Warning[];
  luaFindings: LuaFinding[];
  luaRewrites: LuaRewrite[];
  artifacts: string[];
  translations: Record<string, string>;
  /** Item `Module.Id` -> migrated B41 DisplayName (B42 ItemName.json fallback). */
  displayNames: Record<string, string>;
}

export interface ConvertResult {
  files: ModFile[];
  report: ConversionReport;
}

/** Context threaded through recipe/item transforms. */
export interface TransformContext {
  moduleName: string;
  knownItems: ReadonlySet<string>;
  translations: Record<string, string>;
  usedIds: Set<string>;
  /**
   * `OnGiveXP` function name (last `.`-segment) -> `Skill:amount`, or null for
   * "awards no XP". Merged vanilla + mod-scanned table; when omitted, the recipe
   * transform falls back to the vanilla table only.
   */
  xpAwards?: Readonly<Record<string, string | null>>;
  /**
   * Names of XP functions DEFINED in the mod's own (shipped) Lua. A runtime-
   * computed OnGiveXP that can't become a static `xpAward` is preserved by an
   * `OnCreate` shim that calls the original — but only when the function ships
   * with the mod (vanilla `Recipe.OnGiveXP.*` were deleted in B42, so those
   * must use the static table instead).
   */
  xpShimFns?: ReadonlySet<string>;
  /** Collector: shims the recipe transform wants convert() to emit as Lua. */
  xpShims?: XpShim[];
  /** This mod's id (from mod.info) — the namespace for its custom ItemTags. */
  modId?: string;
  /** Collector: custom (non-vanilla) ItemTags found, for registries.lua. */
  customItemTags?: Set<string>;
}

export interface XpShim {
  /** craftRecipe id (also the B41XP.<id> shim function name). */
  id: string;
  /** Original B41 OnGiveXP function reference, e.g. `MyMod.UnclogToiletXP`. */
  xpFnRef: string;
  /** Original B41 OnCreate reference to chain, if the recipe had one. */
  onCreateRef?: string;
}
