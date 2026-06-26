import { useEffect, useMemo, useState } from 'react';
import { diffLines } from 'diff';
import { FileCode2, FileImage, FilePlus2, Package, Pencil } from 'lucide-react';
import type { FileEntry, FileStatus } from '../lib/engine.ts';

const STATUS_META: Record<FileStatus, { label: string; Icon: typeof FileCode2 }> = {
  added: { label: 'new', Icon: FilePlus2 },
  modified: { label: 'changed', Icon: Pencil },
  unchanged: { label: 'same', Icon: FileCode2 },
};

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico']);
const isImage = (path: string): boolean => IMAGE_EXT.has((path.split('.').pop() ?? '').toLowerCase());

function iconFor(f: FileEntry): typeof FileCode2 {
  if (f.binary) return isImage(f.path) ? FileImage : Package;
  return STATUS_META[f.status].Icon;
}

export function FileExplorer({ files }: { files: FileEntry[] }): React.ReactElement {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const visible = files.filter((f) => showUnchanged || f.status !== 'unchanged');
  const firstChanged = files.find((f) => f.status === 'modified' || f.status === 'added');
  const [selected, setSelected] = useState<string | undefined>(firstChanged?.path);
  const active = visible.find((f) => f.path === selected) ?? visible[0];
  const unchangedCount = files.filter((f) => f.status === 'unchanged').length;

  return (
    <div className="explorer">
      <aside className="explorer-list">
        {visible.map((f) => {
          const Icon = iconFor(f);
          return (
            <button
              key={f.path}
              className={`fe-item fe-${f.status}${active?.path === f.path ? ' active' : ''}`}
              onClick={() => setSelected(f.path)}
              title={f.path}
            >
              <Icon size={14} className="fe-icon" />
              <span className="fe-name">{tail(f.path)}</span>
              <span className={`fe-tag fe-tag-${f.status}`}>{STATUS_META[f.status].label}</span>
            </button>
          );
        })}
        {unchangedCount > 0 && (
          <button className="fe-toggle" onClick={() => setShowUnchanged((v) => !v)}>
            {showUnchanged ? 'Hide' : 'Show'} {unchangedCount} unchanged
          </button>
        )}
      </aside>

      <div className="explorer-view">
        {active ? <DiffView entry={active} /> : <p className="muted pad">No files.</p>}
      </div>
    </div>
  );
}

// Above this combined size we don't run an LCS diff or render every line — a
// huge file (e.g. a 1.9 MB worldmap.xml) would freeze the tab. We show a
// summary with cheap added/removed line counts instead.
const DIFF_CHAR_LIMIT = 180_000;

/** Fast added/removed line counts via line multiset difference (no LCS). */
function lineDelta(before: string, after: string): { added: number; removed: number } {
  const tally = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const l of s.split('\n')) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const b = tally(before);
  const a = tally(after);
  let added = 0;
  let removed = 0;
  for (const [l, ca] of a) added += Math.max(0, ca - (b.get(l) ?? 0));
  for (const [l, cb] of b) removed += Math.max(0, cb - (a.get(l) ?? 0));
  return { added, removed };
}

type DiffModel =
  | { kind: 'binary' }
  | { kind: 'toobig'; kb: number; lines: number; added: number; removed: number }
  | { kind: 'rows'; rows: Row[] };

const STATUS_WORD: Record<FileStatus, string> = { added: 'new — added by the conversion', modified: 'changed', unchanged: 'unchanged — copied through byte-for-byte' };

function BinaryView({ entry }: { entry: FileEntry }): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (entry.bytes && isImage(entry.path)) {
      // copy into a fresh ArrayBuffer so the Blob part types cleanly
      const copy = new Uint8Array(entry.bytes.byteLength);
      copy.set(entry.bytes);
      const u = URL.createObjectURL(new Blob([copy.buffer]));
      setUrl(u);
      return () => URL.revokeObjectURL(u);
    }
    setUrl(null);
    return undefined;
  }, [entry]);

  const kb = entry.bytes ? Math.max(1, Math.round(entry.bytes.length / 1024)) : 0;
  if (url) {
    return (
      <div className="diff-image-wrap pad">
        <img className="diff-image" src={url} alt={entry.path} />
        <p className="muted diff-image-cap">
          {kb.toLocaleString()} KB image · {STATUS_WORD[entry.status]}
        </p>
      </div>
    );
  }
  return <p className="muted pad">Binary asset ({kb.toLocaleString()} KB) · {STATUS_WORD[entry.status]}.</p>;
}

