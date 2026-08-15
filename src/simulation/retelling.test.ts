import { describe, expect, it } from "vitest";
import {
  deriveRetellingOutcome,
  evaluateRetellingDecision,
  getClusterVariantTellCount,
  withClusterVariantTellIncrement,
  type RetellingContext,
  type RetellingDecisionInput,
  type RetellingRuntimeState,
} from "./retelling";
import { createRootVariant } from "./informationModel";
import type { ClaimCatalog, InformationClaim } from "./informationModel";
import { DEFAULT_INFORMATION_PROPAGATION_LIMITS, DEFAULT_RETELLING_CONFIG } from "./informationState";
import type { AgentClaimState, AgentInformationProfile, InformationPropagationLimits, RetellingConfig, SourceTrace } from "./informationState";

/**
 * Issue #232 (Phase 5): retelling decision(`evaluateRetellingDecision`、pure)とそのdrawを含む
 * 実行境界(`deriveRetellingOutcome`)を検証する。mutation規則自体は`claimVariant.test.ts`が扱う。
 */

const CLAIM: InformationClaim = {
  id: "claim:hobby",
  topicId: "topic:hobby",
  rootVariantId: "claim:hobby:root",
  contentKey: "claim.hobby",
  canonicalMeaning: { subjectKey: "participant", predicateKey: "recommends", objectValue: "hiking-spot", qualifiers: {} },
  originalSource: { id: "source:participant-1", kind: "participant", agentId: "participant-1" },
  verifiability: "opinion",
  verificationStatus: "notApplicable",
  initialConfidence: 0.5,
};
const ROOT = createRootVariant(CLAIM);
const CATALOG: ClaimCatalog = { id: "test-claims", claims: [CLAIM], variants: [ROOT] };
const LIMITS: InformationPropagationLimits = DEFAULT_INFORMATION_PROPAGATION_LIMITS;

function sourceTrace(overrides: Partial<SourceTrace> = {}): SourceTrace {
  return {
    id: "source-heard-1",
    kind: "heardUtterance",
    originalSourceId: "source:participant-1",
    immediateSpeakerId: "agent-2",
    utteranceId: "content-1",
    receptionId: "info-reception-1",
    variantId: ROOT.id,
    firstEncounteredTick: 1,
    lastEncounteredTick: 1,
    encounterCount: 1,
    ...overrides,
  };
}

function claimState(overrides: Partial<AgentClaimState> = {}): AgentClaimState {
  return {
    claimId: CLAIM.id,
    awareness: "understood",
    acceptance: "adopted",
    confidence: 0.6,
    memoryStrength: 0.6,
    firstEncounteredTick: 1,
    lastEncounteredTick: 1,
    firstHeardTick: 1,
    lastHeardTick: 1,
    heardCount: 1,
    understoodCount: 1,
    adoptionCount: 1,
    activeVariantId: ROOT.id,
    encounteredVariantIds: [ROOT.id],
    sourceTraces: [sourceTrace()],
    retellingCount: 0,
    lastRetoldTick: undefined,
    retellableFromTick: 2,
    lastMemoryEvaluationTick: 1,
    forgetAtTick: undefined,
    ...overrides,
  };
}

function profile(overrides: Partial<AgentInformationProfile> = {}): AgentInformationProfile {
  return { retellingTendency: 0.5, memoryRetention: 0.5, baselineTopicInterest: { [CLAIM.topicId]: 0.5 }, ...overrides };
}

function config(overrides: Partial<RetellingConfig> = {}): RetellingConfig {
  return { ...DEFAULT_RETELLING_CONFIG, ...overrides };
}

function decisionInput(overrides: Partial<RetellingDecisionInput> = {}): RetellingDecisionInput {
  return {
    tick: 10,
    speakerId: "agent-1",
    claim: CLAIM,
    claimState: claimState(),
    profile: profile(),
    parentVariant: ROOT,
    clusterCurrentTopicId: undefined,
    limits: LIMITS,
    config: config({ mutationEnabled: true }),
    sameClusterTellCount: 0,
    ...overrides,
  };
}

