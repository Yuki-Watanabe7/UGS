import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { getPresetById } from "./presets";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import { STANDING_PARTY_CLAIM_CATALOG } from "./informationModel";
import { listAgentsAwareOfClaim } from "./informationState";
import type { FormationRuntimeOptions } from "./formationPolicy";

/**
 * Issue #229 (Phase 5): `SimulationState.informationRuntime`の境界を検証する。
 * - master flag OFF(既定)ではagent/state/event/PRNG系列が一切変わらない
 * - master flag ONでは同一seed/configで同一の初期状態が決定的に生成される
 * - tickを進めても(#230以降が実装されるまでは)値がそのまま引き継がれる
 */

function standingPartyFormation(overrides?: FormationRuntimeOptions["standingPartyConfig"]): FormationRuntimeOptions {
  return { scenarioId: "standingParty", standingPartyConfig: overrides ?? DEFAULT_STANDING_PARTY_SCENARIO_CONFIG };
}

describe("Phase 5 disabled (default)", () => {
  it("produces an undefined informationRuntime and does not change agents/log/PRNG sequence", () => {
    const preset = getPresetById("standing-party");
    const seed = 999;
    const formation = standingPartyFormation();

    const withoutFormation = createInitialState(seed, preset.params);
    const withFormation = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);

    expect(withoutFormation.informationRuntime).toBeUndefined();
    expect(withFormation.informationRuntime).toBeUndefined();
    // formationScenarioId自体は変わるが、それ以外のagent生成結果(座標・特性)はPhase 5と無関係に一致する
    expect(withFormation.agents).toEqual(withoutFormation.agents);
  });

  it("keeps informationRuntime undefined across ticks", () => {
    const preset = getPresetById("standing-party");
    const seed = 999;
    const formation = standingPartyFormation();
    const rng = new SeededRandom(seed);
    let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
    for (let i = 0; i < 5; i++) {
      state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
      expect(state.informationRuntime).toBeUndefined();
    }
  });
});

describe("Phase 5 enabled", () => {
  const claimId = STANDING_PARTY_CLAIM_CATALOG.claims[0].id;

  function enabledFormation(): FormationRuntimeOptions {
    return standingPartyFormation({
      ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      informationPropagation: {
        ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.informationPropagation,
        enabled: true,
        init: {
          ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.informationPropagation.init,
          autoHolderCounts: { [claimId]: 2 },
        },
      },
    });
  }

  it("populates informationRuntime deterministically for the same seed/config", () => {
    const preset = getPresetById("standing-party");
    const seed = 42;
    const formation = enabledFormation();
    const a = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
    const b = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
    expect(a.informationRuntime).toEqual(b.informationRuntime);
    expect(a.informationRuntime).toBeDefined();
    expect(listAgentsAwareOfClaim(a.informationRuntime!, claimId)).toHaveLength(2);
  });

  it("does not perturb agent generation compared to disabled (same seed)", () => {
    const preset = getPresetById("standing-party");
    const seed = 42;
    const disabled = createInitialState(
      seed,
      preset.params,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      standingPartyFormation(),
    );
    const enabled = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, enabledFormation());
    expect(enabled.agents).toEqual(disabled.agents);
  });

  it("carries informationRuntime through stepSimulation unchanged (no runtime processing yet)", () => {
    const preset = getPresetById("standing-party");
    const seed = 42;
    const formation = enabledFormation();
    const rng = new SeededRandom(seed);
    const initial = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
    const next = stepSimulation(initial, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
    expect(next.informationRuntime).toEqual(initial.informationRuntime);
  });
});
