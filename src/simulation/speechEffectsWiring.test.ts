import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { PRESETS } from "./presets";
import type { SimParams, SimulationState } from "./types";

/**
 * Phase 3(#93)のengine.ts結線を検証する。個々の導出関数の単体テストは`speechEffects.test.ts`が担い、
 * ここでは「デフォルトでは既存挙動に一切影響しない」「有効化すると各tickでログが明示的に積み上がる」
 * という結線そのものの契約を確認する。
 */

function runToCompletion(
  seed: number,
  params: SimParams,
  speechEffectsEnabled?: boolean,
): SimulationState {
  const rng = new SeededRandom(seed);
  let state = createInitialState(
    seed,
    params,
    undefined,
    speechEffectsEnabled === undefined ? undefined : { enabled: speechEffectsEnabled },
  );
  let ticks = 0;
  while (!state.finished && ticks < 400) {
    state = stepSimulation(state, params, rng);
    ticks += 1;
  }
  return state;
}

describe("Phase 3 speech effects wiring: default (unspecified) config", () => {
  it("createInitialState defaults speechEffectsEnabled to false and all Phase 3 logs to empty arrays", () => {
    const state = createInitialState(1, PRESETS[0].params);
    expect(state.speechEffectsEnabled).toBe(false);
    expect(state.speechReceptionLog).toEqual([]);
    expect(state.speechInterpretationLog).toEqual([]);
    expect(state.speechEffectLog).toEqual([]);
  });

  it("Phase 3 logs stay empty across an entire run when never enabled, for every preset", () => {
    for (const preset of PRESETS) {
      const finalState = runToCompletion(2024, preset.params);
      expect(finalState.speechReceptionLog).toEqual([]);
      expect(finalState.speechInterpretationLog).toEqual([]);
      expect(finalState.speechEffectLog).toEqual([]);
    }
  });

  it("this issue alone does not change existing agents/groupCandidates/log/speechLog/rng sequence", () => {
    const preset = PRESETS[0];
    const seed = 42;

    const withoutPhase3 = runToCompletion(seed, preset.params, undefined);
    const withPhase3ExplicitlyDisabled = runToCompletion(seed, preset.params, false);

    expect(withPhase3ExplicitlyDisabled.agents).toEqual(withoutPhase3.agents);
    expect(withPhase3ExplicitlyDisabled.groupCandidates).toEqual(withoutPhase3.groupCandidates);
    expect(withPhase3ExplicitlyDisabled.log).toEqual(withoutPhase3.log);
    expect(withPhase3ExplicitlyDisabled.speechLog).toEqual(withoutPhase3.speechLog);
  });

  it("enabling Phase 3 effects does not alter agents/groupCandidates/log/speechLog/rng consumption either", () => {
    const preset = PRESETS[0];
    const seed = 42;

    const disabled = runToCompletion(seed, preset.params, false);
    const enabled = runToCompletion(seed, preset.params, true);

    expect(enabled.agents).toEqual(disabled.agents);
    expect(enabled.groupCandidates).toEqual(disabled.groupCandidates);
    expect(enabled.log).toEqual(disabled.log);
    expect(enabled.speechLog).toEqual(disabled.speechLog);
  });
});

describe("Phase 3 speech effects wiring: enabled config", () => {
  it("accumulates reception/interpretation/effect logs across ticks once a SpeechEvent has been generated", () => {
    const preset = PRESETS[0];
    const finalState = runToCompletion(2024, preset.params, true);

    expect(finalState.speechEffectsEnabled).toBe(true);
    expect((finalState.speechLog ?? []).length).toBeGreaterThan(0);
    expect((finalState.speechReceptionLog ?? []).length).toBeGreaterThan(0);
    expect((finalState.speechInterpretationLog ?? []).length).toBeGreaterThan(0);
    expect((finalState.speechEffectLog ?? []).length).toBeGreaterThan(0);
  });

  it("every reception/interpretation/effect event traces back to a real SpeechEvent id via speechEventId", () => {
    const preset = PRESETS[0];
    const finalState = runToCompletion(2024, preset.params, true);
    const knownSpeechIds = new Set((finalState.speechLog ?? []).map((s) => s.id));

    for (const reception of finalState.speechReceptionLog ?? []) {
      expect(knownSpeechIds.has(reception.speechEventId)).toBe(true);
    }
    for (const interpretation of finalState.speechInterpretationLog ?? []) {
      expect(knownSpeechIds.has(interpretation.speechEventId)).toBe(true);
    }
    for (const effect of finalState.speechEffectLog ?? []) {
      expect(knownSpeechIds.has(effect.speechEventId)).toBe(true);
    }
  });

  it("stepSimulation falls back to the state's previously-enabled config when the caller omits the argument", () => {
    const preset = PRESETS[0];
    const rng = new SeededRandom(2024);
    let state = createInitialState(2024, preset.params, undefined, { enabled: true });

    // Omit the speechEffects argument entirely on every subsequent tick, mirroring how
    // interventionId already falls back in stepSimulation.
    let ticks = 0;
    while (!state.finished && ticks < 400) {
      state = stepSimulation(state, preset.params, rng);
      ticks += 1;
    }

    expect(state.speechEffectsEnabled).toBe(true);
    expect((state.speechReceptionLog ?? []).length).toBeGreaterThan(0);
  });

  it("reproducibility: identical seed/params produce identical Phase 3 logs", () => {
    const preset = PRESETS[2];
    const first = runToCompletion(777, preset.params, true);
    const second = runToCompletion(777, preset.params, true);

    expect(second.speechReceptionLog).toEqual(first.speechReceptionLog);
    expect(second.speechInterpretationLog).toEqual(first.speechInterpretationLog);
    expect(second.speechEffectLog).toEqual(first.speechEffectLog);
  });

  it("ids are unique within each Phase 3 log across a full run", () => {
    const preset = PRESETS[0];
    const finalState = runToCompletion(2024, preset.params, true);

    for (const log of [
      finalState.speechReceptionLog ?? [],
      finalState.speechInterpretationLog ?? [],
      finalState.speechEffectLog ?? [],
    ]) {
      const ids = log.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