describe("evaluateRetellingDecision", () => {
  it("is ineligible with primaryReason mutationDisabled when config.mutationEnabled is false", () => {
    const decision = evaluateRetellingDecision(decisionInput({ config: config({ mutationEnabled: false }) }));
    expect(decision.eligible).toBe(false);
    expect(decision.selectedPolicy).toBe("faithful");
    expect(decision.probability).toBe(0);
    expect(decision.primaryReason).toBe("mutationDisabled");
  });

  it("is ineligible with primaryReason cooldownActive when the cooldown has not elapsed", () => {
    const decision = evaluateRetellingDecision(
      decisionInput({
        tick: 10,
        claimState: claimState({ lastRetoldTick: 9 }),
        config: config({ mutationEnabled: true, retellingCooldownTicks: 5 }),
      }),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.primaryReason).toBe("cooldownActive");
  });

  it("is eligible once the cooldown has fully elapsed", () => {
    const decision = evaluateRetellingDecision(
      decisionInput({
        tick: 10,
        claimState: claimState({ lastRetoldTick: 5 }),
        config: config({ mutationEnabled: true, retellingCooldownTicks: 5 }),
      }),
    );
    expect(decision.eligible).toBe(true);
  });

  it("is ineligible with primaryReason sameClusterRepeatLimit once the cluster repeat cap is hit", () => {
    const decision = evaluateRetellingDecision(
      decisionInput({ config: config({ mutationEnabled: true, sameClusterVariantRepeatLimit: 3 }), sameClusterTellCount: 3 }),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.primaryReason).toBe("sameClusterRepeatLimit");
  });

  it("increases probability as memory strength decreases (monotonicity)", () => {
    const strong = evaluateRetellingDecision(decisionInput({ claimState: claimState({ memoryStrength: 0.9 }) }));
    const weak = evaluateRetellingDecision(decisionInput({ claimState: claimState({ memoryStrength: 0.1 }) }));
    expect(weak.probability).toBeGreaterThan(strong.probability);
  });

  it("increases probability as confidence decreases (monotonicity)", () => {
    const confident = evaluateRetellingDecision(decisionInput({ claimState: claimState({ confidence: 0.9 }) }));
    const unsure = evaluateRetellingDecision(decisionInput({ claimState: claimState({ confidence: 0.1 }) }));
    expect(unsure.probability).toBeGreaterThan(confident.probability);
  });

  it("increases probability with higher retellingTendency (monotonicity)", () => {
    const low = evaluateRetellingDecision(decisionInput({ profile: profile({ retellingTendency: 0.1 }) }));
    const high = evaluateRetellingDecision(decisionInput({ profile: profile({ retellingTendency: 0.9 }) }));
    expect(high.probability).toBeGreaterThan(low.probability);
  });

  it("clamps probability to [0, 1] and reports all 7 documented factor keys", () => {
    const decision = evaluateRetellingDecision(
      decisionInput({
        config: config({ mutationEnabled: true, baseMutationProbability: 1 }),
        claimState: claimState({ memoryStrength: 0, confidence: 0 }),
      }),
    );
    expect(decision.probability).toBeLessThanOrEqual(1);
    expect(decision.probability).toBeGreaterThanOrEqual(0);
    expect(decision.factors.map((f) => f.key).sort()).toEqual(
      ["memoryStrength", "confidence", "topicInterest", "retellingTendency", "recency", "sourceDistance", "clusterTopicAffinity"].sort(),
    );
  });

  it("is deterministic: same input always yields the same decision", () => {
    const a = evaluateRetellingDecision(decisionInput());
    const b = evaluateRetellingDecision(decisionInput());
    expect(a).toEqual(b);
  });
});

function outcomeContext(overrides: Partial<RetellingContext> = {}): RetellingContext {
  return {
    tick: 10,
    clusterId: "group-1",
    speakerId: "agent-1",
    claim: CLAIM,
    parentVariant: ROOT,
    claimState: claimState(),
    profile: profile(),
    clusterCurrentTopicId: undefined,
    catalog: CATALOG,
    limits: LIMITS,
    config: config({ mutationEnabled: true }),
    retellingRuntime: {},
    runSeed: 1,
    ...overrides,
  };
}

