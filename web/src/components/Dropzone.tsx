import { useRef, useState } from 'react';
import { FileArchive, FolderOpen, UploadCloud } from 'lucide-react';
import { readDir, readEntries, readZip, type ModFile } from '../lib/engine.ts';

interface Props {
  onFiles: (files: ModFile[], label: string) => void;
  onError: (message: string) => void;
}

export function Dropzone({ onFiles, onError }: Props): React.ReactElement {
  const [over, setOver] = useState(false);
  const zipInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  const guard = (label: string, work: () => Promise<ModFile[]>): void => {
    work()
      .then((files) => onFiles(files, label))
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  };

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setOver(false);
    const dt = e.dataTransfer;

    // A dropped .zip comes through as a normal File.
    const zip = Array.from(dt.files).find((f) => f.name.toLowerCase().endsWith('.zip'));
    if (zip) {
      guard(zip.name, () => readZip(zip));
      return;
    }

    // A dropped FOLDER must be walked via the entry API — and the entries have
    // to be grabbed synchronously, right now, before this event is recycled.
    const roots: FileSystemEntry[] = [];
    if (dt.items && dt.items.length > 0) {
      for (const item of Array.from(dt.items)) {
        const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
        if (entry) roots.push(entry);
      }
    }
    if (roots.length > 0) {
      const label = roots.length === 1 && roots[0] ? roots[0].name : 'dropped folder';
      guard(label, () => readEntries(roots));
      return;
    }

    // Fallback: loose files (no directory structure).
    if (dt.files.length > 0) {
      guard('dropped files', () => readDir(dt.files));
      return;
    }
    onError('Nothing readable in that drop. Try the “Choose folder” button instead.');
  };

  return (
    <div
      className={`dropzone${over ? ' over' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragOver={(e) => {
        // Fires continuously while over the box AND its children — re-assert
        // the highlight so crossing onto a child element doesn't drop it.
        e.preventDefault();
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        // Only clear when leaving the dropzone entirely, not when moving onto
        // a child node (whose dragleave reports the child as relatedTarget).
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) setOver(false);
      }}
      onDrop={onDrop}
      onClick={() => zipInput.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') zipInput.current?.click();
      }}
    >
      <div className="dz-icon">
        <UploadCloud size={34} />
      </div>
      <p className="dz-title">
        Drop a mod <b>.zip</b> or <b>folder</b>
      </p>
      <p className="dz-sub">
        the folder containing <code>mod.info</code> / <code>media/</code> — or click to browse
      </p>

      <div className="dz-actions">
        <button
          className="btn"
          onClick={(e) => {
            e.stopPropagation();
            zipInput.current?.click();
          }}
        >
          <FileArchive size={16} /> Choose .zip
        </button>
        <button
          className="btn btn-ghost"
          onClick={(e) => {
            e.stopPropagation();
            dirInput.current?.click();
          }}
        >
          <FolderOpen size={16} /> Choose folder
        </button>
      </div>

      <input
        ref={zipInput}
        type="file"
        accept=".zip"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) guard(f.name, () => readZip(f));
          e.target.value = '';
        }}
      />
      <input
        ref={dirInput}
        type="file"
        hidden
        // @ts-expect-error — non-standard but widely supported folder picker attrs.
        webkitdirectory=""
        directory=""
        multiple
        onChange={(e) => {
          const fl = e.target.files;
          if (fl && fl.length > 0) guard('folder', () => readDir(fl));
          e.target.value = '';
        }}
      />
    </div>
  );
}
