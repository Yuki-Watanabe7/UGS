import { describe, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { getPresetById } from "./presets";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import { getFormationPolicyById, type FormationRuntimeOptions } from "./formationPolicy";
import { assertStandingPartyInvariants } from "./standingPartyInvariants";

/**
 * Issue #190 4節: 長時間実行(1,000tick)・複数seed・複数プリセットでも、standingParty特有の
 * 状態(会話満足度・会話エピソード・cluster membership)にNaN/Infinity・孤児episode・
 * 重複membership・解散済みclusterの残留メンバーが発生しないことを検証する。
 *
 * `standingPartyClusterLifecycle.test.ts`(責務10のconfirmed維持、300tick×3seed)とは別に、
 * こちらはより長いhorizon(1,000tick、issue本文が明示する値)で会話満足度モデル(#187)固有の
 * 数値健全性も同時にチェックする。
 *
 * チェック本体は`standingPartyInvariants.ts`の`assertStandingPartyInvariants`へ集約されており
 * (Issue #203)、Phase 3有効プリセット向けの`standingPartyPhase3LongRunStability.test.ts`と
 * 同じ不変条件を共有する。
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
        assertStandingPartyInvariants(state, {
          maxEmptyFormingAge,
          label: `preset=${presetId} seed=${seed} tick=${state.tick}`,
        });
      }
    }
  }, 30000);
});
