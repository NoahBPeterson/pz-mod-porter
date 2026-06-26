// Render a conversion report as Markdown, plus a compact headline.
import type { ConversionReport } from './types.js';

export function renderReportMarkdown(report: ConversionReport, modName = 'mod'): string {
  const L: string[] = [];
  L.push(`# B41 → B42 conversion report: ${modName}`);
  L.push('');
  L.push('## Summary');
  L.push(`- Scripts scanned: **${report.scripts.scanned}**`);
  L.push(`- Recipes converted to craftRecipe: **${report.recipes.converted}**`);
  L.push(`- Items scanned: **${report.items.scanned}** (modified: ${report.items.changed})`);
  L.push(`- Lua files processed: **${report.lua.scanned}** (auto-rewrites applied: ${report.lua.rewritten}, findings: ${report.lua.findings})`);

  const errors = [
    ...report.warnings.filter((w) => w.level === 'error'),
    ...report.luaFindings.filter((f) => f.level === 'error'),
  ];
  const reviewCount =
    report.warnings.filter((w) => w.level === 'warn').length +
    report.luaFindings.filter((f) => f.level === 'warn').length;
  L.push(`- **${errors.length}** blocking issue(s), **${reviewCount}** review item(s)`);
  L.push('');

  if (report.artifacts.length > 0) {
    L.push('## Files added / updated');
    for (const a of report.artifacts) L.push(`- ${a}`);
    L.push('');
  }

  if (errors.length > 0) {
    L.push('## ❌ Blocking issues (mod may not load / behave correctly until resolved)');
    for (const e of errors) {
      const line = 'line' in e ? e.line : 0;
      const file = e.file ?? '';
      const loc = line ? `${file}:${line}` : file;
      const snippet = 'snippet' in e && e.snippet ? `  \n  \`${e.snippet}\`` : '';
      L.push(`- **${loc}** — ${e.message}${snippet}`);
    }
    L.push('');
  }

  const reviews = report.warnings.filter((w) => w.level === 'warn');
  if (reviews.length > 0) {
    L.push('## ⚠️ Review (auto-converted, but verify)');
    const seen = new Set<string>();
    for (const r of reviews) {
      const key = `${r.file} :: ${r.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      L.push(`- **${r.file}** — ${r.message}`);
    }
    L.push('');
  }

  if (report.luaRewrites.length > 0) {
    L.push('## 🔧 Lua auto-rewrites applied');
    for (const r of report.luaRewrites) L.push(`- **${r.file ?? ''}:${r.line}** — ${r.message}`);
    L.push('');
  }

  const luaWarn = report.luaFindings.filter((f) => f.level === 'warn');
  if (luaWarn.length > 0) {
    L.push('## ⚠️ Lua review');
    for (const f of luaWarn) L.push(`- **${f.file ?? ''}:${f.line}** — ${f.message}`);
    L.push('');
  }

  L.push('---');
  L.push('_Recipes are fully rewritten to B42 `craftRecipe` syntax. Items get `Type → ItemType`. ' +
    'Lua is rewritten where it is safe and authoritative — removed-event handlers and dead `require()`s ' +
    'are commented out and annotated. The B41→B42 Lua API is otherwise ~98% compatible; APIs that were ' +
    'removed or restructured (not 1:1 renamed) are flagged for manual work rather than guessed at._');
  return L.join('\n') + '\n';
}

export function reportHeadline(report: ConversionReport): string {
  const errs =
    report.warnings.filter((w) => w.level === 'error').length +
    report.luaFindings.filter((f) => f.level === 'error').length;
  const review = report.warnings.length + report.luaFindings.length - errs;
  return `${report.recipes.converted} recipes → craftRecipe · ${report.items.scanned} items · ` +
    `${report.lua.scanned} Lua files (${report.lua.rewritten} rewrites) · ${errs} blocking · ${review} to review`;
}
