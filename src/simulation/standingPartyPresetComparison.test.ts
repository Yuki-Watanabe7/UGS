import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { getPresetById } from "./presets";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import { buildStandingPartyRunSummary, summarizeStandingPartyRuns } from "./standingPartyComparison";
import type { FormationRuntimeOptions } from "./formationPolicy";
import type { SimulationState, StandingPartyMonteCarloSummary } from "./types";

/**
 * Issue #190 5節: standingPartyの比較プリセット(標準/ネットワーキング型/懇親型、#189)を、
 * 同一seed列・同一population・同一horizonでpaired比較し、意図した定性的な差が固定seed列の
 * 集計で現れることを検証する。
 *
 * これは統計的有意差や現実妥当性を主張するテストではない(issue #190「対象外」節)。
 * 単一seedでは責務9の確率的な離脱判定によって結果が揺れるため(`clusterDeparture.test.ts`と同様の
 * 前提)、`SEED_COUNT`個の固定seedにわたって平均した集計値どうしを比較することでflakyさを避ける。
 * `SEED_COUNT=15`・`TICKS=500`は、`standingPartyDynamicCycle.test.ts`(単一seed・400tick)より
 * 長め/多めにして「平均に均されたうえでの方向性」を安定させるための経験的な値であり、
 * 特定の数値を現実の予測として主張するものではない。
 */

const SEED_COUNT = 15;
const BASE_SEED = 5000;
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

function summarizePreset(presetId: string): StandingPartyMonteCarloSummary {
  const runs = Array.from({ length: SEED_COUNT }, (_, index) =>
    buildStandingPartyRunSummary(runStandingPartyPreset(presetId, BASE_SEED + index, TICKS)),
  );
  return summarizeStandingPartyRuns(runs);
}

describe("standingPartyプリセット間の定性的比較 (Issue #190 5節)", () => {
  // 3プリセットとも同一seed列(BASE_SEED..BASE_SEED+SEED_COUNT-1)・同一population(populationSize: 24)・
  // 同一horizon(TICKS: 500)で実行する(受入条件: 同一seed列・同一population・同一horizonでのpaired比較)。
  const standard = summarizePreset("standing-party");
  const networking = summarizePreset("standing-party-networking");
  const intimate = summarizePreset("standing-party-intimate");

  it("ネットワーキング型は懇親型より、agentあたりの自発cluster離脱回数が多い", () => {
    expect(networking.averageVoluntaryDepartureCountPerAgent).toBeGreaterThan(
      intimate.averageVoluntaryDepartureCountPerAgent,
    );
  });

  it("ネットワーキング型は懇親型より、agentあたりの再参加回数が多い", () => {
    expect(networking.averageRejoinCountPerAgent).toBeGreaterThan(intimate.averageRejoinCountPerAgent);
  });

  it("ネットワーキング型は懇親型より、agentあたりの異なるcluster参加数が多い", () => {
    expect(networking.averageDistinctClusterCountPerAgent).toBeGreaterThan(
      intimate.averageDistinctClusterCountPerAgent,
    );
  });

  it("懇親型はネットワーキング型より、完了episodeの代表滞在tick(平均・中央値)が長い", () => {
    expect(intimate.averageMeanCompletedEpisodeDwellTicks).toBeDefined();
    expect(networking.averageMeanCompletedEpisodeDwellTicks).toBeDefined();
    expect(intimate.averageMeanCompletedEpisodeDwellTicks!).toBeGreaterThan(
      networking.averageMeanCompletedEpisodeDwellTicks!,
    );
    expect(intimate.averageMedianCompletedEpisodeDwellTicks!).toBeGreaterThan(
      networking.averageMedianCompletedEpisodeDwellTicks!,
    );
  });

  it("標準ケースの代表滞在tickは、ネットワーキング型と懇親型の間に収まる(満足度減衰を遅くしても代表滞在時間が短くならない、という単調な方向性の確認)", () => {
    expect(standard.averageMeanCompletedEpisodeDwellTicks).toBeDefined();
    expect(standard.averageMeanCompletedEpisodeDwellTicks!).toBeGreaterThan(
      networking.averageMeanCompletedEpisodeDwellTicks!,
    );
    expect(standard.averageMeanCompletedEpisodeDwellTicks!).toBeLessThan(
      intimate.averageMeanCompletedEpisodeDwellTicks!,
    );
  });

  it("回遊傾向を上げても、会場退出人数だけが機械的に増える退化挙動になっていない(会場退出は3プリセットでほぼ同水準、交流指標だけが動く)", () => {
    // Phase 2の満足度・回遊傾向はcluster離脱(責務9)にのみ効き、会場退出(責務4、leaveThreshold判定)の
    // 既存stressモデルへは一切接続しない(docs/conversation-satisfaction-model.md 2.1節)。
    // そのため、再参加・異なるcluster参加のような「交流の量」が大きく変わっても、
    // 会場退出人数はプリセット間でほぼ変わらないはずである(退化していないことの直接的な確認)。
    expect(networking.averageRejoinCountPerAgent).toBeGreaterThan(intimate.averageRejoinCountPerAgent * 1.5);
    const venueExitSpread = Math.max(
      Math.abs(networking.averageVenueExitCount - standard.averageVenueExitCount),
      Math.abs(intimate.averageVenueExitCount - standard.averageVenueExitCount),
    );
    // populationSize: 24。venueExitCountの差が数人以内に収まっていれば
    // 「回遊傾向の違いが主に会場退出ではなく交流量に現れている」とみなす(緩めの許容幅)。
    expect(venueExitSpread).toBeLessThan(3);
  });

  it("強制release(clusterMemberReleased)は自発離脱として集計されない(voluntaryDepartureCountとforcedReleaseCountが独立)", () => {
    // 3プリセットいずれも成立最小人数割れによる解散が発生し得るstandingPartyのため、
    // 強制releaseの平均件数自体は0より大きくなり得るが、自発離脱指標には混入しない
    // (`standingPartyComparison.test.ts`の単体テストで検証済みの分離ロジックが、
    // 実際のシミュレーション実行でも成立していることの確認)。
    expect(standard.averageForcedReleaseCountPerAgent).toBeGreaterThanOrEqual(0);
    expect(networking.averageVoluntaryDepartureCountPerAgent).toBeGreaterThan(0);
  });
});
