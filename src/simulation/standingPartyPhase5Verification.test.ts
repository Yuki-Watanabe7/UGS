/**
 * Issue #235 (standing-party Phase 5 統合検証): #229〜#234の個別契約を、実際の
 * engine run・分析・exportまで横断して確認する。
 *
 * 数式やmutation規則そのものは各モジュールの単体テストに委ねる。このファイルでは、ID鎖、
 * bounded state、再現性、analysis/export非介入、pause/resumeというPhase 5全体の境界を固定する。
 */
import { describe, expect, it } from "vitest";
import {
  buildStandingPartyAnalysisCsvFiles,
  buildStandingPartyAnalysisExport,
  serializeStandingPartyAnalysisExport,
} from "./analysisExport";
import { mergeGeneratedVariants } from "./claimVariant";
import { createInitialState, stepSimulation } from "./engine";
import {
  assertInformationAnalysisDoesNotMutateState,
  buildInformationPropagationAnalysis,
} from "./informationAnalysis";
import { validateClaimCatalog } from "./informationModel";
import { getFormationPolicyById, type FormationRuntimeOptions } from "./formationPolicy";
import { getPresetById } from "./presets";
import { SeededRandom } from "./random";
import { assertStandingPartyInvariants } from "./standingPartyInvariants";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import type { InformationPropagationConfig } from "./informationState";
import type { SimulationState } from "./types";

// 通常の伝播とmutationの両方を覆う2 preset × 2 seed。各runは要求どおり1,000tickまで進める。
const PHASE5_PRESET_IDS = ["standing-party-info-rich", "standing-party-rumor-mutation"] as const;
const SEEDS = [7, 29] as const;
const LONG_TICKS = 1_000;

function formationOptionsFor(presetId: (typeof PHASE5_PRESET_IDS)[number]): FormationRuntimeOptions {
  const preset = getPresetById(presetId);
  return {
    scenarioId: "standingParty",
    standingPartyConfig: preset.formationStandingPartyConfig ?? DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  };
}

function runTicks(
  presetId: (typeof PHASE5_PRESET_IDS)[number],
  seed: number,
  ticks: number,
): { state: SimulationState; config: InformationPropagationConfig; rng: SeededRandom } {
  const preset = getPresetById(presetId);
  const formation = formationOptionsFor(presetId);
  const config = formation.standingPartyConfig!.informationPropagation;
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);

  for (let i = 0; i < ticks; i++) {
    state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
  }
  return { state, config, rng };
}

function expectUnit(value: number, label: string): void {
  expect(Number.isFinite(value), `${label} must be finite`).toBe(true);
  expect(value, `${label} must be >= 0`).toBeGreaterThanOrEqual(0);
  expect(value, `${label} must be <= 1`).toBeLessThanOrEqual(1);
}

/**
 * runtime eventを表示文言に依存せず照合する。各event型の詳細な生成規則は個別テストで
 * 検証済みなので、ここではengineを通して参照が孤児化しないことに集中する。
 */
