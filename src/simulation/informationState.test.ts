import { describe, expect, it } from "vitest";
import {
  DEFAULT_INFORMATION_PROPAGATION_CONFIG,
  addSourceTrace,
  applyInitialGrant,
  clampUnit,
  createAgentInformationProfile,
  createInitialInformationRuntimeState,
  getAgentClaimState,
  getAgentTopicState,
  listAgentsAwareOfClaim,
  listAgentsInterestedInTopic,
  traverseVariantLineage,
  validateInformationPropagationConfig,
  validateInformationTransmissionConfig,
  withAgentClaimState,
  withAgentTopicState,
  type AgentInformationState,
  type InformationPropagationConfig,
  type SourceTrace,
} from "./informationState";
import { STANDING_PARTY_CLAIM_CATALOG, STANDING_PARTY_TOPIC_CATALOG, createRootVariant } from "./informationModel";
import type { ClaimCatalog, InformationClaim } from "./informationModel";

/**
 * Issue #229 (Phase 5): agentごとのtopic/claim情報状態、初期配置(fixture/seeded auto)、pure helperの
 * 挙動を検証する。発話・受信・採用・記憶更新のruntime実行ロジックは対象外(#230以降)。
 */

describe("DEFAULT_INFORMATION_PROPAGATION_CONFIG", () => {
  it("is valid and disabled by default", () => {
    expect(() => validateInformationPropagationConfig(DEFAULT_INFORMATION_PROPAGATION_CONFIG)).not.toThrow();
    expect(DEFAULT_INFORMATION_PROPAGATION_CONFIG.enabled).toBe(false);
  });
});

describe("validateInformationPropagationConfig", () => {
  const base = DEFAULT_INFORMATION_PROPAGATION_CONFIG;

  it("rejects an explicit grant referencing an unknown claimId", () => {
    const config: InformationPropagationConfig = {
      ...base,
      init: { ...base.init, explicitGrants: [{ agentId: "agent-0", claimId: "ghost", variantId: "v", acceptance: "adopted", confidence: 0.5, memoryStrength: 0.5 }] },
    };
    expect(() => validateInformationPropagationConfig(config)).toThrow();
  });

  it("rejects an out-of-range grant confidence", () => {
    const claimId = STANDING_PARTY_CLAIM_CATALOG.claims[0].id;
    const config: InformationPropagationConfig = {
      ...base,
      init: {
        ...base.init,
        explicitGrants: [{ agentId: "agent-0", claimId, variantId: "v", acceptance: "adopted", confidence: 1.5, memoryStrength: 0.5 }],
      },
    };
    expect(() => validateInformationPropagationConfig(config)).toThrow();
  });

  it("rejects autoHolderCounts referencing an unknown claimId", () => {
    const config: InformationPropagationConfig = {
      ...base,
      init: { ...base.init, autoHolderCounts: { ghost: 1 } },
    };
    expect(() => validateInformationPropagationConfig(config)).toThrow();
  });

  it("rejects a negative autoHolderCounts value", () => {
    const claimId = STANDING_PARTY_CLAIM_CATALOG.claims[0].id;
    const config: InformationPropagationConfig = {
      ...base,
      init: { ...base.init, autoHolderCounts: { [claimId]: -1 } },
    };
    expect(() => validateInformationPropagationConfig(config)).toThrow();
  });

  it("rejects interestDistribution.min > max", () => {
    const config: InformationPropagationConfig = {
      ...base,
      init: { ...base.init, interestDistribution: { min: 0.8, max: 0.2 } },
    };
    expect(() => validateInformationPropagationConfig(config)).toThrow();
  });

  it("rejects a non-positive limits value", () => {
    const config: InformationPropagationConfig = {
      ...base,
      limits: { ...base.limits, maxSourceTracesPerAgentClaim: 0 },
    };
    expect(() => validateInformationPropagationConfig(config)).toThrow();
  });

  it("delegates to catalog validation (rejects an invalid nested topic catalog)", () => {
    const config: InformationPropagationConfig = {
      ...base,
      topicCatalog: { ...base.topicCatalog, topics: [...base.topicCatalog.topics, { ...base.topicCatalog.topics[0], id: base.topicCatalog.topics[0].id }] },
    };
    expect(() => validateInformationPropagationConfig(config)).toThrow();
  });

  it("delegates to transmission validation (rejects relearnFloor <= forgetThreshold)", () => {
    const config: InformationPropagationConfig = {
      ...base,
      transmission: { ...base.transmission, forgetThreshold: 0.5, relearnFloor: 0.5 },
    };
    expect(() => validateInformationPropagationConfig(config)).toThrow();
  });
});

