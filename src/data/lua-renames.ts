// Verified 1:1 global/API renames B41 -> B42, applied as word-boundary token
// rewrites by the Lua rewriter.
//
// POLICY: only genuine 1:1 renames belong here — a B41 name that maps to exactly
// one B42 name with the same semantics. APIs that were *removed* (e.g. the DB
// query API: getDBSchema/getTableResult/executeQuery) or *restructured* (e.g.
// the joypad button API, which changed shape, not just name) are deliberately
// NOT auto-renamed: there is no safe 1:1 target, so the rewriter leaves them
// in place and the report flags them for manual work. Adding a speculative
// rename here would silently break mods, which is worse than flagging.
//
// Each key is matched as a whole identifier (`\bKEY\b`). Extend as renames are
// verified against both engines (reference/b41 vs reference/b42 + the jar).

export const LUA_GLOBAL_RENAMES: Readonly<Record<string, string>> = {
  // (intentionally minimal — see POLICY above)
};
