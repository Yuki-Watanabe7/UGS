import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { getPresetById } from "./presets";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import { getFormationPolicyById, type FormationRuntimeOptions } from "./formationPolicy";
import { assertStandingPartyInvariants } from "./standingPartyInvariants";
import { MAX_TIE_CORRECTION, TIE_OBSERVATION_RANGE } from "./relationshipTie";
import type { SimulationState } from "./types";

/**
 * Issue #203 (Phase 3, 検証範囲10節): speech/trust/relationshipTie(Phase 3/4のspeech系機能、
 * `App.tsx`が常時ON)と、standingPartyのclusterTransition(Phase 3、#200/#201)を**同時に**有効化した
 * 統合実行のテスト。既存回帰テストは各機能領域を独立に検証している
 * (`relationshipTie.test.ts`等はafterPartyプリセットのみ、`standingPartyPhase3LongRunStability.test.ts`は
 * speech系機能を一切有効化しない)ため、両者を同時有効化したときのクロス機能相互作用
 * (例: pending transition中のagentのspeech/trust記録が壊れる)はどのテストからも検出できなかった。
 */

const ALL_SPEECH_FEATURES_ON = {
  speechEffects: { enabled: true },
  socialExpression: { enabled: true },
  speechTrust: { enabled: true },
  relationshipTie: { enabled: true },
};

function formationOptionsFor(presetId: string): FormationRuntimeOptions {
  const preset = getPresetById(presetId);
  return {
    scenarioId: "standingParty",
    standingPartyConfig: preset.formationStandingPartyConfig ?? DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  };
}

function runCombined(presetId: string, seed: number, ticks: number): SimulationState {
  const preset = getPresetById(presetId);
  const formation = formationOptionsFor(presetId);
  const rng = new SeededRandom(seed);
  let state = createInitialState(
    seed,
    preset.params,
    undefined,
    ALL_SPEECH_FEATURES_ON.speechEffects,
    ALL_SPEECH_FEATURES_ON.socialExpression,
    ALL_SPEECH_FEATURES_ON.speechTrust,
    ALL_SPEECH_FEATURES_ON.relationshipTie,
    formation,
  );
  for (let i = 0; i < ticks; i++) {
    state = stepSimulation(
      state,
      preset.params,
      rng,
      undefined,
      ALL_SPEECH_FEATURES_ON.speechEffects,
      ALL_SPEECH_FEATURES_ON.socialExpression,
      ALL_SPEECH_FEATURES_ON.speechTrust,
      ALL_SPEECH_FEATURES_ON.relationshipTie,
      formation,
    );
  }
  return state;
}

const PHASE3_PRESET_IDS = ["standing-party-outward-interest", "standing-party-current-circle"] as const;
const SEEDS = [1, 2, 3];
const TICKS = 400;

describe("standingParty Phase 3 × speech/trust/relationshipTie: 同時有効化の統合回帰", () => {
  it.each(PHASE3_PRESET_IDS)(
    "プリセット「%s」でtransition.enabled=trueとspeech系4機能を同時有効化しても不変条件・値域が壊れない",
    (presetId) => {
      const formationPolicy = getFormationPolicyById("standingParty");
      const maxEmptyFormingAge = formationPolicy.defaultMaxAge;
      let sawPendingTransition = false;

      for (const seed of SEEDS) {
        const preset = getPresetById(presetId);
        const formation = formationOptionsFor(presetId);
        const rng = new SeededRandom(seed);
        let state = createInitialState(
          seed,
          preset.params,
          undefined,
          ALL_SPEECH_FEATURES_ON.speechEffects,
          ALL_SPEECH_FEATURES_ON.socialExpression,
          ALL_SPEECH_FEATURES_ON.speechTrust,
          ALL_SPEECH_FEATURES_ON.relationshipTie,
          formation,
        );

        for (let i = 0; i < TICKS; i++) {
          state = stepSimulation(
            state,
            preset.params,
            rng,
            undefined,
            ALL_SPEECH_FEATURES_ON.speechEffects,
            ALL_SPEECH_FEATURES_ON.socialExpression,
            ALL_SPEECH_FEATURES_ON.speechTrust,
            ALL_SPEECH_FEATURES_ON.relationshipTie,
            formation,
          );
          assertStandingPartyInvariants(state, {
            maxEmptyFormingAge,
            label: `preset=${presetId} seed=${seed} tick=${state.tick}`,
          });
          if (state.agents.some((a) => a.pendingClusterTransition !== undefined)) sawPendingTransition = true;
        }

        // relationshipTie/speechTrustが自身の値域契約(`relationshipTie.test.ts`と同じ性質)を
        // transition有効時にも維持することを確認する。
        for (const update of state.relationshipTieUpdateLog ?? []) {
          expect(update.newCorrection).toBeGreaterThanOrEqual(-MAX_TIE_CORRECTION);
          expect(update.newCorrection).toBeLessThanOrEqual(MAX_TIE_CORRECTION);
          expect(update.distance).toBeLessThanOrEqual(TIE_OBSERVATION_RANGE);
          expect(Number.isFinite(update.newCorrection)).toBe(true);
        }
        const speechIds = new Set((state.speechLog ?? []).map((e) => e.id));
        for (const update of state.relationshipTieUpdateLog ?? []) {
          expect(speechIds.has(update.speechEventId)).toBe(true);
        }
      }

      expect(sawPendingTransition, `preset=${presetId}: pendingClusterTransitionが一度も観測されなかった`).toBe(true);
    },
    30000,
  );

  it("同一seed・同一設定(transition + speech系4機能すべてON)なら状態系列・PRNG消費が完全に再現される", () => {
    const presetId = "standing-party-outward-interest";
    const seed = 11;
    const first = runCombined(presetId, seed, 200);
    const second = runCombined(presetId, seed, 200);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
