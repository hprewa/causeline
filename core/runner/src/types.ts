/**
 * What every tool returns, never a rate or a computed total. For a ratio: numerator and denominator.
 * For a sum: the total (`num`), the row count (`den`) and the sum of squares (`sq`), from which the
 * variance of the total is estimated.
 */
export interface Components {
  num: number;
  den: number;
  sq?: number;
}

/** One child node with its components in the current and baseline windows. */
export interface ChildRow {
  node: string;
  cur: Components;
  base: Components;
}

/** A time bucket as returned by the series tools. */
export interface Bucket extends Components {
  bucket: string;
  bucket_start: string;
  bucket_end: string;
  /** Where the bucket falls in each declared cycle; null when the bucket spans several positions. */
  slots?: Record<string, string | null>;
}

export type Row = Record<string, unknown>;

/**
 * The only way the runner touches data. The real implementation wraps the
 * Toolbox SDK; tests use an in-memory fake. Throws on tool errors.
 */
export interface ToolCaller {
  call(tool: string, params: Record<string, string>, stepId: string): Promise<Row[]>;
}

export type Direction = "higher_is_better" | "lower_is_better";
