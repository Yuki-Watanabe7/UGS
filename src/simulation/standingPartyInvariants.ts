import { expect } from "vitest";
import { distance, WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import type { SpatialDynamicsConfig } from "./spatialDynamics";
import type { SimulationState } from "./types";

/**
 * Issue #203 (Phase 3, 検証): standingParty向けのグローバル不変条件を1箇所へ集約する。
 *
 * `standingPartyLongRunStability.test.ts`(Issue #190)がPhase 2までの範囲(membership/episode/
 * 数値健全性)で個別に実装していたチェックを、Phase 3のpendingClusterTransition不変条件と合わせて
 * 再利用可能な関数へ切り出す。1000tick級のロングラン・複数seed・複数presetのテストから毎tick
 * 呼び出すことを想定する(`vitest`の`expect`に依存するため、テストファイルからのみ import する)。
 */
export type StandingPartyInvariantContext = {
  /** `formationPolicy.defaultMaxAge`。空formingクラスタの無期限残留がないことの確認に使う */
  maxEmptyFormingAge: number;
  /** エラーメッセージに含める文脈(preset/seed/tick等) */
  label: string;
};

export function assertStandingPartyInvariants(state: SimulationState, ctx: StandingPartyInvariantContext): void {
  const { maxEmptyFormingAge, label } = ctx;

  const membershipCounts = new Map<string, number>();
  for (const candidate of state.groupCandidates) {
    // 空clusterの残留: 一度成立(confirmed)したclusterは0人のままconfirmedに残らない
    // (責務10が下回った時点でdissolving/dissolvedへ即座に遷移させる、既存挙動)
    if (candidate.status === "confirmed") {
      expect(candidate.memberIds.length, `${label} candidate=${candidate.id}が0人のままconfirmedに残留している`).toBeGreaterThan(0);
    }
    // forming候補が0人のまま無期限に残らない(age上限で必ずdissolving/expiredへ遷移する)
    if (candidate.status === "forming" && candidate.memberIds.length === 0) {
      expect(
        candidate.age,
        `${label} candidate=${candidate.id}が0人のままformingに無期限残留している(age上限超過)`,
      ).toBeLessThanOrEqual(maxEmptyFormingAge);
    }
    if (candidate.status === "forming" || candidate.status === "confirmed") {
      for (const memberId of candidate.memberIds) {
        membershipCounts.set(memberId, (membershipCounts.get(memberId) ?? 0) + 1);
      }
    }
    // memberIds自体の重複がない
    expect(new Set(candidate.memberIds).size, `${label} candidate=${candidate.id}のmemberIdsに重複がある`).toBe(
      candidate.memberIds.length,
    );
  }
  // 1agentは同時に最大1clusterへ所属する(重複membershipがない)
  for (const count of membershipCounts.values()) {
    expect(count, `${label}: 1人のagentが複数candidateへ同時所属している`).toBe(1);
  }

  for (const agent of state.agents) {
    expect(Number.isFinite(agent.x), `${label} agent=${agent.id}のxがNaN/Infinity`).toBe(true);
    expect(Number.isFinite(agent.y), `${label} agent=${agent.id}のyがNaN/Infinity`).toBe(true);
    expect(Number.isFinite(agent.stress), `${label} agent=${agent.id}のstressがNaN/Infinity`).toBe(true);
    if (agent.socialCirculationTendency !== undefined) {
      expect(
        Number.isFinite(agent.socialCirculationTendency),
        `${label} agent=${agent.id}のsocialCirculationTendencyがNaN/Infinity`,
      ).toBe(true);
    }

    // 孤児episode: currentEpisodeを持つのはjoinedかつ有効なclusterに所属するagentだけ
    if (agent.currentEpisode !== undefined) {
      expect(agent.state, `${label} agent=${agent.id}がcurrentEpisodeを持つのにjoinedでない`).toBe("joined");
      expect(
        agent.currentEpisode.clusterId,
        `${label} agent=${agent.id}のepisode.clusterIdがjoinedGroupIdと不一致`,
      ).toBe(agent.joinedGroupId);
      const owner = state.groupCandidates.find((c) => c.id === agent.currentEpisode!.clusterId);
      expect(owner, `${label} agent=${agent.id}のepisodeが指すclusterが存在しない`).toBeDefined();
      expect(
        owner!.status,
        `${label} agent=${agent.id}のepisodeがdissolving/dissolved/expiredなclusterを参照している`,
      ).not.toMatch(/^(dissolving|dissolved|expired)$/);

      expect(
        Number.isFinite(agent.currentEpisode.conversationSatisfaction ?? 0),
        `${label} agent=${agent.id}のconversationSatisfactionがNaN/Infinity`,
      ).toBe(true);
      if (agent.currentEpisode.conversationSatisfaction !== undefined) {
        expect(agent.currentEpisode.conversationSatisfaction).toBeGreaterThanOrEqual(0);
        expect(agent.currentEpisode.conversationSatisfaction).toBeLessThanOrEqual(1);
      }
      expect(
        agent.currentEpisode.joinedAtTick,
        `${label} agent=${agent.id}のjoinedAtTickが未来のtickを指している`,
      ).toBeLessThanOrEqual(state.tick);
      expect(agent.currentEpisode.lastUpdatedTick).toBeLessThanOrEqual(state.tick);

      if (agent.currentEpisode.attachment !== undefined) {
        expect(
          Number.isFinite(agent.currentEpisode.attachment.value),
          `${label} agent=${agent.id}のattachment.valueがNaN/Infinity`,
        ).toBe(true);
        expect(agent.currentEpisode.attachment.value).toBeGreaterThanOrEqual(0);
        expect(agent.currentEpisode.attachment.value).toBeLessThanOrEqual(1);
      }
    } else {
      // joinedでcurrentEpisode未設定は起きない(engine.tsが合流と同時に必ず初期化する)
      expect(agent.state === "joined", `${label} agent=${agent.id}がjoinedなのにcurrentEpisodeを持たない`).toBe(false);
    }

    // Issue #201 (Phase 3, ADR 3.4節): pending transitionの不変条件。
    const pending = agent.pendingClusterTransition;
    if (pending !== undefined) {
      expect(
        agent.state,
        `${label} agent=${agent.id}がpendingClusterTransitionを持ちながらjoinedのままである(source/targetいずれのmemberでもないはず)`,
      ).not.toBe("joined");
      // pending transitionとactive episodeは同時に存在しない(joined以外ではcurrentEpisodeが
      // 既に無いはずだが、念のため独立に固定する)。
      expect(
        agent.currentEpisode,
        `${label} agent=${agent.id}がpendingClusterTransitionとcurrentEpisodeを同時に持っている`,
      ).toBeUndefined();
      expect(
        pending.sourceClusterId,
        `${label} agent=${agent.id}のpendingClusterTransitionでsourceとtargetが同一クラスタになっている`,
      ).not.toBe(pending.targetClusterId);
      expect(
        pending.decidedAtTick,
        `${label} agent=${agent.id}のpendingClusterTransitionが未来のtickで決定されたことになっている`,
      ).toBeLessThanOrEqual(state.tick);
      expect(
        pending.expiresAtTick,
        `${label} agent=${agent.id}のpendingClusterTransitionのexpiresAtTickがdecidedAtTick以下`,
      ).toBeGreaterThan(pending.decidedAtTick);

      // pending transition中はsource/targetいずれのmemberでもない(責務10、#201受入条件)。
      for (const candidate of state.groupCandidates) {
        if (candidate.id === pending.sourceClusterId || candidate.id === pending.targetClusterId) {
          expect(
            candidate.memberIds,
            `${label} agent=${agent.id}がpending transition中にsource/targetクラスタ(${candidate.id})のmemberのままである`,
          ).not.toContain(agent.id);
        }
      }
    }
  }
}

/** agent座標のclamp margin(`roaming.ts`/`spatialDynamics.ts`の`applyAgentRoamingStep`/`applyMemberFollow`と同一) */
const AGENT_WORLD_MARGIN = 5;
/** cluster中心座標のclamp margin(`spatialDynamics.ts`の`moveClusterCenter`と同一、`CLUSTER_CENTER_MARGIN`) */
const CLUSTER_WORLD_MARGIN = 20;

/**
 * Issue #252 (Phase 6 統合検証): Phase 6(`spatialDynamics.ts`/`roaming.ts`/`spatialOccupancy.ts`/
 * `clusterSearchSelection.ts`)固有の座標・movement不変条件を1箇所へ集約する。既存の
 * `assertStandingPartyInvariants`(membership/episode/pendingClusterTransition)と組み合わせて、
 * 1000tick級のロングラン・複数seed・複数presetのテストから毎tick呼び出すことを想定する。
 * `spatialDynamics.enabled === false`のrunでも(呼び出し側が`config`を渡す限り)安全に呼べる ――
 * `state.spatialRuntimeState`が`undefined`ならcluster velocity/roaming関連の検証は自然にスキップされる。
 */
export function assertStandingPartySpatialInvariants(
  state: SimulationState,
  config: SpatialDynamicsConfig,
  label: string,
): void {
  for (const agent of state.agents) {
    expect(Number.isFinite(agent.x), `${label} agent=${agent.id}のxがNaN/Infinity`).toBe(true);
    expect(Number.isFinite(agent.y), `${label} agent=${agent.id}のyがNaN/Infinity`).toBe(true);
    expect(agent.x, `${label} agent=${agent.id}のxがworld境界外`).toBeGreaterThanOrEqual(AGENT_WORLD_MARGIN);
    expect(agent.x, `${label} agent=${agent.id}のxがworld境界外`).toBeLessThanOrEqual(WORLD_WIDTH - AGENT_WORLD_MARGIN);
    expect(agent.y, `${label} agent=${agent.id}のyがworld境界外`).toBeGreaterThanOrEqual(AGENT_WORLD_MARGIN);
    expect(agent.y, `${label} agent=${agent.id}のyがworld境界外`).toBeLessThanOrEqual(WORLD_HEIGHT - AGENT_WORLD_MARGIN);
  }

  const confirmedClusters = state.groupCandidates.filter((c) => c.status === "confirmed");
  const confirmedIds = new Set(confirmedClusters.map((c) => c.id));
  for (const cluster of confirmedClusters) {
    expect(Number.isFinite(cluster.x), `${label} cluster=${cluster.id}のxがNaN/Infinity`).toBe(true);
    expect(Number.isFinite(cluster.y), `${label} cluster=${cluster.id}のyがNaN/Infinity`).toBe(true);
    expect(cluster.x, `${label} cluster=${cluster.id}のxがworld境界外`).toBeGreaterThanOrEqual(CLUSTER_WORLD_MARGIN);
    expect(cluster.x, `${label} cluster=${cluster.id}のxがworld境界外`).toBeLessThanOrEqual(WORLD_WIDTH - CLUSTER_WORLD_MARGIN);
    expect(cluster.y, `${label} cluster=${cluster.id}のyがworld境界外`).toBeGreaterThanOrEqual(CLUSTER_WORLD_MARGIN);
    expect(cluster.y, `${label} cluster=${cluster.id}のyがworld境界外`).toBeLessThanOrEqual(WORLD_HEIGHT - CLUSTER_WORLD_MARGIN);
  }

  const runtime = state.spatialRuntimeState;
  if (runtime) {
    for (const [clusterId, velocity] of Object.entries(runtime.clusterVelocity)) {
      // pruneSpatialRuntimeState(#247)がconfirmedでなくなったclusterのentryを毎tick除去するはず
      // (「left/cleanup済みentityにspatial runtime stateが残らない」)。
      expect(confirmedIds.has(clusterId), `${label}: 消滅したcluster=${clusterId}のclusterVelocityが残留している`).toBe(true);
      const speed = Math.hypot(velocity.vx, velocity.vy);
      expect(Number.isFinite(speed), `${label} cluster=${clusterId}のvelocityがNaN/Infinity`).toBe(true);
      expect(speed, `${label} cluster=${clusterId}のvelocityが上限(maxClusterCenterSpeed)超過`).toBeLessThanOrEqual(
        config.maxClusterCenterSpeed + 1e-6,
      );
    }

    const agentsById = new Map(state.agents.map((a) => [a.id, a] as const));
    for (const [agentId, roamingState] of Object.entries(runtime.roaming)) {
      const agent = agentsById.get(agentId);
      // 「roaming中agentにstale target/joinedGroupIdが残らない」「left/cleanup済みentityに
      // spatial runtime stateが残らない」: `nextRoaming`はengine.tsのstep 6(roaming)時点の
      // undecided集合から構築されるが、責務9(stress蓄積・離脱判定)やその他の終了処理はその後の
      // 別stepで評価されるため、同一tick内でroaming直後に`leaving`/`left`/`unassigned`等の
      // 「場を離れる」側へ遷移したagentのentryは「今tickの戻り値」に限り1tickだけ残る
      // (次tickのrebuildで自然に脱落する、孤児化ではない)。一方`approaching`/`forming`/`joined`
      // (「候補へ合流する」側)は、候補選択がroaming stateを即座に脱落させることを
      // `roamingEngineWiring.test.ts`が既に固定しているため、roaming entryと共存してはならない。
      expect(agent, `${label}: 存在しないagent=${agentId}のroaming entryが残留している`).toBeDefined();
      expect(
        agent!.state === "approaching" || agent!.state === "forming" || agent!.state === "joined",
        `${label} agent=${agentId}: roaming entryが候補合流状態(state=${agent!.state})と共存している`,
      ).toBe(false);
      expect(
        Number.isFinite(roamingState.headingRadians),
        `${label} agent=${agentId}のroaming headingがNaN/Infinity`,
      ).toBe(true);
      expect(
        Number.isFinite(roamingState.expiresAtTick),
        `${label} agent=${agentId}のroaming expiresAtTickがNaN/Infinity`,
      ).toBe(true);
    }
  }

  // 「joinedGroupIdから許容距離を超えて取り残されない」: cluster移動そのものはmembership/episodeを
  // 変えない(#247の責務外)一方、追従(applyMemberFollow)が機能していれば乖離は無限に広がらない。
  // 個々のtickでの追従量を厳密比較するのではなく、明らかな追従破綻(取り残され)だけを検出する
  // 緩やかな上限を使う。
  const strandedDistanceLimit = config.repulsionRadius + config.preferredClusterSeparation + 200;
  for (const agent of state.agents) {
    if (agent.state !== "joined" || agent.joinedGroupId === undefined) continue;
    const cluster = confirmedClusters.find((c) => c.id === agent.joinedGroupId);
    if (!cluster) continue;
    const d = distance(agent.x, agent.y, cluster.x, cluster.y);
    expect(Number.isFinite(d), `${label} agent=${agent.id}のcluster中心までの距離がNaN/Infinity`).toBe(true);
    expect(d, `${label} agent=${agent.id}が所属cluster=${cluster.id}から取り残されている(距離=${d})`).toBeLessThanOrEqual(
      strandedDistanceLimit,
    );
  }
}
