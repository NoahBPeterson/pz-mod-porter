#!/usr/bin/env node
// CLI wrapper around the converter engine.
//   node dist/cli.js <input-mod-dir> [output-dir]

import fs from 'node:fs';
import path from 'node:path';
import { convertMod } from './convert.js';
import { renderReportMarkdown, reportHeadline } from './report.js';
import { decodeText } from './encoding.js';
import type { ModFile } from './types.js';

const TEXT_EXT: ReadonlySet<string> = new Set(['.txt', '.lua', '.json', '.info', '.md', '.csv', '.xml', '.ini']);

function walk(dir: string, base: string = dir, acc: ModFile[] = []): ModFile[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      walk(full, base, acc);
    } else {
      const rel = path.relative(base, full).split(path.sep).join('/');
      const ext = path.extname(name).toLowerCase();
      const bytes = new Uint8Array(fs.readFileSync(full));
      if (TEXT_EXT.has(ext)) acc.push({ path: rel, text: decodeText(bytes, rel) });
      else acc.push({ path: rel, text: null, bytes });
    }
  }
  return acc;
}

function main(): void {
  const inDir = process.argv[2];
  if (!inDir) { console.error('usage: node dist/cli.js <mod-dir> [out-dir]'); process.exit(2); }
  const outDir = process.argv[3] ?? inDir.replace(/\/$/, '') + '-b42';

  const files = walk(path.resolve(inDir));
  const { files: outFiles, report } = convertMod(files);

  for (const f of outFiles) {
    const dest = path.join(outDir, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (f.text != null) fs.writeFileSync(dest, f.text);
    else if (f.bytes) fs.writeFileSync(dest, f.bytes);
  }
  const modName = path.basename(inDir);
  fs.writeFileSync(path.join(outDir, 'CONVERSION_REPORT.md'), renderReportMarkdown(report, modName));

  console.log(reportHeadline(report));
  console.log(`\nwrote ${outFiles.length} files -> ${outDir}`);
}

main();
