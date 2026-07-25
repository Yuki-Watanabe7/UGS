import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { getPresetById } from "./presets";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import { buildStandingPartyRunSummary } from "./standingPartyComparison";
import type { FormationRuntimeOptions } from "./formationPolicy";
import type { LogEntry, SimulationState } from "./types";

/**
 * Issue #190 6/7節: cluster離脱(責務9)後にagentが`undecided`へ戻り既存stress蓄積が再開する、
 * という合成が、会場退出(責務4)へ意図せず退化していないことを検証する。
 *
 * - 高回遊agentが離脱直後に必ず帰宅する設計になっていない
 * - 再接近cooldown中も他clusterへ接近可能である
 * - cluster解散による強制release(責務10)を自発的回遊(責務9)として集計しない
 * - 会場退出("left")したagentがactive episode/cluster membershipを保持しない
 *
 * `standingPartyDynamicCycle.test.ts`(単一seed・単一シナリオの一連の流れ)とは異なり、
 * ここでは複数seed・複数プリセットにわたる集計/invariantとして検証する。
 */

const SEEDS = [2000, 2001, 2002, 2003, 2004];
const TICKS = 300;
const PRESET_IDS = ["standing-party", "standing-party-networking", "standing-party-intimate"] as const;

function formationOptionsFor(presetId: string): FormationRuntimeOptions {
  const preset = getPresetById(presetId);
  return {
    scenarioId: "standingParty",
    standingPartyConfig: preset.formationStandingPartyConfig ?? DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  };
}

/** 各tickのstateを保持して返す(states[0]は初期状態、states[i]はtick iの結果)。300tick程度ならメモリ上問題ない */
function runTickByTick(presetId: string, seed: number, ticks: number): SimulationState[] {
  const preset = getPresetById(presetId);
  const formation = formationOptionsFor(presetId);
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
  const states: SimulationState[] = [state];
  for (let i = 0; i < ticks; i++) {
    state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
    states.push(state);
  }
  return states;
}

function entriesAtTick(log: LogEntry[], tick: number): LogEntry[] {
  return log.filter((entry) => entry.tick === tick);
}

describe("cluster離脱と会場退出の相互作用 (Issue #190 6/7節)", () => {
  it("cluster離脱は離脱直後の即時venue exitを強制しない(離脱直後にleaving/leftへ遷移する割合は低い)", () => {
    let totalDepartures = 0;
    let immediateLeaving = 0;
    for (const presetId of PRESET_IDS) {
      for (const seed of SEEDS) {
        const states = runTickByTick(presetId, seed, TICKS);
        for (const state of states) {
          for (const entry of entriesAtTick(state.log, state.tick)) {
            if (entry.eventType !== "clusterDepartureCompleted") continue;
            totalDepartures++;
            const agent = state.agents.find((a) => a.id === entry.metadata?.agentId);
            if (agent && (agent.state === "leaving" || agent.state === "left")) immediateLeaving++;
          }
        }
      }
    }
    expect(totalDepartures).toBeGreaterThan(0);
    // 離脱直後にstressが既にleaveThresholdを超えている稀なケースまで完全に0とは断定しないが
    // (責務9のdepartFromClusterと責務7のstress蓄積/canLeave判定は同一tick内で連続して走るため
    // 理論上は起こり得る)、「離脱すればほぼ必ず帰宅する」という退化になっていないことを
    // 緩い上限(5%)で確認する。
    expect(immediateLeaving / totalDepartures).toBeLessThan(0.05);
  });

  it("再接近cooldown中(CLUSTER_REJOIN_COOLDOWN_TICKS未満)でも、離脱元とは異なるclusterへ再参加できる", () => {
    let crossClusterDuringCooldown = 0;
    for (const presetId of PRESET_IDS) {
      for (const seed of SEEDS) {
        const states = runTickByTick(presetId, seed, TICKS);
        const finalState = states[states.length - 1];
        for (const entry of finalState.log) {
          if (entry.eventType !== "clusterRejoined") continue;
          if (
            entry.metadata?.ticksSinceDeparture !== undefined &&
            entry.metadata.ticksSinceDeparture < 10 &&
            entry.metadata.groupId !== undefined &&
            entry.metadata.groupId !== entry.metadata.previousClusterId
          ) {
            crossClusterDuringCooldown++;
          }
        }
      }
    }
    // cooldownは「離脱元clusterへの再接近」だけを対象候補から除外する設計であり(engine.tsの
    // cooldownExcludeIdsはlastDepartedClusterIdのみを含む)、他のclusterへの接近を妨げない。
    // このtick数・seed数であれば、この経路が実際に発生することを実測で確認できる。
    expect(crossClusterDuringCooldown).toBeGreaterThan(0);
  });

  it("cluster解散による強制release(clusterMemberReleased)は自発離脱(voluntaryDepartureCount)として集計されない", () => {
    let sawForcedRelease = false;
    for (const presetId of PRESET_IDS) {
      for (const seed of SEEDS) {
        const finalState = runTickByTick(presetId, seed, TICKS).at(-1)!;
        const summary = buildStandingPartyRunSummary(finalState);

        const forcedReleaseEvents = finalState.log.filter((e) => e.eventType === "clusterMemberReleased");
        const voluntaryDepartureEvents = finalState.log.filter((e) => e.eventType === "clusterDepartureCompleted");
        if (forcedReleaseEvents.length > 0) sawForcedRelease = true;

        expect(summary.totalForcedReleaseCount).toBe(forcedReleaseEvents.length);
        expect(summary.totalVoluntaryDepartureCount).toBe(voluntaryDepartureEvents.length);
        // 集計上も分離されている(片方の件数がもう片方を汚染しない)
        for (const metric of summary.agentMetrics) {
          const agentForcedReleases = forcedReleaseEvents.filter((e) => e.metadata?.agentId === metric.agentId).length;
          const agentVoluntaryDepartures = voluntaryDepartureEvents.filter(
            (e) => e.metadata?.agentId === metric.agentId,
          ).length;
          expect(metric.forcedReleaseCount).toBe(agentForcedReleases);
          expect(metric.voluntaryDepartureCount).toBe(agentVoluntaryDepartures);
        }
      }
    }
    // このtick数・seed数の範囲で少なくとも1件は強制releaseが発生する(検証対象が空でないことの確認)
    expect(sawForcedRelease).toBe(true);
  });

  it("会場退出(\"left\")したagentはactive episode/cluster membershipを保持しない", () => {
    let sawLeftAgent = false;
    for (const presetId of PRESET_IDS) {
      for (const seed of SEEDS) {
        const finalState = runTickByTick(presetId, seed, 500).at(-1)!;
        for (const agent of finalState.agents) {
          if (agent.state !== "left") continue;
          sawLeftAgent = true;
          expect(agent.currentEpisode).toBeUndefined();
          expect(agent.joinedGroupId).toBeUndefined();
          expect(agent.clusterJoinedAtTick).toBeUndefined();
          // 会場退出前にcluster離脱していたはずのcluster自体からも除籍済み
          for (const candidate of finalState.groupCandidates) {
            expect(candidate.memberIds).not.toContain(agent.id);
          }
        }
      }
    }
    expect(sawLeftAgent).toBe(true);
  });
});