function DiffView({ entry }: { entry: FileEntry }): React.ReactElement {
  const model = useMemo<DiffModel>(() => {
    if (entry.binary || entry.after == null) return { kind: 'binary' };
    const before = entry.before ?? '';
    const after = entry.after;
    const bytes = before.length + after.length;

    if (bytes > DIFF_CHAR_LIMIT) {
      const kb = Math.round(after.length / 1024);
      const lines = after.split('\n').length;
      if (entry.before == null) return { kind: 'toobig', kb, lines, added: lines, removed: 0 };
      const { added, removed } = lineDelta(before, after);
      return { kind: 'toobig', kb, lines, added, removed };
    }

    if (entry.status === 'added' || entry.before == null) {
      return { kind: 'rows', rows: after.split('\n').map((line, i) => ({ kind: 'add' as const, line, key: i })) };
    }
    const parts = diffLines(before, after);
    const out: Row[] = [];
    let k = 0;
    for (const p of parts) {
      const kind = p.added ? 'add' : p.removed ? 'del' : 'ctx';
      const ls = p.value.replace(/\n$/, '').split('\n');
      for (const line of ls) out.push({ kind, line, key: k++ });
    }
    return { kind: 'rows', rows: out };
  }, [entry]);

  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-path">{entry.path}</span>
        <span className={`diff-status diff-status-${entry.status}`}>{entry.status}</span>
      </div>
      {model.kind === 'binary' ? (
        <BinaryView entry={entry} />
      ) : model.kind === 'toobig' ? (
        <div className="diff-toobig pad">
          {model.added === 0 && model.removed === 0 ? (
            <p className="diff-gap diff-gap-static">⋯ {model.lines.toLocaleString()} unchanged lines</p>
          ) : (
            <>
              <p>Too large to display inline — {model.kb.toLocaleString()} KB, {model.lines.toLocaleString()} lines.</p>
              <p className="diff-counts">
                <span className="dc-add">+{model.added.toLocaleString()}</span>
                <span className="dc-del">−{model.removed.toLocaleString()}</span>
                <span className="muted">changed lines</span>
              </p>
            </>
          )}
        </div>
      ) : (
        <pre className="diff-body">
          {collapseContext(model.rows).map((r) =>
            r.kind === 'gap' ? (
              <div key={`gap-${r.key}`} className="diff-gap">
                ⋯ {r.hidden} unchanged lines
              </div>
            ) : (
              <div key={r.key} className={`diff-line dl-${r.kind}`}>
                <span className="dl-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
                <span className="dl-text">{r.line || ' '}</span>
              </div>
            ),
          )}
        </pre>
      )}
    </div>
  );
}

type Row = { kind: 'add' | 'del' | 'ctx'; line: string; key: number };
type RenderRow = Row | { kind: 'gap'; hidden: number; key: number };

// Collapse long runs of unchanged context to keep diffs readable.
function collapseContext(rows: Row[]): RenderRow[] {
  const PAD = 3;
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.kind !== 'ctx') {
      for (let j = Math.max(0, i - PAD); j <= Math.min(rows.length - 1, i + PAD); j++) keep[j] = true;
    }
  });
  const out: RenderRow[] = [];
  let hidden = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (hidden > 0) {
        out.push({ kind: 'gap', hidden, key: i });
        hidden = 0;
      }
      out.push(r);
    } else {
      hidden++;
    }
  });
  if (hidden > 0) out.push({ kind: 'gap', hidden, key: rows.length });
  return out;
}

function tail(path: string): string {
  return path.split('/').pop() ?? path;
}
