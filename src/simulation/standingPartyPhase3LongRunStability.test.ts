import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { getPresetById } from "./presets";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import { getFormationPolicyById, type FormationRuntimeOptions } from "./formationPolicy";
import { assertStandingPartyInvariants } from "./standingPartyInvariants";

/**
 * Issue #203 (Phase 3, 検証範囲7節・受入条件): `standingPartyLongRunStability.test.ts`(Issue #190)は
 * Phase 3の`transition.enabled`を有効化したプリセットを一度も通していなかった(#202が追加した
 * `standing-party-outward-interest`/`standing-party-current-circle`は対象外)ため、
 * `pendingClusterTransition`のフィールド(target参照・expiresAtTick等)が1,000tick級の長時間実行で
 * NaN/孤児参照/exclusivity違反を起こさないことを一度も確認していなかった。このファイルはその穴を
 * `assertStandingPartyInvariants`(Issue #201の不変条件を含む)で埋める。
 */

const PHASE3_PRESET_IDS = ["standing-party-outward-interest", "standing-party-current-circle"] as const;
const SEEDS = [1, 2, 3];
const TICKS = 1000;

function formationOptionsFor(presetId: string): FormationRuntimeOptions {
  const preset = getPresetById(presetId);
  return {
    scenarioId: "standingParty",
    standingPartyConfig: preset.formationStandingPartyConfig ?? DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  };
}

describe("standingParty Phase 3: 1000tickの長時間実行でのグローバル不変条件(pendingClusterTransition込み)", () => {
  it.each(PHASE3_PRESET_IDS)(
    "プリセット「%s」(transition.enabled=true)で複数seedにわたりNaN/孤児target参照/exclusivity違反が発生しない",
    (presetId) => {
      const preset = getPresetById(presetId);
      const formation = formationOptionsFor(presetId);
      expect(formation.standingPartyConfig?.transition.enabled, `${presetId}はtransition.enabled=trueのはず`).toBe(true);

      const formationPolicy = getFormationPolicyById("standingParty");
      const maxEmptyFormingAge = formationPolicy.defaultMaxAge;

      for (const seed of SEEDS) {
        const rng = new SeededRandom(seed);
        let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
        let sawPendingTransition = false;

        for (let i = 0; i < TICKS; i++) {
          state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
          assertStandingPartyInvariants(state, {
            maxEmptyFormingAge,
            label: `preset=${presetId} seed=${seed} tick=${state.tick}`,
          });
          if (state.agents.some((a) => a.pendingClusterTransition !== undefined)) {
            sawPendingTransition = true;
          }
        }

        // フィクスチャがPhase 3の分岐を一度も踏まずに終えていないことを確認する(空振り防止)。
        expect(sawPendingTransition, `preset=${presetId} seed=${seed}: pendingClusterTransitionが一度も観測されなかった`).toBe(
          true,
        );
      }
    },
    30000,
  );
});

describe("standingParty Phase 3: pause/resumeを挟んでも同じtick列で再現する", () => {
  it("500tick連続実行した結果と、250tickで一度止めてから同じrng/stateを再開した結果が一致する", () => {
    const presetId = "standing-party-outward-interest";
    const preset = getPresetById(presetId);
    const formation = formationOptionsFor(presetId);
    const seed = 7;
    const HALF = 250;
    const FULL = 500;

    // 連続実行(pauseなし)
    const continuousRng = new SeededRandom(seed);
    let continuousState = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
    for (let i = 0; i < FULL; i++) {
      continuousState = stepSimulation(
        continuousState,
        preset.params,
        continuousRng,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        formation,
      );
    }

    // pause/resume: 250tickまで進めた後、rng/state(参照)をそのまま「再開」に見立てて残り250tickを進める。
    // engine.tsはrngをrefで受け取るのみで内部状態を持たないため、UIのStart→Pause→Startと同じ意味で
    // 同一のSeededRandomインスタンス・直前stateを引き継げば連続実行と一致するはずである(要件7節)。
    const pausedRng = new SeededRandom(seed);
    let pausedState = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
    for (let i = 0; i < HALF; i++) {
      pausedState = stepSimulation(pausedState, preset.params, pausedRng, undefined, undefined, undefined, undefined, undefined, formation);
    }
    // ここで「pause」した体で、同じrng/stateインスタンスを使って残りを再開する。
    for (let i = 0; i < FULL - HALF; i++) {
      pausedState = stepSimulation(pausedState, preset.params, pausedRng, undefined, undefined, undefined, undefined, undefined, formation);
    }

    expect(pausedState.tick).toBe(continuousState.tick);
    expect(pausedState.log.length).toBe(continuousState.log.length);
    expect(pausedState.agents.map((a) => ({ id: a.id, x: a.x, y: a.y, state: a.state, pendingClusterTransition: a.pendingClusterTransition }))).toEqual(
      continuousState.agents.map((a) => ({ id: a.id, x: a.x, y: a.y, state: a.state, pendingClusterTransition: a.pendingClusterTransition })),
    );
    expect(pausedState.groupCandidates).toEqual(continuousState.groupCandidates);
    expect(pausedState.log).toEqual(continuousState.log);
  });
});
