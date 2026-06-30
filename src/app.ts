// Browser glue: read a B41 mod (zip or folder) -> convertMod -> show report
// -> download converted B42 zip. Same engine as the CLI/tests.

import { convertMod } from './convert.js';
import { renderReportMarkdown, reportHeadline } from './report.js';
import { decodeText } from './encoding.js';
import type { ConversionReport, ModFile } from './types.js';

// --- minimal JSZip typings (loaded as a global from CDN) -------------------
interface JSZipObject { dir: boolean; name: string; async(t: 'string'): Promise<string>; async(t: 'uint8array'): Promise<Uint8Array>; }
interface JSZipInstance {
  files: Record<string, JSZipObject>;
  file(path: string, data: string | Uint8Array): void;
  generateAsync(opts: { type: 'blob'; compression?: string }): Promise<Blob>;
}
interface JSZipCtor { new (): JSZipInstance; loadAsync(data: Blob | ArrayBuffer): Promise<JSZipInstance>; }
declare global { interface Window { JSZip?: JSZipCtor; } }

const TEXT_EXT: ReadonlySet<string> = new Set(['txt', 'lua', 'json', 'info', 'md', 'csv', 'xml', 'ini']);
const isText = (name: string): boolean => TEXT_EXT.has((name.split('.').pop() ?? '').toLowerCase());

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

interface LastResult { files: ModFile[]; report: ConversionReport; modName: string; }
let lastResult: LastResult | null = null;

// --- file intake -----------------------------------------------------------

async function readZip(file: Blob): Promise<ModFile[]> {
  const JSZip = window.JSZip;
  if (!JSZip) throw new Error('Zip engine not loaded — connect to the internet once to cache it.');
  const zip = await JSZip.loadAsync(file);
  const files: ModFile[] = [];
  for (const e of Object.values(zip.files)) {
    if (e.dir) continue;
    const bytes = await e.async('uint8array');
    if (isText(e.name)) files.push({ path: e.name, text: decodeText(bytes, e.name) });
    else files.push({ path: e.name, text: null, bytes });
  }
  return files;
}

async function readDir(fileList: FileList | File[]): Promise<ModFile[]> {
  const files: ModFile[] = [];
  for (const f of Array.from(fileList)) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    const p = rel && rel.length > 0 ? rel : f.name;
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (isText(f.name)) files.push({ path: p, text: decodeText(bytes, p) });
    else files.push({ path: p, text: null, bytes });
  }
  return files;
}

function guessModName(files: readonly ModFile[]): string {
  const info = files.find((f) => /(^|\/)mod\.info$/i.test(f.path) && f.text != null);
  if (info && info.text) {
    const m = /^\s*name\s*=\s*(.+)$/im.exec(info.text);
    if (m && m[1]) return m[1].trim();
  }
  const first = files.find((f) => f.path.includes('/'));
  return first ? (first.path.split('/')[0] ?? 'mod') : 'mod';
}

// --- run -------------------------------------------------------------------

