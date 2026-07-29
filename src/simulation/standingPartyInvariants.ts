import { expect } from "vitest";
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
