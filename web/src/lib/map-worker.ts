/// <reference lib="webworker" />
// Off-main-thread map re-grid. Runs the (CPU-heavy) convertMapCells in a Web
// Worker so the UI never freezes; streams per-cell progress back and transfers
// the produced cell buffers to avoid a copy.
import { convertMapCells, type MapConvertStats } from '@engine/map/convert.js';

export interface MapWorkerRequest {
  id: number;
  dir: string;
  input: [string, Uint8Array][];
  ownSheets: string[];
}
export type MapWorkerResponse =
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'done'; id: number; files: [string, Uint8Array][]; stats: MapConvertStats; warnings: string[] }
  | { type: 'error'; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<MapWorkerRequest>): void => {
  const { id, dir, input, ownSheets } = e.data;
  try {
    const result = convertMapCells(new Map(input), {
      ownSheets: new Set(ownSheets),
      onProgress: (done, total) => ctx.postMessage({ type: 'progress', id, done, total } satisfies MapWorkerResponse),
    });
    const files = [...result.files.entries()];
    const transfer = files.map(([, b]) => b.buffer);
    ctx.postMessage(
      { type: 'done', id, files, stats: result.stats, warnings: result.warnings } satisfies MapWorkerResponse,
      transfer,
    );
  } catch (err) {
    ctx.postMessage({ type: 'error', id, message: err instanceof Error ? err.message : String(err), dir } as MapWorkerResponse);
  }
};
