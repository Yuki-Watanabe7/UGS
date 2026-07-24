import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { getPresetById } from "./presets";
import type { FormationRuntimeOptions } from "./formationPolicy";
import type { LogEntry, SimulationEventType, SimulationState } from "./types";

/**
 * Issue #178 (Phase 1 統合): #173〜#177で実装された立食パーティーの動的循環
 *   cluster作成 -> 会話成立 -> agent参加 -> agent離脱 -> 再探索 -> 別clusterへ再参加
 *   -> member減少によるcluster縮小/解散
 * を、1つの決定的な固定seed実行だけから、構造化イベント(`SimulationEventType`/`metadata`)のみを
 * 使って(表示文言の文字列解析なしに)一連の流れとして再現・検証する。
 *
 * 暫定離脱ルール(責務9)自体は毎tick確率的(`STANDING_PARTY_PROVISIONAL_DEPARTURE_PROBABILITY`)だが、
 * `SeededRandom`は同一seedなら常に同一の乱数列を返すため、固定seed(1)・生成人数24人・
 * 十分なtick数(400)の組み合わせで実行すれば、このテスト自体はflakyにならず毎回同じ結果になる
 * (`clusterDeparture.test.ts`/`standingPartyClusterLifecycle.test.ts`と同じ「固定seed + 十分な
 * guard」方式。責務9の判定式に決定境界を注入するテスト専用フックは存在しないため、この方式を踏襲する)。
 */

const STANDING_PARTY_FORMATION: FormationRuntimeOptions = { scenarioId: "standingParty" };
const DYNAMIC_CYCLE_SEED = 1;
const DYNAMIC_CYCLE_TICKS = 400;

function runStandingParty(seed: number, ticks: number): SimulationState {
  const preset = getPresetById("standing-party");
  const rng = new SeededRandom(seed);
  let state = createInitialState(
    seed,
    preset.params,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    STANDING_PARTY_FORMATION,
  );
  for (let i = 0; i < ticks; i++) {
    state = stepSimulation(
      state,
      preset.params,
      rng,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      STANDING_PARTY_FORMATION,
    );
  }
  return state;
}

function entriesOfType(log: LogEntry[], eventType: SimulationEventType): LogEntry[] {
  return log.filter((entry) => entry.eventType === eventType);
}

