import { expect } from "vitest";
import type {
  ContactIntervalRecord,
  ContactNetworkEdge,
  StandingPartyContactNetwork,
  StandingPartyConversationHistory,
  StandingPartyRunStatistics,
  SimulationState,
} from "./types";

/**
 * Issue #218 (standing-party Phase 4 統合検証): 会話履歴・接触ネットワーク・統計の
 * read model向け不変条件を1箇所へ集約する。
 *
 * `standingPartyInvariants.ts`(Issue #203)はengine runtime state向け。こちらは
 * `buildStandingPartyConversationHistory` / `buildStandingPartyContactNetwork` /
 * `buildStandingPartyRunStatistics` が返す観測専用成果物向け。ロングランや決定的
 * fixtureから毎tick(または再構築ごと)呼び出すことを想定する。
 */

export type StandingPartyAnalysisInvariantContext = {
  /** エラーメッセージに含める文脈(preset/seed/tick等) */
  label: string;
  /** live stateとの整合を見る場合に渡す(省略可) */
  state?: SimulationState;
};

function dwellForInterval(startedAtTick: number, endedAtTick: number | undefined, asOfTick: number): number {
  const end = endedAtTick ?? asOfTick;
  return Math.max(0, end - startedAtTick);
}

function assertFiniteNonNegative(value: number, label: string, field: string): void {
  expect(Number.isFinite(value), `${label}: ${field}がNaN/Infinity`).toBe(true);
  expect(value, `${label}: ${field}が負`).toBeGreaterThanOrEqual(0);
}

function assertNoSelfEdge(edge: ContactNetworkEdge | ContactIntervalRecord, label: string): void {
  if ("edgeKey" in edge) {
    expect(edge.agentIdA, `${label}: self-edge ${edge.edgeKey}`).not.toBe(edge.agentIdB);
    expect(edge.agentIdA < edge.agentIdB, `${label}: edgeKey正規化違反 ${edge.edgeKey}`).toBe(true);
  } else {
    expect(edge.agentIdA, `${label}: self-contact ${edge.contactIntervalId}`).not.toBe(edge.agentIdB);
    expect(edge.agentIdA < edge.agentIdB, `${label}: contact pair正規化違反 ${edge.contactIntervalId}`).toBe(true);
  }
}

/**
 * 履歴read modelの構造不変条件(1agentあたりactive episode最大1、dwell規約、
 * membership 1:1、重複IDなし、負durationなし)。
 */
