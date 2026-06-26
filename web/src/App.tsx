import { useCallback, useState } from 'react';
import { Loader2, Lock, RotateCcw, ShieldCheck } from 'lucide-react';
import { Dropzone } from './components/Dropzone.tsx';
import { Results } from './components/Results.tsx';
import { runConversion, type ModFile, type ModResult } from './lib/engine.ts';

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; label: string }
  | { kind: 'done'; result: ModResult }
  | { kind: 'error'; message: string };

export function App(): React.ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const handleFiles = useCallback((files: ModFile[], label: string) => {
    if (files.length === 0) {
      setPhase({ kind: 'error', message: 'No files found in that drop.' });
      return;
    }
    setPhase({ kind: 'working', label });
    // Defer so the spinner paints before the (synchronous) parse runs.
    window.setTimeout(() => {
      try {
        const result = runConversion(files, label);
        setPhase({ kind: 'done', result });
      } catch (e) {
        setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    }, 40);
  }, []);

  const onError = useCallback((message: string) => setPhase({ kind: 'error', message }), []);
  const reset = useCallback(() => setPhase({ kind: 'idle' }), []);

  return (
    <div className="app">
      <div className="bg-grid" aria-hidden />
      <div className="bg-glow" aria-hidden />

      <header className="topbar">
        <div className="brand" onClick={reset} role="button" tabIndex={0}>
          <span className="logo">
            <span className="logo-41">41</span>
            <span className="logo-arrow">→</span>
            <span className="logo-42">42</span>
          </span>
          <div className="brand-text">
            <h1>PZ Mod Porter</h1>
            <p>Project Zomboid · Build 41 → Build 42</p>
          </div>
        </div>
        <div className="topbar-right">
          <span className="trust">
            <Lock size={14} /> Files never leave your machine
          </span>
          <span className="trust trust-dim">
            <ShieldCheck size={15} /> 100% in-browser
          </span>
        </div>
      </header>

      <main className="main">
        {phase.kind === 'idle' && <Landing onFiles={handleFiles} onError={onError} />}

        {phase.kind === 'working' && (
          <div className="working card">
            <Loader2 className="spin" size={40} />
            <h2>Converting…</h2>
            <p className="muted">Parsing scripts &amp; Lua from {phase.label}</p>
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="working card error-card">
            <h2>Couldn’t convert that</h2>
            <p className="muted">{phase.message}</p>
            <button className="btn" onClick={reset}>
              <RotateCcw size={16} /> Try another
            </button>
          </div>
        )}

        {phase.kind === 'done' && <Results result={phase.result} onReset={reset} />}
      </main>

      <footer className="footer">
        <span>Runs offline — your mod files never leave this machine.</span>
        <span className="footer-links">
          <a href="https://github.com/NoahBPeterson/pz-mod-porter/issues" target="_blank" rel="noreferrer">
            Report an issue
          </a>
          <span className="muted">· B41 → B42 · client-side</span>
        </span>
      </footer>
    </div>
  );
}

function Landing({
  onFiles,
  onError,
}: {
  onFiles: (files: ModFile[], label: string) => void;
  onError: (message: string) => void;
}): React.ReactElement {
  return (
    <div className="landing">
      <div className="hero">
        <div className="hero-eyebrow">WORKSHOP MOD CONVERTER</div>
        <h2 className="hero-title">
          Port your Build&nbsp;41 mod to <span className="accent">Build&nbsp;42</span> in one drop.
        </h2>
        <p className="hero-sub">
          Recipes become the new <code>craftRecipe</code> syntax, items migrate to <code>ItemType</code>,
          a <code>Recipes.json</code> is generated, and your Lua is rewritten where it’s safe — then
          flagged honestly where a human still needs to step in.
        </p>
      </div>

      <Dropzone onFiles={onFiles} onError={onError} />

      <div className="proof">
        <Stat n="510 / 561" l="workshop mods convert hands-off" />
        <Stat n="0" l="crashes across the corpus" />
        <Stat n="8,400+" l="timedActions recovered automatically" />
        <Stat n="100%" l="runs in your browser" />
      </div>
    </div>
  );
}

function Stat({ n, l }: { n: string; l: string }): React.ReactElement {
  return (
    <div className="proof-stat">
      <div className="proof-n">{n}</div>
      <div className="proof-l">{l}</div>
    </div>
  );
}