function assertPhase5Invariants(state: SimulationState, config: InformationPropagationConfig, label: string): void {
  expect(config.enabled, `${label}: Phase 5 preset must enable the feature`).toBe(true);
  expect(state.informationRuntime, `${label}: enabled run must have information runtime`).toBeDefined();

  const catalog = mergeGeneratedVariants(config.claimCatalog, state.generatedClaimVariants ?? []);
  validateClaimCatalog(catalog, config.topicCatalog);
  const claims = new Map(catalog.claims.map((claim) => [claim.id, claim]));
  const variants = new Map(catalog.variants.map((variant) => [variant.id, variant]));
  const utterances = new Map((state.contentUtteranceLog ?? []).map((event) => [event.id, event]));
  const speechEvents = new Map((state.speechLog ?? []).map((event) => [event.id, event]));
  const speechReceptions = new Map((state.speechReceptionLog ?? []).map((event) => [event.id, event]));
  const receptions = new Map((state.informationReceptionLog ?? []).map((event) => [event.id, event]));
  const adoptions = new Map((state.informationAdoptionLog ?? []).map((event) => [event.id, event]));
  const memoryUpdates = state.informationMemoryUpdateLog ?? [];
  const retellings = state.retellingLog ?? [];

  for (const [name, values] of [
    ["content utterance", state.contentUtteranceLog ?? []],
    ["information reception", state.informationReceptionLog ?? []],
    ["information adoption", state.informationAdoptionLog ?? []],
    ["memory update", memoryUpdates],
    ["retelling", retellings],
  ] as const) {
    expect(new Set(values.map((event) => event.id)).size, `${label}: duplicate ${name} ID`).toBe(values.length);
  }

  for (const utterance of utterances.values()) {
    const claim = claims.get(utterance.claimId);
    const variant = variants.get(utterance.variantId);
    expect(claim, `${label}: utterance ${utterance.id} has an unknown claim`).toBeDefined();
    expect(variant, `${label}: utterance ${utterance.id} has an unknown variant`).toBeDefined();
    expect(utterance.topicId).toBe(claim!.topicId);
    expect(variant!.canonicalClaimId).toBe(utterance.claimId);
    expect(speechEvents.get(utterance.speechEventId), `${label}: content carrier speech is missing`).toBeDefined();
  }

  for (const reception of receptions.values()) {
    const utterance = utterances.get(reception.contentUtteranceId);
    expect(utterance, `${label}: reception ${reception.id} has an unknown utterance`).toBeDefined();
    expect(speechReceptions.get(reception.speechReceptionEventId), `${label}: reception ${reception.id} has an unknown speech reception`).toBeDefined();
    expect(reception.tick).toBe(utterance!.tick);
    expect(reception.claimId).toBe(utterance!.claimId);
    expect(reception.variantId).toBe(utterance!.variantId);
  }

  const adoptionKeys = new Set<string>();
  for (const adoption of adoptions.values()) {
    const key = `${adoption.tick}:${adoption.receiverId}:${adoption.claimId}`;
    expect(adoptionKeys.has(key), `${label}: adoption is double-applied for ${key}`).toBe(false);
    adoptionKeys.add(key);
    expect(adoption.receptionEventIds.length, `${label}: adoption must have a reception`).toBeGreaterThan(0);
    for (const receptionId of adoption.receptionEventIds) {
      const reception = receptions.get(receptionId);
      expect(reception, `${label}: adoption ${adoption.id} references an unknown reception`).toBeDefined();
      expect(reception!.heard, `${label}: not-heard reception cannot update adoption`).toBe(true);
      expect(reception!.comprehension, `${label}: not-understood reception cannot update adoption`).toBe("understood");
      expect(reception!.receiverId).toBe(adoption.receiverId);
      expect(reception!.claimId).toBe(adoption.claimId);
      expect(reception!.tick).toBe(adoption.tick);
    }
  }

  for (const update of memoryUpdates) {
    if (update.adoptionEventId !== undefined) {
      const adoption = adoptions.get(update.adoptionEventId);
      expect(adoption, `${label}: memory update ${update.id} has an unknown adoption`).toBeDefined();
      expect(adoption!.receiverId).toBe(update.receiverId);
      expect(adoption!.claimId).toBe(update.claimId);
    }
    for (const receptionId of update.receptionEventIds) {
      const reception = receptions.get(receptionId);
      expect(reception, `${label}: memory update ${update.id} has an unknown reception`).toBeDefined();
      expect(reception!.receiverId).toBe(update.receiverId);
      expect(reception!.claimId).toBe(update.claimId);
    }
    expectUnit(update.nextMemoryStrength, `${label}: memory update ${update.id}`);
  }

  for (const event of retellings) {
    expect(claims.get(event.claimId), `${label}: retelling ${event.id} has an unknown claim`).toBeDefined();
    expect(variants.get(event.inputVariantId), `${label}: retelling ${event.id} has an unknown input variant`).toBeDefined();
    if (event.outputVariantId === undefined) {
      expect(event.result, `${label}: only a blocked retelling may omit an output variant`).toBe("blockedByLimit");
    } else {
      expect(variants.get(event.outputVariantId), `${label}: retelling ${event.id} has an unknown output variant`).toBeDefined();
    }
    if (event.contentUtteranceId !== undefined) {
      expect(utterances.get(event.contentUtteranceId), `${label}: retelling ${event.id} has an unknown utterance`).toBeDefined();
    }
    for (const receptionId of event.sourceReceptionIds) {
      expect(receptions.get(receptionId), `${label}: retelling ${event.id} has an unknown source reception`).toBeDefined();
    }
  }

  for (const [agentId, runtime] of Object.entries(state.informationRuntime!)) {
    expect(runtime.agentId, `${label}: runtime key and agent ID differ`).toBe(agentId);
    expectUnit(runtime.profile.retellingTendency, `${label}: ${agentId}.retellingTendency`);
    expectUnit(runtime.profile.memoryRetention, `${label}: ${agentId}.memoryRetention`);
    for (const topic of Object.values(runtime.topics)) {
      expectUnit(topic.interest, `${label}: ${agentId}/${topic.topicId}.interest`);
      expectUnit(topic.fatigue, `${label}: ${agentId}/${topic.topicId}.fatigue`);
    }
    for (const claimState of Object.values(runtime.claims)) {
      expect(claims.get(claimState.claimId), `${label}: ${agentId} has an unknown claim state`).toBeDefined();
      expectUnit(claimState.confidence, `${label}: ${agentId}/${claimState.claimId}.confidence`);
      expectUnit(claimState.memoryStrength, `${label}: ${agentId}/${claimState.claimId}.memoryStrength`);
      expect(claimState.sourceTraces.length, `${label}: source trace cap is exceeded`).toBeLessThanOrEqual(config.limits.maxSourceTracesPerAgentClaim);
      if (claimState.firstHeardTick !== undefined && claimState.lastHeardTick !== undefined) {
        expect(claimState.firstHeardTick, `${label}: firstHeardTick must not exceed lastHeardTick`).toBeLessThanOrEqual(claimState.lastHeardTick);
      }
      if (claimState.activeVariantId !== undefined) {
        expect(variants.get(claimState.activeVariantId), `${label}: active variant must resolve`).toBeDefined();
      }
      for (const trace of claimState.sourceTraces) {
        expect(variants.get(trace.variantId), `${label}: source trace variant must resolve`).toBeDefined();
        expect(trace.firstEncounteredTick).toBeLessThanOrEqual(trace.lastEncounteredTick);
        if (trace.kind === "heardUtterance") {
          expect(trace.utteranceId, `${label}: heard source trace needs an utterance`).toBeDefined();
          expect(trace.receptionId, `${label}: heard source trace needs a reception`).toBeDefined();
          expect(utterances.get(trace.utteranceId!), `${label}: source trace utterance must resolve`).toBeDefined();
          expect(receptions.get(trace.receptionId!), `${label}: source trace reception must resolve`).toBeDefined();
        }
      }
    }
  }
}

