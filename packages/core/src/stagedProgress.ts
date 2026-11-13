/**
 * Progress of an analysis made of several stages, each of which walks the whole document and reports its own
 * `(done, total)`. The caller gets one figure that only grows: whole percent of all stages together, every stage
 * counted as an equal share. It is told only when that figure changes, so a stage that reports once per page does not
 * make the caller redraw hundreds of times for the same number.
 */
export function stagedProgress(onProgress: ((done: number, total: number) => void) | undefined, stageCount: number): (stageIndex: number) => ((done: number, total: number) => void) | undefined {
  if (!onProgress) return () => undefined;
  let reported = -1;
  return (stageIndex) => (done, total) => {
    const share = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
    const percent = Math.floor(((stageIndex + share) / stageCount) * 100);
    if (percent <= reported) return;
    reported = percent;
    onProgress(percent, 100);
  };
}