export function assertConversationHistoryInvariants(
  history: StandingPartyConversationHistory,
  ctx: StandingPartyAnalysisInvariantContext,
): void {
  const { label, state } = ctx;
  const asOfTick = history.asOfTick;

  const episodeIds = new Set<string>();
  const activeByAgent = new Map<string, string>();

  for (const ep of history.episodes) {
    expect(episodeIds.has(ep.episodeId), `${label}: episodeId重複 ${ep.episodeId}`).toBe(false);
    episodeIds.add(ep.episodeId);

    assertFiniteNonNegative(ep.startedAtTick, label, `episode ${ep.episodeId} startedAtTick`);
    assertFiniteNonNegative(ep.dwellTicks, label, `episode ${ep.episodeId} dwellTicks`);
    expect(ep.dwellTicks, `${label}: episode ${ep.episodeId} dwell規約不一致`).toBe(
      dwellForInterval(ep.startedAtTick, ep.endedAtTick, asOfTick),
    );

    if (ep.endedAtTick !== undefined) {
      expect(ep.endedAtTick, `${label}: episode ${ep.episodeId} ended < started`).toBeGreaterThanOrEqual(
        ep.startedAtTick,
      );
      expect(ep.status, `${label}: 終了済みepisodeがactive/censored`).toBe("completed");
    } else {
      expect(["active", "censored"], `${label}: 未終了episodeのstatus不正`).toContain(ep.status);
      expect(
        activeByAgent.has(ep.agentId),
        `${label}: agent=${ep.agentId}にactive episodeが複数(${activeByAgent.get(ep.agentId)}, ${ep.episodeId})`,
      ).toBe(false);
      activeByAgent.set(ep.agentId, ep.episodeId);
    }
  }

  // membershipはepisodeと1:1(同じepisodeIdをintervalIdとして共有)
  expect(history.membershipIntervals.length, `${label}: membership件数≠episode件数`).toBe(
    history.episodes.length,
  );
  for (const interval of history.membershipIntervals) {
    expect(episodeIds.has(interval.intervalId), `${label}: orphan membership ${interval.intervalId}`).toBe(
      true,
    );
    const ep = history.episodes.find((e) => e.episodeId === interval.intervalId)!;
    expect(interval.agentId).toBe(ep.agentId);
    expect(interval.clusterId).toBe(ep.clusterId);
    expect(interval.startedAtTick).toBe(ep.startedAtTick);
    expect(interval.endedAtTick).toBe(ep.endedAtTick);
    expect(interval.status).toBe(ep.status);
  }

  const lifetimeIds = new Set<string>();
  for (const life of history.clusterLifetimes) {
    expect(lifetimeIds.has(life.clusterId), `${label}: clusterLifetime重複 ${life.clusterId}`).toBe(false);
    lifetimeIds.add(life.clusterId);
    assertFiniteNonNegative(life.createdAtTick, label, `lifetime ${life.clusterId} createdAtTick`);
    if (life.endedAtTick !== undefined) {
      expect(life.endedAtTick, `${label}: lifetime ${life.clusterId} ended < created`).toBeGreaterThanOrEqual(
        life.createdAtTick,
      );
    }
    assertFiniteNonNegative(life.peakMemberCount, label, `lifetime ${life.clusterId} peak`);
    assertFiniteNonNegative(life.joinCount, label, `lifetime ${life.clusterId} joinCount`);
    assertFiniteNonNegative(life.voluntaryLeaveCount, label, `lifetime ${life.clusterId} voluntary`);
    assertFiniteNonNegative(life.forcedReleaseCount, label, `lifetime ${life.clusterId} forced`);
  }

  const transitionIds = new Set<string>();
  for (const tr of history.transitions) {
    expect(transitionIds.has(tr.transitionId), `${label}: transitionId重複 ${tr.transitionId}`).toBe(false);
    transitionIds.add(tr.transitionId);
    assertFiniteNonNegative(tr.startedAtTick, label, `transition ${tr.transitionId} started`);
    if (tr.endedAtTick !== undefined) {
      expect(tr.endedAtTick, `${label}: transition ${tr.transitionId} ended < started`).toBeGreaterThanOrEqual(
        tr.startedAtTick,
      );
    }
  }

  // live membershipとactive episodeの整合(stateが渡された場合)
  if (state) {
    for (const agent of state.agents) {
      const activeId = activeByAgent.get(agent.id);
      if (agent.state === "joined" && agent.joinedGroupId && agent.currentEpisode) {
        expect(activeId, `${label}: joined agent=${agent.id}にactive episodeが無い`).toBe(
          agent.currentEpisode.episodeId,
        );
      }
      if (activeId !== undefined && agent.state === "joined") {
        expect(agent.joinedGroupId, `${label}: active episodeとjoinedGroupId不一致`).toBeDefined();
      }
    }
  }
}

/**
 * contact networkの構造不変条件(正規化・self-edge禁止・edge集約和=interval和)。
 */
export function assertContactNetworkInvariants(
  network: StandingPartyContactNetwork,
  ctx: StandingPartyAnalysisInvariantContext,
): void {
  const { label } = ctx;
  const intervalIds = new Set<string>();
  const edgeIntervalSums = new Map<string, number>();
  const edgeIntervalCounts = new Map<string, number>();

  for (const interval of network.contactIntervals) {
    expect(intervalIds.has(interval.contactIntervalId), `${label}: contactIntervalId重複`).toBe(false);
    intervalIds.add(interval.contactIntervalId);
    assertNoSelfEdge(interval, label);
    assertFiniteNonNegative(interval.dwellTicks, label, `contact ${interval.contactIntervalId} dwell`);
    expect(interval.dwellTicks, `${label}: contact dwell規約不一致 ${interval.contactIntervalId}`).toBe(
      dwellForInterval(interval.startedAtTick, interval.endedAtTick, network.asOfTick),
    );

    const key = `${interval.agentIdA}:${interval.agentIdB}`;
    edgeIntervalSums.set(key, (edgeIntervalSums.get(key) ?? 0) + interval.dwellTicks);
    edgeIntervalCounts.set(key, (edgeIntervalCounts.get(key) ?? 0) + 1);
  }

  const edgeKeys = new Set<string>();
  for (const edge of network.edges) {
    expect(edgeKeys.has(edge.edgeKey), `${label}: edgeKey重複 ${edge.edgeKey}`).toBe(false);
    edgeKeys.add(edge.edgeKey);
    assertNoSelfEdge(edge, label);
    expect(edge.edgeKey).toBe(`${edge.agentIdA}:${edge.agentIdB}`);
    assertFiniteNonNegative(edge.totalCoPresenceTicks, label, `edge ${edge.edgeKey} ticks`);
    assertFiniteNonNegative(edge.contactIntervalCount, label, `edge ${edge.edgeKey} count`);

    const sum = edgeIntervalSums.get(edge.edgeKey) ?? 0;
    const count = edgeIntervalCounts.get(edge.edgeKey) ?? 0;
    expect(edge.totalCoPresenceTicks, `${label}: edge ${edge.edgeKey} 集約ticks≠interval和`).toBe(sum);
    expect(edge.contactIntervalCount, `${label}: edge ${edge.edgeKey} count≠interval件数`).toBe(count);
  }

  // intervalがあるのにedgeが無い・逆は禁止
  for (const key of edgeIntervalSums.keys()) {
    expect(edgeKeys.has(key), `${label}: intervalがあるのにedge欠落 ${key}`).toBe(true);
  }

  for (const node of network.nodes) {
    assertFiniteNonNegative(node.degree, label, `node ${node.agentId} degree`);
    assertFiniteNonNegative(node.weightedDegree, label, `node ${node.agentId} weightedDegree`);
  }

  assertFiniteNonNegative(network.metrics.density, label, "density");
  assertFiniteNonNegative(network.metrics.edgeCount, label, "edgeCount");
  assertFiniteNonNegative(network.metrics.nodeCount, label, "nodeCount");
  expect(network.metrics.edgeCount).toBe(network.edges.length);
}

