// PZ world grid geometry. The B41->B42 map migration is fundamentally a
// re-grid between these two: squares are addressed in a continuous global
// coordinate space and re-bucketed from 300-cells into 256-cells.

export interface Grid {
  /** squares per chunk edge */
  readonly chunkDim: number;
  /** chunks per cell edge */
  readonly chunksPerCell: number;
  /** squares per cell edge (chunkDim * chunksPerCell) */
  readonly cellDim: number;
}

export const B41: Grid = { chunkDim: 10, chunksPerCell: 30, cellDim: 300 };
export const B42: Grid = { chunkDim: 8, chunksPerCell: 32, cellDim: 256 };

/** Magic bytes (ASCII "LOTH" / "LOTP"). */
export const LOTHEADER_MAGIC = new Uint8Array([76, 79, 84, 72]);
export const LOTPACK_MAGIC = new Uint8Array([76, 79, 84, 80]);