describe("validateInformationTransmissionConfig", () => {
  const base = DEFAULT_INFORMATION_PROPAGATION_CONFIG.transmission;

  it("accepts the default config", () => {
    expect(() => validateInformationTransmissionConfig(base)).not.toThrow();
  });

  it("rejects an out-of-range comprehensionThreshold", () => {
    expect(() => validateInformationTransmissionConfig({ ...base, comprehensionThreshold: 1.5 })).toThrow();
  });

  it("rejects a non-finite weight", () => {
    expect(() => validateInformationTransmissionConfig({ ...base, trustWeight: Number.NaN })).toThrow();
  });

  it("rejects a negative sourceRepetitionWeight", () => {
    expect(() => validateInformationTransmissionConfig({ ...base, sourceRepetitionWeight: -0.1 })).toThrow();
  });

  it("rejects a non-integer sourceDiversitySaturationCount", () => {
    expect(() => validateInformationTransmissionConfig({ ...base, sourceDiversitySaturationCount: 1.5 })).toThrow();
  });

  it("rejects a non-positive confidenceUpdateScale", () => {
    expect(() => validateInformationTransmissionConfig({ ...base, confidenceUpdateScale: 0 })).toThrow();
  });

  it("rejects relearnFloor <= forgetThreshold", () => {
    expect(() => validateInformationTransmissionConfig({ ...base, forgetThreshold: 0.3, relearnFloor: 0.3 })).toThrow();
  });
});

