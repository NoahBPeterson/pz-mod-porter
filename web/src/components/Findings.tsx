import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { FindingGroup, Tier } from '../lib/engine.ts';

const TIER_RANK: Record<Tier, number> = { manual: 0, review: 1, notes: 2, clean: 3 };

export function Findings({ groups }: { groups: FindingGroup[] }): React.ReactElement {
  const sorted = [...groups].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
  return (
    <div className="findings">
      {sorted.map((g) => (
        <Group key={g.key} group={g} defaultOpen={g.tier === 'manual' || g.tier === 'review'} />
      ))}
    </div>
  );
}

function Group({ group, defaultOpen }: { group: FindingGroup; defaultOpen: boolean }): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`finding finding-${group.tier}`}>
      <button className="finding-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronRight className={`chev${open ? ' open' : ''}`} size={16} />
        <span className="finding-dot" />
        <span className="finding-title">{group.title}</span>
        <span className="finding-count">{group.items.length}</span>
      </button>
      {open && (
        <div className="finding-body">
          <p className="finding-blurb">{group.blurb}</p>
          <ul className="finding-items">
            {group.items.slice(0, 60).map((it, i) => (
              <li key={i} className="finding-item">
                {it.file && (
                  <span className="fi-loc">
                    {shorten(it.file)}
                    {typeof it.line === 'number' && it.line > 0 ? `:${it.line}` : ''}
                  </span>
                )}
                <span className="fi-msg">{it.message}</span>
                {it.snippet && <code className="fi-snippet">{it.snippet.trim().slice(0, 160)}</code>}
              </li>
            ))}
            {group.items.length > 60 && (
              <li className="finding-item muted">…and {group.items.length - 60} more</li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

function shorten(path: string): string {
  const parts = path.split('/');
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}
