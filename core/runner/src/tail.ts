// The newest periods of a copy of the data can hold far less than usual because the data was still arriving when it was copied.

export const medianOf = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
};

/**
 * The index of the newest period that looks settled: not far below what the periods before it held. A period under 80% of the median of the
 * (up to eight) before it is taken as still filling in, and so is any newer one; at most eight are set aside, and at least four periods must
 * come before one for the comparison to mean anything.
 */
export function settledEnd(volumes: number[]): number {
  let end = volumes.length - 1;
  for (let dropped = 0; dropped < 8 && end >= 4; dropped++) {
    const before = volumes.slice(Math.max(0, end - 8), end);
    if (before.length >= 4 && volumes[end] < 0.8 * medianOf(before)) end--;
    else break;
  }
  return end;
}
