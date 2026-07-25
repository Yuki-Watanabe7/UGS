import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { getPresetById } from "./presets";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import { getFormationPolicyById, type FormationRuntimeOptions } from "./formationPolicy";

/**
 * Issue #190 4節: 長時間実行(1,000tick)・複数seed・複数プリセットでも、standingParty特有の
 * 状態(会話満足度・会話エピソード・cluster membership)にNaN/Infinity・孤児episode・
 * 重複membership・解散済みclusterの残留メンバーが発生しないことを検証する。
 *
 * `standingPartyClusterLifecycle.test.ts`(責務10のconfirmed維持、300tick×3seed)とは別に、
 * こちらはより長いhorizon(1,000tick、issue本文が明示する値)で会話満足度モデル(#187)固有の
 * 数値健全性も同時にチェックする。
 */

const PRESET_IDS = ["standing-party", "standing-party-networking", "standing-party-intimate"] as const;
const SEEDS = [1, 2, 3];
const TICKS = 1000;

function formationOptionsFor(presetId: string): FormationRuntimeOptions {
  const preset = getPresetById(presetId);
  return {
    scenarioId: "standingParty",
    standingPartyConfig: preset.formationStandingPartyConfig ?? DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  };
}

describe("standingParty: 1000tickの長時間実行でのグローバル不変条件 (Issue #190 4節)", () => {
  it.each(PRESET_IDS)("プリセット「%s」で複数seedにわたりNaN/Infinity・孤児episode・重複membershipが発生しない", (presetId) => {
    const preset = getPresetById(presetId);
    const formation = formationOptionsFor(presetId);
    // 「forming」状態のcandidateは、唯一のmemberが責務9で離脱した直後は一時的に0人になり得るが
    // (agent.state === "joined"はforming候補への合流も含むため)、無期限に残留はせず
    // `evaluateUnconfirmedCandidateLifecycle`のage判定でdissolving/expiredへ必ず遷移する
    // (`formationPolicy.defaultMaxAge`が上限)。「空clusterの無期限残留がない」はこの上限で確認する。
    const formationPolicy = getFormationPolicyById("standingParty");
    const maxEmptyFormingAge = formationPolicy.defaultMaxAge;

    for (const seed of SEEDS) {
      const rng = new SeededRandom(seed);
      let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);

      for (let i = 0; i < TICKS; i++) {
        state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
        const ctx = `preset=${presetId} seed=${seed} tick=${state.tick}`;

        const membershipCounts = new Map<string, number>();
        for (const candidate of state.groupCandidates) {
          // 空clusterの残留: 一度成立(confirmed)したclusterは0人のままconfirmedに残らない
          // (責務10が下回った時点でdissolving/dissolvedへ即座に遷移させる、既存挙動)
          if (candidate.status === "confirmed") {
            expect(candidate.memberIds.length, `${ctx} candidate=${candidate.id}が0人のままconfirmedに残留している`).toBeGreaterThan(0);
          }
          // forming候補が0人のまま無期限に残らない(age上限で必ずdissolving/expiredへ遷移する)
          if (candidate.status === "forming" && candidate.memberIds.length === 0) {
            expect(
              candidate.age,
              `${ctx} candidate=${candidate.id}が0人のままformingに無期限残留している(age上限超過)`,
            ).toBeLessThanOrEqual(maxEmptyFormingAge);
          }
          if (candidate.status === "forming" || candidate.status === "confirmed") {
            for (const memberId of candidate.memberIds) {
              membershipCounts.set(memberId, (membershipCounts.get(memberId) ?? 0) + 1);
            }
          }
          // memberIds自体の重複がない
          expect(new Set(candidate.memberIds).size, `${ctx} candidate=${candidate.id}のmemberIdsに重複がある`).toBe(
            candidate.memberIds.length,
          );
        }
        // 1agentは同時に最大1clusterへ所属する(重複membershipがない)
        for (const count of membershipCounts.values()) {
          expect(count, `${ctx}: 1人のagentが複数candidateへ同時所属している`).toBe(1);
        }

        for (const agent of state.agents) {
          expect(Number.isFinite(agent.x), `${ctx} agent=${agent.id}のxがNaN/Infinity`).toBe(true);
          expect(Number.isFinite(agent.y), `${ctx} agent=${agent.id}のyがNaN/Infinity`).toBe(true);
          expect(Number.isFinite(agent.stress), `${ctx} agent=${agent.id}のstressがNaN/Infinity`).toBe(true);
          if (agent.socialCirculationTendency !== undefined) {
            expect(
              Number.isFinite(agent.socialCirculationTendency),
              `${ctx} agent=${agent.id}のsocialCirculationTendencyがNaN/Infinity`,
            ).toBe(true);
          }

          // 孤児episode: currentEpisodeを持つのはjoinedかつ有効なclusterに所属するagentだけ
          if (agent.currentEpisode !== undefined) {
            expect(agent.state, `${ctx} agent=${agent.id}がcurrentEpisodeを持つのにjoinedでない`).toBe("joined");
            expect(
              agent.currentEpisode.clusterId,
              `${ctx} agent=${agent.id}のepisode.clusterIdがjoinedGroupIdと不一致`,
            ).toBe(agent.joinedGroupId);
            const owner = state.groupCandidates.find((c) => c.id === agent.currentEpisode!.clusterId);
            expect(owner, `${ctx} agent=${agent.id}のepisodeが指すclusterが存在しない`).toBeDefined();
            expect(
              owner!.status,
              `${ctx} agent=${agent.id}のepisodeがdissolving/dissolved/expiredなclusterを参照している`,
            ).not.toMatch(/^(dissolving|dissolved|expired)$/);

            expect(
              Number.isFinite(agent.currentEpisode.conversationSatisfaction ?? 0),
              `${ctx} agent=${agent.id}のconversationSatisfactionがNaN/Infinity`,
            ).toBe(true);
            if (agent.currentEpisode.conversationSatisfaction !== undefined) {
              expect(agent.currentEpisode.conversationSatisfaction).toBeGreaterThanOrEqual(0);
              expect(agent.currentEpisode.conversationSatisfaction).toBeLessThanOrEqual(1);
            }
            expect(
              agent.currentEpisode.joinedAtTick,
              `${ctx} agent=${agent.id}のjoinedAtTickが未来のtickを指している`,
            ).toBeLessThanOrEqual(state.tick);
            expect(agent.currentEpisode.lastUpdatedTick).toBeLessThanOrEqual(state.tick);
          } else {
            // joinedでcurrentEpisode未設定は起きない(engine.tsが合流と同時に必ず初期化する)
            expect(agent.state === "joined", `${ctx} agent=${agent.id}がjoinedなのにcurrentEpisodeを持たない`).toBe(false);
          }
        }
      }
    }
  }, 30000);
});