function handleFiles(files: ModFile[], sourceLabel: string): void {
  if (files.length === 0) return;
  showStatus(`Reading ${files.length} files from ${sourceLabel}…`);
  try {
    const modName = guessModName(files);
    const { files: outFiles, report } = convertMod(files);
    lastResult = { files: outFiles, report, modName };
    renderResults(lastResult);
  } catch (e) {
    showStatus(`✗ ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

// --- rendering -------------------------------------------------------------

function showStatus(msg: string, isError = false): void {
  const elx = el('status');
  elx.hidden = false;
  elx.textContent = msg;
  elx.classList.toggle('error', isError);
}

function counter(label: string, value: number, kind: string): string {
  return `<div class="counter ${kind}"><span class="cval">${value}</span><span class="clabel">${label}</span></div>`;
}

function renderResults({ files, report, modName }: LastResult): void {
  el('status').hidden = true;
  el('results').hidden = false;
  el('modName').textContent = modName;
  el('headline').textContent = reportHeadline(report);

  const errs =
    report.warnings.filter((w) => w.level === 'error').length +
    report.luaFindings.filter((f) => f.level === 'error').length;
  const reviews =
    report.warnings.filter((w) => w.level === 'warn').length +
    report.luaFindings.filter((f) => f.level === 'warn').length;
  el('counters').innerHTML =
    counter('recipes → craftRecipe', report.recipes.converted, 'ok') +
    counter('items migrated', report.items.scanned, 'ok') +
    counter('Lua auto-rewrites', report.lua.rewritten, report.lua.rewritten ? 'info' : 'ok') +
    counter('blocking issues', errs, errs ? 'bad' : 'ok') +
    counter('to review', reviews, reviews ? 'warn' : 'ok');

  el('tab-report').innerHTML = mdToHtml(renderReportMarkdown(report, modName));
  renderDiff(files);
  el('tab-files').innerHTML =
    '<ul class="filelist">' +
    files.map((f) => `<li><span class="${f.text == null ? 'bin' : 'txt'}">${f.text == null ? 'bin' : 'txt'}</span> ${escapeHtml(f.path)}</li>`).join('') +
    '</ul>';

  el('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderDiff(files: readonly ModFile[]): void {
  const converted = files.find((f) => f.text != null && /craftRecipe\s+\w+/.test(f.text));
  if (!converted || converted.text == null) {
    el('tab-diff').innerHTML = '<p class="muted">No recipe scripts in this mod.</p>';
    return;
  }
  const match = /[ \t]*craftRecipe[\s\S]*?\n[ \t]*\}\n/.exec(converted.text);
  const block = match ? match[0] : converted.text.slice(0, 1200);
  el('tab-diff').innerHTML =
    `<p class="muted">First converted <code>craftRecipe</code> in <b>${escapeHtml(converted.path)}</b>:</p>` +
    `<pre class="code">${escapeHtml(block)}</pre>`;
}

// --- downloads -------------------------------------------------------------

async function downloadZip(): Promise<void> {
  const JSZip = window.JSZip;
  if (!lastResult || !JSZip) return;
  const zip = new JSZip();
  for (const f of lastResult.files) {
    if (f.text != null) zip.file(f.path, f.text);
    else if (f.bytes) zip.file(f.path, f.bytes);
  }
  zip.file('CONVERSION_REPORT.md', renderReportMarkdown(lastResult.report, lastResult.modName));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  saveBlob(blob, `${sanitize(lastResult.modName)}-B42.zip`);
}

function downloadReport(): void {
  if (!lastResult) return;
  const md = renderReportMarkdown(lastResult.report, lastResult.modName);
  saveBlob(new Blob([md], { type: 'text/markdown' }), `${sanitize(lastResult.modName)}-CONVERSION_REPORT.md`);
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// --- helpers ---------------------------------------------------------------

const sanitize = (s: string): string => (s || 'mod').replace(/[^A-Za-z0-9_.-]+/g, '_');
const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

function mdToHtml(md: string): string {
  const out: string[] = [];
  let inList = false;
  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/_([^_]+)_/g, '<em>$1</em>');
  for (const raw of md.split('\n')) {
    const l = raw.replace(/\s+$/, '');
    if (/^# /.test(l)) { out.push(`<h3>${inline(l.slice(2))}</h3>`); }
    else if (/^## /.test(l)) { if (inList) { out.push('</ul>'); inList = false; } out.push(`<h4>${inline(l.slice(3))}</h4>`); }
    else if (/^- /.test(l)) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inline(l.slice(2))}</li>`); }
    else if (/^---/.test(l)) { if (inList) { out.push('</ul>'); inList = false; } out.push('<hr/>'); }
    else { if (inList) { out.push('</ul>'); inList = false; } if (l.trim()) out.push(`<p>${inline(l)}</p>`); }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

// --- wiring ----------------------------------------------------------------

function initTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll<HTMLElement>('.tab-panel').forEach((x) => { x.hidden = true; });
    t.classList.add('active');
    el(`tab-${t.dataset['tab'] ?? ''}`).hidden = false;
  }));
}

function initDrop(): void {
  const drop = el('drop');
  const stop = (e: Event): void => { e.preventDefault(); e.stopPropagation(); };
  (['dragenter', 'dragover'] as const).forEach((ev) => drop.addEventListener(ev, (e) => { stop(e); drop.classList.add('over'); }));
  (['dragleave', 'drop'] as const).forEach((ev) => drop.addEventListener(ev, (e) => { stop(e); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => {
    void (async (): Promise<void> => {
      const dt = (e as DragEvent).dataTransfer;
      if (!dt) return;
      const items = dt.files;
      const zip = Array.from(items).find((f) => f.name.toLowerCase().endsWith('.zip'));
      if (zip) handleFiles(await readZip(zip), zip.name);
      else if (items.length > 0) handleFiles(await readDir(items), 'dropped folder');
    })();
  });
  drop.addEventListener('click', () => el<HTMLInputElement>('fileZip').click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') el<HTMLInputElement>('fileZip').click(); });

  el('pickZip').addEventListener('click', (e) => { e.stopPropagation(); el<HTMLInputElement>('fileZip').click(); });
  el('pickDir').addEventListener('click', (e) => { e.stopPropagation(); el<HTMLInputElement>('fileDir').click(); });
  el<HTMLInputElement>('fileZip').addEventListener('change', (e) => {
    void (async (): Promise<void> => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) handleFiles(await readZip(f), f.name);
    })();
  });
  el<HTMLInputElement>('fileDir').addEventListener('change', (e) => {
    void (async (): Promise<void> => {
      const fl = (e.target as HTMLInputElement).files;
      if (fl && fl.length > 0) handleFiles(await readDir(fl), 'folder');
    })();
  });
}

el('dlZip').addEventListener('click', () => { void downloadZip(); });
el('dlReport').addEventListener('click', () => { downloadReport(); });
initTabs();
initDrop();
