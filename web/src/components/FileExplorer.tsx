import { useEffect, useMemo, useState } from 'react';
import { diffLines } from 'diff';
import { ChevronDown, ChevronRight, FileCode2, FileImage, FilePlus2, Folder, FolderOpen, Package, Pencil } from 'lucide-react';
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

  const tree = useMemo(() => buildTree(visible), [visible]);
  // Collapse folders that hold no changed files (only relevant once unchanged
  // are shown); keep paths to the changed files open. Recomputed per tree.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggleDir = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });

  return (
    <div className="explorer">
      <aside className="explorer-list">
        <TreeRows
          nodes={tree}
          depth={0}
          activePath={active?.path}
          collapsed={collapsed}
          onToggleDir={toggleDir}
          onSelect={setSelected}
        />
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

// --- directory tree --------------------------------------------------------

type FileLeaf = { type: 'file'; name: string; entry: FileEntry };
type DirNode = { type: 'dir'; name: string; path: string; children: TreeNode[] };
type TreeNode = FileLeaf | DirNode;

// Group a flat file list into a directory tree, then collapse single-child
// directory chains (e.g. media/lua/shared/Translate/EN) into one row so the
// hierarchy stays shallow where nothing branches.
function buildTree(files: readonly FileEntry[]): TreeNode[] {
  const root: DirNode = { type: 'dir', name: '', path: '', children: [] };
  for (const entry of files) {
    const parts = entry.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i] ?? '';
      const path = parts.slice(0, i + 1).join('/');
      let next = cur.children.find((c): c is DirNode => c.type === 'dir' && c.name === name);
      if (!next) { next = { type: 'dir', name, path, children: [] }; cur.children.push(next); }
      cur = next;
    }
    cur.children.push({ type: 'file', name: parts[parts.length - 1] ?? entry.path, entry });
  }
  return normalize(root.children);
}

function normalize(nodes: TreeNode[]): TreeNode[] {
  const out = nodes.map((n) => {
    if (n.type !== 'dir') return n;
    let dir = n;
    while (dir.children.length === 1 && dir.children[0]?.type === 'dir') {
      const only = dir.children[0];
      dir = { type: 'dir', name: `${dir.name}/${only.name}`, path: only.path, children: only.children };
    }
    return { type: 'dir' as const, name: dir.name, path: dir.path, children: normalize(dir.children) };
  });
  // Folders first, then files; each alphabetical.
  out.sort((a, b) =>
    a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name),
  );
  return out;
}

// Count changed (added/modified) files under a node — drives the folder badge.
function changedCount(node: TreeNode): number {
  if (node.type === 'file') return node.entry.status === 'added' || node.entry.status === 'modified' ? 1 : 0;
  return node.children.reduce((s, c) => s + changedCount(c), 0);
}

function TreeRows(props: {
  nodes: TreeNode[];
  depth: number;
  activePath: string | undefined;
  collapsed: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  onSelect: (path: string) => void;
}): React.ReactElement {
  const { nodes, depth, activePath, collapsed, onToggleDir, onSelect } = props;
  return (
    <>
      {nodes.map((n) => {
        const pad = { paddingLeft: 8 + depth * 13 } as const;
        if (n.type === 'dir') {
          const open = !collapsed.has(n.path);
          const changed = changedCount(n);
          const Chevron = open ? ChevronDown : ChevronRight;
          const FolderIcon = open ? FolderOpen : Folder;
          return (
            <div key={n.path}>
              <button className="fe-dir" style={pad} onClick={() => onToggleDir(n.path)} title={n.path}>
                <Chevron size={13} className="fe-chev" />
                <FolderIcon size={14} className="fe-icon" />
                <span className="fe-name">{n.name}</span>
                {changed > 0 && <span className="fe-count">{changed}</span>}
              </button>
              {open && (
                <TreeRows {...props} nodes={n.children} depth={depth + 1} />
              )}
            </div>
          );
        }
        const f = n.entry;
        const Icon = iconFor(f);
        return (
          <button
            key={f.path}
            className={`fe-item fe-${f.status}${activePath === f.path ? ' active' : ''}`}
            style={pad}
            onClick={() => onSelect(f.path)}
            title={f.path}
          >
            <Icon size={14} className="fe-icon" />
            <span className="fe-name">{n.name}</span>
            <span className={`fe-tag fe-tag-${f.status}`}>{STATUS_META[f.status].label}</span>
          </button>
        );
      })}
    </>
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