describe("clampUnit", () => {
  it("clamps to [0,1] and treats NaN/Infinity as 0", () => {
    expect(clampUnit(-1)).toBe(0);
    expect(clampUnit(2)).toBe(1);
    expect(clampUnit(0.5)).toBe(0.5);
    expect(clampUnit(Number.NaN)).toBe(0);
    expect(clampUnit(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("addSourceTrace", () => {
  function trace(overrides: Partial<SourceTrace> = {}): SourceTrace {
    return {
      id: "t1",
      kind: "heardUtterance",
      originalSourceId: "source:organizer",
      immediateSpeakerId: "agent-1",
      utteranceId: "u1",
      receptionId: "r1",
      variantId: "v-root",
      firstEncounteredTick: 1,
      lastEncounteredTick: 1,
      encounterCount: 1,
      ...overrides,
    };
  }

  it("appends a new trace when source differs", () => {
    const result = addSourceTrace([trace()], trace({ id: "t2", immediateSpeakerId: "agent-2" }), 8);
    expect(result).toHaveLength(2);
  });

  it("folds a repeated identical source instead of duplicating it", () => {
    const existing = [trace()];
    const incoming = trace({ id: "t2", lastEncounteredTick: 5, encounterCount: 1 });
    const result = addSourceTrace(existing, incoming, 8);
    expect(result).toHaveLength(1);
    expect(result[0].encounterCount).toBe(2);
    expect(result[0].lastEncounteredTick).toBe(5);
  });

  it("keeps initialGrant traces over cap and drops the oldest heardUtterance trace", () => {
    const initialGrant = trace({ id: "grant", kind: "initialGrant", immediateSpeakerId: undefined, firstEncounteredTick: 0, lastEncounteredTick: 0 });
    const older = trace({ id: "old", immediateSpeakerId: "agent-old", lastEncounteredTick: 1 });
    const newer = trace({ id: "new", immediateSpeakerId: "agent-new", lastEncounteredTick: 9 });
    const result = addSourceTrace([initialGrant, older], newer, 2);
    expect(result).toHaveLength(2);
    expect(result.some((t) => t.id === "grant")).toBe(true);
    expect(result.some((t) => t.id === "new")).toBe(true);
    expect(result.some((t) => t.id === "old")).toBe(false);
  });
});

describe("traverseVariantLineage", () => {
  function makeCatalogWithChain(): { catalog: ClaimCatalog; claim: InformationClaim } {
    const claim: InformationClaim = {
      id: "claim:x",
      topicId: "topic:x",
      rootVariantId: "claim:x:root",
      contentKey: "claim.x",
      canonicalMeaning: { subjectKey: "s", predicateKey: "p", objectValue: "v0", qualifiers: {} },
      originalSource: { id: "source:organizer", kind: "organizer" },
      verifiability: "verifiable",
      verificationStatus: "unknown",
      initialConfidence: 0.5,
    };
    const root = createRootVariant(claim);
    const child = { ...root, id: "claim:x:child", parentVariantId: root.id, lineageDepth: 1 };
    const grandchild = { ...root, id: "claim:x:grandchild", parentVariantId: child.id, lineageDepth: 2 };
    return { catalog: { id: "cat", claims: [claim], variants: [root, child, grandchild] }, claim };
  }

  it("returns the chain from root to the requested variant", () => {
    const { catalog } = makeCatalogWithChain();
    const chain = traverseVariantLineage(catalog, "claim:x:grandchild");
    expect(chain.map((v) => v.id)).toEqual(["claim:x:root", "claim:x:child", "claim:x:grandchild"]);
  });

  it("throws for an unknown variantId", () => {
    const { catalog } = makeCatalogWithChain();
    expect(() => traverseVariantLineage(catalog, "ghost")).toThrow();
  });
});

describe("withAgentTopicState / withAgentClaimState", () => {
  it("updates immutably without mutating the input runtime", () => {
    const seed = 42;
    const runtime = createInitialInformationRuntimeState(
      [{ id: "agent-0" }],
      seed,
      { ...DEFAULT_INFORMATION_PROPAGATION_CONFIG, enabled: true },
    );
    const topicId = STANDING_PARTY_TOPIC_CATALOG.topics[0].id;
    const updated = withAgentTopicState(runtime, "agent-0", { topicId, interest: 0.9, fatigue: 0.1, lastDiscussedTick: 3 });
    expect(getAgentTopicState(runtime, "agent-0", topicId)?.interest).not.toBe(0.9);
    expect(getAgentTopicState(updated, "agent-0", topicId)?.interest).toBe(0.9);
  });

  it("throws when updating an unknown agentId", () => {
    expect(() => withAgentClaimState({}, "ghost", {} as never)).toThrow();
  });
});

describe("createAgentInformationProfile", () => {
  it("is deterministic for the same seed/agentId and independent of call order", () => {
    const a = createAgentInformationProfile(1, "agent-0", STANDING_PARTY_TOPIC_CATALOG);
    const b = createAgentInformationProfile(1, "agent-0", STANDING_PARTY_TOPIC_CATALOG);
    expect(a).toEqual(b);
  });

  it("differs across agents for the same seed", () => {
    const a = createAgentInformationProfile(1, "agent-0", STANDING_PARTY_TOPIC_CATALOG);
    const b = createAgentInformationProfile(1, "agent-1", STANDING_PARTY_TOPIC_CATALOG);
    expect(a).not.toEqual(b);
  });
});

describe("applyInitialGrant", () => {
  it("records understood awareness, an initialGrant source trace, and leaves heard ticks undefined", () => {
    const state: AgentInformationState = { agentId: "agent-0", profile: { retellingTendency: 0.5, memoryRetention: 0.5, baselineTopicInterest: {} }, topics: {}, claims: {} };
    const claim = STANDING_PARTY_CLAIM_CATALOG.claims[0];
    const updated = applyInitialGrant(
      state,
      { agentId: "agent-0", claimId: claim.id, variantId: claim.rootVariantId, sourceId: claim.originalSource.id, acceptance: "adopted", confidence: 0.8, memoryStrength: 0.7 },
      0,
    );
    const claimState = updated.claims[claim.id];
    expect(claimState.awareness).toBe("understood");
    expect(claimState.firstHeardTick).toBeUndefined();
    expect(claimState.lastHeardTick).toBeUndefined();
    expect(claimState.sourceTraces).toHaveLength(1);
    expect(claimState.sourceTraces[0].kind).toBe("initialGrant");
    expect(claimState.sourceTraces[0].immediateSpeakerId).toBeUndefined();
  });
});

describe("createInitialInformationRuntimeState", () => {
  const agents = Array.from({ length: 10 }, (_, i) => ({ id: `agent-${i}` }));

  it("is deterministic for the same seed/config", () => {
    const config: InformationPropagationConfig = {
      ...DEFAULT_INFORMATION_PROPAGATION_CONFIG,
      enabled: true,
      init: { ...DEFAULT_INFORMATION_PROPAGATION_CONFIG.init, autoHolderCounts: { [STANDING_PARTY_CLAIM_CATALOG.claims[0].id]: 2 } },
    };
    const a = createInitialInformationRuntimeState(agents, 123, config);
    const b = createInitialInformationRuntimeState(agents, 123, config);
    expect(a).toEqual(b);
  });

  it("is independent of the input agent array order", () => {
    const config: InformationPropagationConfig = {
      ...DEFAULT_INFORMATION_PROPAGATION_CONFIG,
      enabled: true,
      init: { ...DEFAULT_INFORMATION_PROPAGATION_CONFIG.init, autoHolderCounts: { [STANDING_PARTY_CLAIM_CATALOG.claims[0].id]: 2 } },
    };
    const shuffled = [...agents].reverse();
    const a = createInitialInformationRuntimeState(agents, 123, config);
    const b = createInitialInformationRuntimeState(shuffled, 123, config);
    expect(a).toEqual(b);
  });

  it("supports zero/one/multiple initial holders per claim via autoHolderCounts", () => {
    const claims = STANDING_PARTY_CLAIM_CATALOG.claims;
    const config: InformationPropagationConfig = {
      ...DEFAULT_INFORMATION_PROPAGATION_CONFIG,
      enabled: true,
      init: {
        ...DEFAULT_INFORMATION_PROPAGATION_CONFIG.init,
        autoHolderCounts: { [claims[0].id]: 0, [claims[1].id]: 1, [claims[2].id]: 3 },
      },
    };
    const runtime = createInitialInformationRuntimeState(agents, 7, config);
    expect(listAgentsAwareOfClaim(runtime, claims[0].id)).toHaveLength(0);
    expect(listAgentsAwareOfClaim(runtime, claims[1].id)).toHaveLength(1);
    expect(listAgentsAwareOfClaim(runtime, claims[2].id)).toHaveLength(3);
  });

  it("applies explicit fixture grants and does not double-grant the same claim via autoHolderCounts", () => {
    const claim = STANDING_PARTY_CLAIM_CATALOG.claims[0];
    const config: InformationPropagationConfig = {
      ...DEFAULT_INFORMATION_PROPAGATION_CONFIG,
      enabled: true,
      init: {
        ...DEFAULT_INFORMATION_PROPAGATION_CONFIG.init,
        explicitGrants: [{ agentId: "agent-0", claimId: claim.id, variantId: claim.rootVariantId, acceptance: "adopted", confidence: 0.9, memoryStrength: 0.9 }],
        autoHolderCounts: { [claim.id]: 1 },
      },
    };
    const runtime = createInitialInformationRuntimeState(agents, 7, config);
    const holders = listAgentsAwareOfClaim(runtime, claim.id);
    expect(holders).toContain("agent-0");
    expect(holders).toHaveLength(2); // explicit(1) + auto(1, excluding agent-0)
    expect(getAgentClaimState(runtime, "agent-0", claim.id)?.confidence).toBeCloseTo(0.9);
  });

  it("produces topic interest states for every agent/topic pair", () => {
    const config: InformationPropagationConfig = { ...DEFAULT_INFORMATION_PROPAGATION_CONFIG, enabled: true };
    const runtime = createInitialInformationRuntimeState(agents, 1, config);
    for (const agent of agents) {
      for (const topic of STANDING_PARTY_TOPIC_CATALOG.topics) {
        const topicState = getAgentTopicState(runtime, agent.id, topic.id);
        expect(topicState).toBeDefined();
        expect(topicState!.interest).toBeGreaterThanOrEqual(0);
        expect(topicState!.interest).toBeLessThanOrEqual(1);
      }
    }
  });

  it("throws for an invalid config instead of silently producing a partial state", () => {
    const config: InformationPropagationConfig = {
      ...DEFAULT_INFORMATION_PROPAGATION_CONFIG,
      enabled: true,
      init: { ...DEFAULT_INFORMATION_PROPAGATION_CONFIG.init, autoHolderCounts: { ghost: 1 } },
    };
    expect(() => createInitialInformationRuntimeState(agents, 1, config)).toThrow();
  });
});

describe("listAgentsAwareOfClaim / listAgentsInterestedInTopic", () => {
  it("returns id-sorted, empty-by-default results", () => {
    expect(listAgentsAwareOfClaim({}, "claim:x")).toEqual([]);
    expect(listAgentsInterestedInTopic({}, "topic:x")).toEqual([]);
  });
});