describe("Issue #235: Phase 5 end-to-end verification", () => {
  it("同一seed/configでは、runtime・ID鎖・lineage・analysis/exportが再現される", () => {
    const first = runTicks("standing-party-rumor-mutation", 235, 240);
    const second = runTicks("standing-party-rumor-mutation", 235, 240);

    expect(first.state).toEqual(second.state);
    expect(first.rng.next()).toBe(second.rng.next());
    expect(first.state.contentUtteranceLog!.length, "fixture must exercise content utterances").toBeGreaterThan(0);
    expect(first.state.informationReceptionLog!.length, "fixture must exercise receptions").toBeGreaterThan(0);
    expect(first.state.informationAdoptionLog!.length, "fixture must exercise adoptions").toBeGreaterThan(0);
    expect(first.state.retellingLog!.length, "fixture must exercise retelling").toBeGreaterThan(0);

    assertPhase5Invariants(first.state, first.config, "deterministic fixture");

    const analysis = buildInformationPropagationAnalysis(first.state, { config: first.config });
    const bundle = buildStandingPartyAnalysisExport(first.state, {
      presetId: "standing-party-rumor-mutation",
      standingPartyConfig: formationOptionsFor("standing-party-rumor-mutation").standingPartyConfig,
    });
    expect(bundle.informationPropagation.transmissions).toEqual(analysis.transmissions);
    expect(bundle.informationPropagation.lineage).toEqual(analysis.lineage);
    expect(bundle.informationPropagation.statistics).toEqual(analysis.statistics);
    expect(serializeStandingPartyAnalysisExport(bundle)).toBe(
      serializeStandingPartyAnalysisExport(
        buildStandingPartyAnalysisExport(first.state, {
          presetId: "standing-party-rumor-mutation",
          standingPartyConfig: formationOptionsFor("standing-party-rumor-mutation").standingPartyConfig,
        }),
      ),
    );
  });

  it("1000tick・複数seed・Phase 5 presetで上限・lineage・event参照が壊れない", () => {
    const policy = getFormationPolicyById("standingParty");
    for (const presetId of PHASE5_PRESET_IDS) {
      for (const seed of SEEDS) {
        const preset = getPresetById(presetId);
        const formation = formationOptionsFor(presetId);
        const config = formation.standingPartyConfig!.informationPropagation;
        const rng = new SeededRandom(seed);
        let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);

        for (let i = 0; i < LONG_TICKS; i++) {
          state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
          assertStandingPartyInvariants(state, {
            maxEmptyFormingAge: policy.defaultMaxAge,
            label: `phase5 preset=${presetId} seed=${seed} tick=${state.tick}`,
          });
          if (state.tick % 100 === 0 || i === LONG_TICKS - 1) {
            assertPhase5Invariants(state, config, `phase5 preset=${presetId} seed=${seed} tick=${state.tick}`);
          }
        }
      }
    }
  }, 120_000);

  it("analysis/filter/exportを毎tick実行しても、状態・event・main PRNGとpause/resume結果を変えない", () => {
    const presetId = "standing-party-info-rich" as const;
    const preset = getPresetById(presetId);
    const formation = formationOptionsFor(presetId);
    const config = formation.standingPartyConfig!.informationPropagation;
    const seed = 235;
    const totalTicks = 100;

    function run(withAnalysis: boolean, pauseAt?: number): { state: SimulationState; rngProbe: number } {
      const rng = new SeededRandom(seed);
      let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
      for (let i = 0; i < totalTicks; i++) {
        state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
        if (withAnalysis) {
          assertInformationAnalysisDoesNotMutateState(state, () => {
            const analysis = buildInformationPropagationAnalysis(state, {
              config,
              filter: { fromTick: 0, toTick: state.tick, observerJoinerMode: "all" },
            });
            const bundle = buildStandingPartyAnalysisExport(state, {
              standingPartyConfig: formation.standingPartyConfig,
            });
            buildStandingPartyAnalysisCsvFiles(bundle);
            return analysis;
          });
        }
        if (i + 1 === pauseAt) {
          // UI pauseはstate/rngを変えずに次のtickを待つだけなので、意図的に何もしない。
        }
      }
      return { state, rngProbe: rng.next() };
    }

    const baseline = run(false);
    const analyzed = run(true);
    const pausedAndAnalyzed = run(true, totalTicks / 2);
    expect(analyzed).toEqual(baseline);
    expect(pausedAndAnalyzed).toEqual(baseline);
  });
});