describe("deriveRetellingOutcome", () => {
  it("is always faithful (no draw) when mutation is disabled, but still records a RetellingEvent", () => {
    const outcome = deriveRetellingOutcome(outcomeContext({ config: config({ mutationEnabled: false }) }));
    expect(outcome.suppressed).toBe(false);
    expect(outcome.variantId).toBe(ROOT.id);
    expect(outcome.generatedVariant).toBeUndefined();
    expect(outcome.event.result).toBe("faithful");
    expect(outcome.event.draw).toBeUndefined();
    expect(outcome.event.outputVariantId).toBe(ROOT.id);
  });

  it("produces a mutated variant with lineage/provenance when forced to mutate", () => {
    const outcome = deriveRetellingOutcome(
      outcomeContext({
        config: config({ mutationEnabled: true, baseMutationProbability: 1, factorWeights: { ...DEFAULT_RETELLING_CONFIG.factorWeights, actorGeneralization: 1 } }),
      }),
    );
    expect(outcome.suppressed).toBe(false);
    expect(["mutated", "variantReused"]).toContain(outcome.event.result);
    expect(outcome.event.mutationFactors.length).toBeGreaterThan(0);
    expect(outcome.event.inputVariantId).toBe(ROOT.id);
    expect(outcome.event.outputVariantId).toBe(outcome.variantId);
    if (outcome.event.result === "mutated") {
      expect(outcome.generatedVariant?.parentVariantId).toBe(ROOT.id);
      expect(outcome.generatedVariant?.generatorAgentId).toBe("agent-1");
    }
  });

  it("reuses an existing variant (dedup) when an earlier mutation already produced the same meaning", () => {
    const forcedConfig = config({
      mutationEnabled: true,
      baseMutationProbability: 1,
      factorWeights: { detailOmission: 0, certaintyShift: 0, magnitudeShift: 0, actorGeneralization: 1, sourceBlur: 0, emphasisShift: 0 },
    });
    const first = deriveRetellingOutcome(outcomeContext({ speakerId: "agent-1", config: forcedConfig }));
    expect(first.generatedVariant).toBeDefined();

    const catalogWithVariant: ClaimCatalog = { ...CATALOG, variants: [...CATALOG.variants, first.generatedVariant!] };
    const second = deriveRetellingOutcome(
      outcomeContext({ speakerId: "agent-2", catalog: catalogWithVariant, config: forcedConfig }),
    );
    expect(second.event.result).toBe("variantReused");
    expect(second.variantId).toBe(first.variantId);
    expect(second.generatedVariant).toBeUndefined();
  });

  it("suppresses the utterance (blockedByLimit) once the semantic distance ceiling is exceeded", () => {
    const outcome = deriveRetellingOutcome(
      outcomeContext({
        config: config({ mutationEnabled: true, baseMutationProbability: 1, semanticDistanceCeiling: 0 }),
      }),
    );
    expect(outcome.suppressed).toBe(true);
    expect(outcome.event.result).toBe("blockedByLimit");
    expect(outcome.event.contentUtteranceId).toBeUndefined();
    expect(outcome.event.outputVariantId).toBeUndefined();
    expect(outcome.event.blockedReason).toBe("distanceCeiling");
  });

  it("is deterministic across repeated calls with the same seed and inputs", () => {
    const ctx = outcomeContext({ config: config({ mutationEnabled: true, baseMutationProbability: 0.5 }) });
    const a = deriveRetellingOutcome(ctx);
    const b = deriveRetellingOutcome(ctx);
    expect(a).toEqual(b);
  });

  it("carries the speaker's sourceTraceIds/sourceReceptionIds through to the event", () => {
    const trace = sourceTrace({ id: "source-heard-42", receptionId: "info-reception-42" });
    const outcome = deriveRetellingOutcome(
      outcomeContext({ claimState: claimState({ sourceTraces: [trace] }), config: config({ mutationEnabled: false }) }),
    );
    expect(outcome.event.sourceTraceIds).toEqual(["source-heard-42"]);
    expect(outcome.event.sourceReceptionIds).toEqual(["info-reception-42"]);
  });
});

describe("RetellingRuntimeState", () => {
  it("defaults unseen cluster/variant pairs to a tell count of 0", () => {
    expect(getClusterVariantTellCount({}, "group-1", "claim:x:root")).toBe(0);
  });

  it("increments a specific cluster+variant pair without mutating the input or affecting other pairs", () => {
    const empty: RetellingRuntimeState = {};
    const once = withClusterVariantTellIncrement(empty, "group-1", "claim:x:root");
    expect(empty).toEqual({});
    expect(getClusterVariantTellCount(once, "group-1", "claim:x:root")).toBe(1);
    expect(getClusterVariantTellCount(once, "group-1", "claim:x:other")).toBe(0);
    expect(getClusterVariantTellCount(once, "group-2", "claim:x:root")).toBe(0);

    const twice = withClusterVariantTellIncrement(once, "group-1", "claim:x:root");
    expect(getClusterVariantTellCount(twice, "group-1", "claim:x:root")).toBe(2);
    expect(getClusterVariantTellCount(once, "group-1", "claim:x:root")).toBe(1); // 元のstateは不変
  });
});
