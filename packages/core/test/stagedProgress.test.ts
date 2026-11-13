import { describe, expect, it } from 'vitest';
import { stagedProgress } from '../src/stagedProgress.js';

describe('stagedProgress — one growing figure for several stages', () => {
  it('gives every stage an equal share of 100 and reports each percent once', () => {
    const calls: [number, number][] = [];
    const progressOf = stagedProgress((done, total) => calls.push([done, total]), 2);
    for (let page = 1; page <= 400; page++) progressOf(0)?.(page, 400);
    expect(calls.at(-1)).toEqual([50, 100]);
    for (let page = 1; page <= 10; page++) progressOf(1)?.(page, 10);
    expect(calls.at(-1)).toEqual([100, 100]);
    const percents = calls.map(([done]) => done);
    expect(percents).toEqual([...new Set(percents)]);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(calls.length).toBeLessThanOrEqual(101);
  });

  it('never goes back when a later stage starts from zero, and tolerates an empty stage', () => {
    const calls: number[] = [];
    const progressOf = stagedProgress((done) => calls.push(done), 3);
    progressOf(0)?.(5, 5);
    progressOf(1)?.(0, 0);
    progressOf(1)?.(1, 4);
    expect(calls).toEqual([33, 41]);
  });

  it('hands out nothing when the caller does not listen', () => {
    expect(stagedProgress(undefined, 3)(0)).toBeUndefined();
  });
});