describe("standingParty: 動的循環の統合確認 (Issue #178)", () => {
  const finalState = runStandingParty(DYNAMIC_CYCLE_SEED, DYNAMIC_CYCLE_TICKS);

  it("cluster作成・会話成立・参加・離脱・再探索・再参加・縮小/解散のすべてが構造化イベントとして記録される", () => {
    const REQUIRED_EVENT_TYPES: SimulationEventType[] = [
      "nucleusCreated",
      "groupConfirmed",
      "agentJoined",
      "clusterDepartureStarted",
      "clusterDepartureCompleted",
      "clusterResearchStarted",
      "clusterRejoined",
    ];
    for (const eventType of REQUIRED_EVENT_TYPES) {
      expect(entriesOfType(finalState.log, eventType).length, `expected at least one "${eventType}" event`).toBeGreaterThan(0);
    }
    // member減少による縮小/解散は、縮小のまま続くか(activeClusterShrunk)実際に解散するか
    // (activeClusterDissolving/activeClusterDissolved、`clusterMemberReleased`を伴う)のいずれかで表れる。
    const shrinkOrDissolveCount =
      entriesOfType(finalState.log, "activeClusterShrunk").length +
      entriesOfType(finalState.log, "activeClusterDissolving").length +
      entriesOfType(finalState.log, "activeClusterDissolved").length;
    expect(shrinkOrDissolveCount).toBeGreaterThan(0);
  });

  it("特定のagentについて、参加した輪からの離脱->再探索->別の輪への再参加->元の輪の縮小/解散、という一連の流れを追跡できる", () => {
    // 「別clusterへの再参加」: previousClusterId(離脱元)とgroupId(再参加先)が異なるclusterRejoined。
    const rejoinToDifferentCluster = entriesOfType(finalState.log, "clusterRejoined").find(
      (entry) => entry.metadata?.groupId !== undefined && entry.metadata.groupId !== entry.metadata?.previousClusterId,
    );
    expect(rejoinToDifferentCluster).toBeDefined();

    const agentId = rejoinToDifferentCluster!.metadata!.agentId!;
    const originClusterId = rejoinToDifferentCluster!.metadata!.previousClusterId!;
    const destinationClusterId = rejoinToDifferentCluster!.metadata!.groupId!;
    const rejoinTick = rejoinToDifferentCluster!.tick;

    // 参加(離脱前): このagentがoriginClusterIdへ加わった記録。
    // 通常はagentJoined/observerJoinedForming/observerJoinedConfirmedだが、このagentがそもそもの
    // 核形成者(founder)だった場合はnucleusCreatedに、別clusterから既に一度離脱・再参加していた
    // 場合はclusterRejoinedに記録される(いずれも責務9/10がoriginClusterIdへの所属開始点として扱う)。
    const joinEntry = finalState.log.find(
      (entry) =>
        (entry.eventType === "agentJoined" ||
          entry.eventType === "observerJoinedForming" ||
          entry.eventType === "observerJoinedConfirmed" ||
          entry.eventType === "nucleusCreated" ||
          entry.eventType === "clusterRejoined") &&
        entry.metadata?.agentId === agentId &&
        entry.metadata?.groupId === originClusterId &&
        entry.tick < rejoinTick,
    );
    expect(joinEntry, "expected a prior join event into the origin cluster").toBeDefined();

    // 離脱開始・離脱完了: このagentがoriginClusterIdを離脱した
    const departureStarted = finalState.log.find(
      (entry) =>
        entry.eventType === "clusterDepartureStarted" &&
        entry.metadata?.agentId === agentId &&
        entry.metadata?.groupId === originClusterId,
    );
    const departureCompleted = finalState.log.find(
      (entry) =>
        entry.eventType === "clusterDepartureCompleted" &&
        entry.metadata?.agentId === agentId &&
        entry.metadata?.groupId === originClusterId,
    );
    expect(departureStarted).toBeDefined();
    expect(departureCompleted).toBeDefined();
    expect(departureStarted!.tick).toBeLessThanOrEqual(rejoinTick);
    expect(departureCompleted!.tick).toBeLessThanOrEqual(rejoinTick);
    expect(joinEntry!.tick).toBeLessThanOrEqual(departureStarted!.tick);

    // 再探索開始: 離脱と同じtickで、同じagent・同じ離脱元clusterIdを対象に記録される
    const researchStarted = finalState.log.find(
      (entry) =>
        entry.eventType === "clusterResearchStarted" &&
        entry.metadata?.agentId === agentId &&
        entry.metadata?.groupId === originClusterId,
    );
    expect(researchStarted).toBeDefined();
    expect(researchStarted!.tick).toBe(departureCompleted!.tick);
    expect(researchStarted!.tick).toBeLessThanOrEqual(rejoinTick);

    // 再参加先(destinationClusterId)は離脱元(originClusterId)とは別のクラスタである
    expect(destinationClusterId).not.toBe(originClusterId);

    // member減少によるcluster縮小/解散: 離脱元(originClusterId)が離脱tick以降に
    // activeClusterShrunk/activeClusterDissolving/activeClusterDissolvedのいずれかを記録している
    const originClusterLifecycleEvent = finalState.log.find(
      (entry) =>
        (entry.eventType === "activeClusterShrunk" ||
          entry.eventType === "activeClusterDissolving" ||
          entry.eventType === "activeClusterDissolved") &&
        entry.metadata?.groupId === originClusterId &&
        entry.tick >= departureCompleted!.tick,
    );
    expect(originClusterLifecycleEvent, "expected the origin cluster to shrink or dissolve after the departure").toBeDefined();
  });

  it("既存シナリオ(二次会・学校)にはclusterDeparture/groupLifecycle由来のイベントが混入しない", () => {
    const afterPartyPreset = getPresetById("natural");
    const rng = new SeededRandom(DYNAMIC_CYCLE_SEED);
    let state = createInitialState(DYNAMIC_CYCLE_SEED, afterPartyPreset.params);
    for (let i = 0; i < 150; i++) {
      state = stepSimulation(state, afterPartyPreset.params, rng);
    }
    const clusterOnlyEventTypes: SimulationEventType[] = [
      "clusterDepartureStarted",
      "clusterDepartureCompleted",
      "clusterResearchStarted",
      "clusterRejoined",
      "clusterMemberReleased",
      "activeClusterShrunk",
      "activeClusterDissolving",
      "activeClusterDissolved",
    ];
    for (const eventType of clusterOnlyEventTypes) {
      expect(entriesOfType(state.log, eventType)).toHaveLength(0);
    }
  });
});