/**
 * 統計の健全性(NaNなし・完了分布にactiveを混ぜない件数整合・分母0明示)。
 */
export function assertStatisticsInvariants(
  statistics: StandingPartyRunStatistics,
  history: StandingPartyConversationHistory,
  network: StandingPartyContactNetwork,
  ctx: StandingPartyAnalysisInvariantContext,
): void {
  const { label } = ctx;
  const run = statistics.run;

  expect(run.asOfTick).toBe(statistics.asOfTick);
  assertFiniteNonNegative(run.completedEpisodeCount, label, "completedEpisodeCount");
  assertFiniteNonNegative(run.activeEpisodeCount, label, "activeEpisodeCount");
  assertFiniteNonNegative(run.voluntaryDepartureCount, label, "voluntaryDepartureCount");
  assertFiniteNonNegative(run.forcedReleaseCount, label, "forcedReleaseCount");

  // activeを完了分布へ混ぜない: completed countは完了episode件数以下(filterあり得る)
  expect(run.completedEpisodeCount, `${label}: completedEpisodeCountが過大`).toBeLessThanOrEqual(
    history.episodes.filter((e) => e.status === "completed").length,
  );

  // empty分布はNaNを返さない
  for (const dist of [
    run.completedEpisodeDwellTicks,
    run.agentDistinctContactCounts,
    run.pairContactDurationTicks,
    run.completedClusterLifetimeTicks,
    run.completedClusterPeakSizes,
  ]) {
    expect(Number.isNaN(dist.count), `${label}: distribution.countがNaN`).toBe(false);
    if (dist.count === 0) {
      expect(dist.mean, `${label}: emptyなのにmeanがある`).toBeUndefined();
      expect(dist.median, `${label}: emptyなのにmedianがある`).toBeUndefined();
      expect(dist.sum, `${label}: emptyなのにsumがある`).toBeUndefined();
    } else {
      expect(Number.isFinite(dist.mean!), `${label}: meanが非有限`).toBe(true);
      expect(Number.isFinite(dist.median!), `${label}: medianが非有限`).toBe(true);
    }
  }

  // 成功率の分母0はrate undefined
  if (run.targetedTransitionSuccessRate.denominator === 0) {
    expect(run.targetedTransitionSuccessRate.rate).toBeUndefined();
  } else if (run.targetedTransitionSuccessRate.rate !== undefined) {
    expect(Number.isFinite(run.targetedTransitionSuccessRate.rate)).toBe(true);
  }

  // network metricsは渡したsnapshotと一致
  expect(run.network.edgeCount).toBe(network.metrics.edgeCount);
  expect(run.network.nodeCount).toBe(network.metrics.nodeCount);
}

/**
 * history / network / statisticsを横断した不変条件。
 */
export function assertStandingPartyAnalysisInvariants(
  history: StandingPartyConversationHistory,
  network: StandingPartyContactNetwork,
  statistics: StandingPartyRunStatistics,
  ctx: StandingPartyAnalysisInvariantContext,
): void {
  assertConversationHistoryInvariants(history, ctx);
  assertContactNetworkInvariants(network, ctx);
  assertStatisticsInvariants(statistics, history, network, ctx);
}
