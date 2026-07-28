import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { getPresetById } from "./presets";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import type { FormationRuntimeOptions } from "./formationPolicy";
import type { SimulationEventType, SimulationState } from "./types";

/**
 * Issue #202 2節: Phase 3の2比較プリセット(「交流先へ移りやすい場」/「今の輪への配慮が強い場」)が、
 * 標準ケースと同じ`SimParams`/Phase 2設定のまま、意図した定性的な差(目的地付き移動のしやすさ/
 * 愛着・配慮によるstayのしやすさ)を実際に示すことを、`standingPartyPresetComparison.test.ts`と同じ
 * 固定seed列・平均化の方針で検証する(単一seedでの確率的揺れを避ける)。
 * 統計的有意差や現実妥当性を主張するテストではない。
 */

const SEED_COUNT = 15;
const BASE_SEED = 7000;
const TICKS = 500;

function formationOptionsFor(presetId: string): FormationRuntimeOptions {
  const preset = getPresetById(presetId);
  return {
    scenarioId: "standingParty",
    standingPartyConfig: preset.formationStandingPartyConfig ?? DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  };
}

function runStandingPartyPreset(presetId: string, seed: number, ticks: number): SimulationState {
  const preset = getPresetById(presetId);
  const formation = formationOptionsFor(presetId);
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
  for (let i = 0; i < ticks; i++) {
    state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
  }
  return state;
}

function averageEventCount(presetId: string, eventType: SimulationEventType): number {
  const totals = Array.from({ length: SEED_COUNT }, (_, index) => {
    const state = runStandingPartyPreset(presetId, BASE_SEED + index, TICKS);
    return state.log.filter((entry) => entry.eventType === eventType).length;
  });
  return totals.reduce((sum, value) => sum + value, 0) / totals.length;
}

describe("Phase 3比較プリセットの定性的比較 (Issue #202 2節)", () => {
  it("「交流先へ移りやすい場」は標準ケースより、目的地付き移動(switchToTargetCluster)が観察しやすい", () => {
    const outward = averageEventCount("standing-party-outward-interest", "clusterTransitionTargetSelected");
    const standard = averageEventCount("standing-party", "clusterTransitionTargetSelected");
    expect(outward).toBeGreaterThan(standard);
    expect(outward).toBeGreaterThan(0);
  });

  it("「今の輪への配慮が強い場」は標準ケースより、愛着・配慮由来のstay(clusterTransitionInhibited)が観察しやすい", () => {
    const attached = averageEventCount("standing-party-current-circle", "clusterTransitionInhibited");
    const standard = averageEventCount("standing-party", "clusterTransitionInhibited");
    expect(attached).toBeGreaterThan(standard);
    expect(attached).toBeGreaterThan(0);
  });

  it("「今の輪への配慮が強い場」でも目的地付き移動が完全にゼロにはならない(永久に移動しない極端な設定ではない)", () => {
    const attached = averageEventCount("standing-party-current-circle", "clusterTransitionTargetSelected");
    expect(attached).toBeGreaterThan(0);
  });

  it("「交流先へ移りやすい場」は標準ケースと比べて会場退出人数を増やす設定ではない(Phase 2離脱判定は標準と同一)", () => {
    const outwardPreset = getPresetById("standing-party-outward-interest");
    const standardPreset = getPresetById("standing-party");
    expect(outwardPreset.formationStandingPartyConfig?.clusterDeparture).toEqual(
      standardPreset.formationStandingPartyConfig?.clusterDeparture ?? DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.clusterDeparture,
    );
  });
});
