import type { SimParams } from "../simulation/types";

export const MIN_RUNS = 1;
export const MAX_RUNS = 100;

export function isValidRunCount(runCount: number): boolean {
  return Number.isInteger(runCount) && runCount >= MIN_RUNS && runCount <= MAX_RUNS;
}

export type RunConditionSnapshot = {
  presetId: string;
  seed: number;
  params: SimParams;
};

export function isSameCondition(a: RunConditionSnapshot, b: RunConditionSnapshot): boolean {
  return a.presetId === b.presetId && a.seed === b.seed && JSON.stringify(a.params) === JSON.stringify(b.params);
}
