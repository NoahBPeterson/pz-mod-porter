import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  Download,
  FileText,
  ListChecks,
  Loader2,
  Map as MapIcon,
  RotateCcw,
  Sparkles,
  Wrench,
} from 'lucide-react';
import {
  buildDiagnostic,
  buildZip,
  convertModMaps,
  diffFiles,
  issueUrl,
  sanitize,
  saveBlob,
  type ModResult,
  type Tier,
} from '../lib/engine.ts';
import { Findings } from './Findings.tsx';
import { FileExplorer } from './FileExplorer.tsx';

const TIER_META: Record<Tier, { label: string; Icon: typeof CheckCircle2 }> = {
  clean: { label: 'Fully converted', Icon: CheckCircle2 },
  notes: { label: 'Converted · minor notes', Icon: ListChecks },
  review: { label: 'Converted · review advised', Icon: AlertTriangle },
  manual: { label: 'Needs manual porting', Icon: Wrench },
};

type Tab = 'report' | 'files';

export function Results({ result, onReset }: { result: ModResult; onReset: () => void }): React.ReactElement {
  const [current, setCurrent] = useState(result);
  const [tab, setTab] = useState<Tab>('report');
  const [busy, setBusy] = useState(false);
  const [mapBusy, setMapBusy] = useState(false);
  const [mapProgress, setMapProgress] = useState<{ done: number; total: number; eta: number } | null>(null);
  const mapStart = useRef(0);

  // Reset when a brand-new conversion arrives.
  useEffect(() => setCurrent(result), [result]);

  const files = useMemo(() => diffFiles(current.inputFiles, current.outputFiles), [current]);
  const changed = files.filter((f) => f.status !== 'unchanged').length;
  const meta = TIER_META[current.tier];

  const downloadZip = async (): Promise<void> => {
    setBusy(true);
    try {
      const blob = await buildZip(current);
      saveBlob(blob, `${sanitize(current.modName)}-B42.zip`);
    } finally {
      setBusy(false);
    }
  };
  const reportIssue = (): void => {
    // GitHub can't auto-attach files, so download the full diagnostic AND open
    // a pre-filled issue — the user drags the .txt in.
    saveBlob(new Blob([buildDiagnostic(current)], { type: 'text/plain' }), `${sanitize(current.modName)}-diagnostic.txt`);
    window.open(issueUrl(current), '_blank', 'noopener,noreferrer');
  };

  const convertMaps = async (): Promise<void> => {
    setMapBusy(true);
    setMapProgress(null);
    mapStart.current = performance.now();
    try {
      const next = await convertModMaps(current, (done, total) => {
        const elapsed = performance.now() - mapStart.current;
        const eta = done > 0 ? (elapsed / done) * (total - done) : 0;
        setMapProgress({ done, total, eta });
      });
      setCurrent(next);
      setTab('report');
    } finally {
      setMapBusy(false);
      setMapProgress(null);
    }
  };

  const mapLabel = (): string => {
    if (!mapBusy) return 'Convert map cells to B42';
    if (!mapProgress || mapProgress.total === 0) return 'Reading cells…';
    const { done, total, eta } = mapProgress;
    const pct = Math.floor((done / total) * 100);
    const etaTxt =
      eta > 0 ? ` · ~${eta >= 60000 ? `${Math.ceil(eta / 60000)}m` : `${Math.ceil(eta / 1000)}s`} left` : '';
    return `Re-gridding ${done}/${total} (${pct}%)${etaTxt}`;
  };

  const showMapCTA = current.map.convertible && !current.map.converted;

  return (
    <div className="results">
      <div className={`verdict verdict-${current.tier}`}>
        <div className="verdict-icon">
          <meta.Icon size={26} />
        </div>
        <div className="verdict-body">
          <div className="verdict-row">
            <h2 className="verdict-mod">{current.modName}</h2>
            <span className={`pill pill-${current.tier}`}>{meta.label}</span>
          </div>
          <p className="verdict-text">{current.verdict}</p>
        </div>
        <button className="btn btn-ghost reset-btn" onClick={onReset}>
          <RotateCcw size={15} /> New
        </button>
      </div>

      {showMapCTA && (
        <div className="map-cta">
          <div className="map-cta-icon">
            <MapIcon size={22} />
          </div>
          <div className="map-cta-body">
            <strong>This is a map mod.</strong> Its baked B41 cells can be re-gridded to the Build 42 world
            grid (300²→256²) in your browser — a port of the engine’s own converter, verified lossless on real
            maps. Trees/vegetation B42 removed may be missing; buildings &amp; terrain are exact.
          </div>
          <button className="btn btn-map" onClick={() => void convertMaps()} disabled={mapBusy}>
            {mapBusy ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
            {mapLabel()}
          </button>
          {mapBusy && mapProgress && mapProgress.total > 0 && (
            <div className="map-progress" aria-hidden>
              <div className="map-progress-bar" style={{ width: `${(mapProgress.done / mapProgress.total) * 100}%` }} />
            </div>
          )}
        </div>
      )}

      <div className="stats">
        {current.stats.map((s) => (
          <div key={s.label} className={`stat stat-${s.tone}`}>
            <div className="stat-v">{s.value.toLocaleString()}</div>
            <div className="stat-l">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="action-bar">
        <button className="btn btn-primary" onClick={() => void downloadZip()} disabled={busy || mapBusy}>
          <Download size={17} /> {busy ? 'Packaging…' : 'Download B42 mod (.zip)'}
        </button>
        <button
          className={`btn ${current.tier === 'manual' || current.tier === 'review' ? 'btn-report' : 'btn-ghost'}`}
          onClick={reportIssue}
          title="Downloads a diagnostic .txt and opens a pre-filled GitHub issue"
        >
          <Bug size={16} /> Report an issue
        </button>
        <span className="action-note">{current.headline}</span>
      </div>

      <div className="tabs">
        <button className={`tab${tab === 'report' ? ' active' : ''}`} onClick={() => setTab('report')}>
          <ListChecks size={15} /> Findings
          {current.groups.length > 0 && <span className="tab-badge">{current.groups.length}</span>}
        </button>
        <button className={`tab${tab === 'files' ? ' active' : ''}`} onClick={() => setTab('files')}>
          <FileText size={15} /> Files &amp; diff
          <span className="tab-badge">{changed}</span>
        </button>
      </div>

      <div className="tab-panel">
        {tab === 'report' ? (
          current.groups.length === 0 ? (
            <div className="empty-state">
              <CheckCircle2 size={40} />
              <p>Nothing to flag. Every construct mapped cleanly to Build 42.</p>
            </div>
          ) : (
            <Findings groups={current.groups} />
          )
        ) : (
          <FileExplorer files={files} />
        )}
      </div>
    </div>
  );
}
