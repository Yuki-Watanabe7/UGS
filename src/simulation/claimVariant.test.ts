import { describe, expect, it } from "vitest";
import {
  applyMutationFactor,
  computeApplicableMutationKinds,
  generateVariant,
  isMutationKindApplicable,
  mergeGeneratedVariants,
  MUTATION_KINDS,
  type GenerateVariantInput,
} from "./claimVariant";
import { computeSemanticFingerprint, createRootVariant, deriveVariantId } from "./informationModel";
import type { ClaimCatalog, ClaimMeaning, ClaimMutationKind, InformationClaim } from "./informationModel";
import { DEFAULT_INFORMATION_PROPAGATION_LIMITS } from "./informationState";
import type { InformationPropagationLimits } from "./informationState";

/**
 * Issue #232 (Phase 5): `claimVariant.ts`の有限mutation規則(適用可否・変換内容)とdedup/lineage/上限
 * 判定を、`retelling.ts`(呼び出し側)を経由せず直接検証する。retelling decision自体は`retelling.test.ts`。
 */

const CLAIM: InformationClaim = {
  id: "claim:x",
  topicId: "topic:x",
  rootVariantId: "claim:x:root",
  contentKey: "claim.x",
  canonicalMeaning: { subjectKey: "event", predicateKey: "closesAt", objectValue: "21:00", qualifiers: {} },
  originalSource: { id: "source:organizer", kind: "organizer" },
  verifiability: "verifiable",
  verificationStatus: "unknown",
  initialConfidence: 0.8,
};

const CATALOG: ClaimCatalog = { id: "test-claims", claims: [CLAIM], variants: [createRootVariant(CLAIM)] };

function meaning(overrides: Partial<ClaimMeaning> = {}): ClaimMeaning {
  return { subjectKey: "event", predicateKey: "closesAt", objectValue: "21:00", qualifiers: {}, ...overrides };
}

describe("isMutationKindApplicable / computeApplicableMutationKinds", () => {
  it("detailOmission applies when qualifiers or objectValue exist, not for a fully empty meaning", () => {
    expect(isMutationKindApplicable(meaning(), "detailOmission")).toBe(true);
    expect(isMutationKindApplicable(meaning({ objectValue: undefined }), "detailOmission")).toBe(false);
    expect(isMutationKindApplicable(meaning({ objectValue: undefined, qualifiers: { a: 1 } }), "detailOmission")).toBe(true);
  });

  it("certaintyShift only applies when qualifiers.certainty is on the fixed ladder", () => {
    expect(isMutationKindApplicable(meaning(), "certaintyShift")).toBe(false);
    expect(isMutationKindApplicable(meaning({ qualifiers: { certainty: "low" } }), "certaintyShift")).toBe(true);
    expect(isMutationKindApplicable(meaning({ qualifiers: { certainty: "unknown" } }), "certaintyShift")).toBe(false);
  });

  it("magnitudeShift applies to numeric objectValue, HH:MM time strings, or a numeric qualifier", () => {
    expect(isMutationKindApplicable(meaning({ objectValue: "21:00" }), "magnitudeShift")).toBe(true);
    expect(isMutationKindApplicable(meaning({ objectValue: 5 }), "magnitudeShift")).toBe(true);
    expect(isMutationKindApplicable(meaning({ objectValue: "seasonal-special" }), "magnitudeShift")).toBe(false);
    expect(isMutationKindApplicable(meaning({ objectValue: "seasonal-special", qualifiers: { count: 3 } }), "magnitudeShift")).toBe(true);
  });

  it("actorGeneralization only applies for a whitelisted actor-like subjectKey", () => {
    expect(isMutationKindApplicable(meaning({ subjectKey: "event" }), "actorGeneralization")).toBe(false);
    expect(isMutationKindApplicable(meaning({ subjectKey: "venue" }), "actorGeneralization")).toBe(false);
    expect(isMutationKindApplicable(meaning({ subjectKey: "participant" }), "actorGeneralization")).toBe(true);
  });

  it("sourceBlur and emphasisShift are always structurally applicable (toggle both ways)", () => {
    expect(isMutationKindApplicable(meaning(), "sourceBlur")).toBe(true);
    expect(isMutationKindApplicable(meaning(), "emphasisShift")).toBe(true);
    expect(isMutationKindApplicable(meaning({ qualifiers: { sourceBlurred: true } }), "sourceBlur")).toBe(true);
    expect(isMutationKindApplicable(meaning({ qualifiers: { emphasized: true } }), "emphasisShift")).toBe(true);
  });

  it("computeApplicableMutationKinds returns kinds in the fixed MUTATION_KINDS order", () => {
    const applicable = computeApplicableMutationKinds(meaning({ subjectKey: "participant", qualifiers: { certainty: "low" } }));
    const expectedOrder = MUTATION_KINDS.filter((kind) => applicable.includes(kind));
    expect(applicable).toEqual(expectedOrder);
  });
});

describe("applyMutationFactor", () => {
  it("returns undefined for a structurally inapplicable kind", () => {
    expect(applyMutationFactor(meaning(), "certaintyShift")).toBeUndefined();
    expect(applyMutationFactor(meaning({ subjectKey: "event" }), "actorGeneralization")).toBeUndefined();
  });

  it("detailOmission drops the alphabetically-first qualifier when qualifiers exist", () => {
    const result = applyMutationFactor(meaning({ qualifiers: { z: 1, a: 2 } }), "detailOmission");
    expect(result?.meaning.qualifiers).toEqual({ z: 1 });
    expect(result?.factor).toMatchObject({ kind: "detailOmission", fieldKey: "qualifiers.a", before: 2, after: undefined, direction: "remove" });
  });

  it("detailOmission falls back to dropping objectValue when qualifiers are empty", () => {
    const result = applyMutationFactor(meaning(), "detailOmission");
    expect(result?.meaning.objectValue).toBeUndefined();
    expect(result?.factor).toMatchObject({ kind: "detailOmission", fieldKey: "objectValue", before: "21:00", direction: "remove" });
  });

  it("certaintyShift moves up the ladder from low and down from high", () => {
    const up = applyMutationFactor(meaning({ qualifiers: { certainty: "low" } }), "certaintyShift");
    expect(up?.factor).toMatchObject({ direction: "increase", before: "low", after: "medium" });
    const down = applyMutationFactor(meaning({ qualifiers: { certainty: "high" } }), "certaintyShift");
    expect(down?.factor).toMatchObject({ direction: "decrease", before: "high", after: "medium" });
  });

  it("certaintyShift never leaves the fixed 3-level ladder", () => {
    const result = applyMutationFactor(meaning({ qualifiers: { certainty: "medium" } }), "certaintyShift");
    expect(["low", "high"]).not.toContain(result?.factor.before);
    expect(["low", "medium", "high"]).toContain(result?.factor.after);
  });

  it("magnitudeShift on a time-of-day objectValue shifts by 30 minutes and stays in HH:MM form", () => {
    const result = applyMutationFactor(meaning({ objectValue: "21:00" }), "magnitudeShift");
    expect(result?.meaning.objectValue).toMatch(/^\d{2}:\d{2}$/);
    expect(result?.meaning.objectValue).not.toBe("21:00");
    expect(result?.factor.contribution).toBeGreaterThan(0);
  });

  it("magnitudeShift on a numeric objectValue never goes negative", () => {
    const result = applyMutationFactor(meaning({ objectValue: 0 }), "magnitudeShift");
    expect(result?.factor.direction).toBe("increase");
    expect(result?.meaning.objectValue).toBeGreaterThanOrEqual(0);
  });

  it("magnitudeShift on a numeric qualifier targets the first numeric key deterministically", () => {
    const result = applyMutationFactor(meaning({ objectValue: "seasonal-special", qualifiers: { b: 10, a: 4 } }), "magnitudeShift");
    expect(result?.factor.fieldKey).toBe("qualifiers.a");
  });

  it("actorGeneralization replaces subjectKey with a fixed generalized token", () => {
    const result = applyMutationFactor(meaning({ subjectKey: "participant" }), "actorGeneralization");
    expect(result?.meaning.subjectKey).toBe("someone");
    expect(result?.factor).toMatchObject({ kind: "actorGeneralization", before: "participant", after: "someone", direction: "replace" });
  });

  it("sourceBlur and emphasisShift toggle a boolean qualifier both ways", () => {
    const on = applyMutationFactor(meaning(), "sourceBlur");
    expect(on?.meaning.qualifiers.sourceBlurred).toBe(true);
    expect(on?.factor.direction).toBe("increase");
    const off = applyMutationFactor(meaning({ qualifiers: { sourceBlurred: true } }), "sourceBlur");
    expect(off?.meaning.qualifiers.sourceBlurred).toBe(false);
    expect(off?.factor.direction).toBe("decrease");
  });

  it("every kind's contribution is finite and >= 0", () => {
    const withEverything = meaning({ subjectKey: "participant", objectValue: 5, qualifiers: { certainty: "low", extra: "x" } });
    for (const kind of MUTATION_KINDS as ClaimMutationKind[]) {
      const applied = applyMutationFactor(withEverything, kind);
      if (!applied) continue;
      expect(Number.isFinite(applied.factor.contribution)).toBe(true);
      expect(applied.factor.contribution).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("generateVariant", () => {
  const root = CATALOG.variants[0];
  const limits: InformationPropagationLimits = DEFAULT_INFORMATION_PROPAGATION_LIMITS;

  function baseInput(overrides: Partial<GenerateVariantInput> = {}): GenerateVariantInput {
    const applied = applyMutationFactor(root.meaning, "emphasisShift");
    if (!applied) throw new Error("test setup: emphasisShift must apply to the fixture root meaning");
    return {
      catalog: CATALOG,
      parent: root,
      claim: CLAIM,
      appliedFactors: [applied.factor],
      nextMeaning: applied.meaning,
      tick: 5,
      generatorAgentId: "agent-1",
      retellingEventId: "retelling-5-cluster-1-agent-1-claim:x",
      limits,
      semanticDistanceCeiling: 5,
      ...overrides,
    };
  }

  it("creates a new variant with lineage/distance derived from the parent", () => {
    const result = generateVariant(baseInput());
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.variant.parentVariantId).toBe(root.id);
    expect(result.variant.lineageDepth).toBe(root.lineageDepth + 1);
    expect(result.variant.canonicalDistance).toBe(root.canonicalDistance + result.variant.hopDistance);
    expect(result.variant.id).toBe(deriveVariantId(CLAIM.id, computeSemanticFingerprint(result.variant.meaning)));
  });

  it("reuses an existing variant whose fingerprint already matches (dedup)", () => {
    const created = generateVariant(baseInput());
    if (created.status !== "created") throw new Error("expected created");
    const catalogWithVariant = mergeGeneratedVariants(CATALOG, [created.variant]);

    const second = generateVariant(baseInput({ catalog: catalogWithVariant, generatorAgentId: "agent-2" }));
    expect(second.status).toBe("reused");
    if (second.status !== "reused") return;
    expect(second.variant.id).toBe(created.variant.id);
    // 再利用時はgeneratorが変わらない(古いvariantを付け替えない)
    expect(second.variant.generatorAgentId).toBe("agent-1");
  });

  it("blocks on variantLimit once the claim already has maxVariantsPerClaim variants", () => {
    const fullCatalog: ClaimCatalog = {
      ...CATALOG,
      variants: [
        root,
        ...Array.from({ length: limits.maxVariantsPerClaim - 1 }, (_, i) =>
          createRootVariant({ ...CLAIM, id: CLAIM.id, rootVariantId: `claim:x:filler-${i}` }),
        ).map((v, i) => ({ ...v, id: `claim:x:filler-${i}`, parentVariantId: root.id })),
      ],
    };
    const result = generateVariant(baseInput({ catalog: fullCatalog }));
    expect(result).toEqual({ status: "blocked", reason: "variantLimit" });
  });

  it("blocks on lineageDepthLimit once parent is already at the cap", () => {
    const deepParent = { ...root, lineageDepth: limits.maxLineageDepth };
    const result = generateVariant(baseInput({ parent: deepParent }));
    expect(result).toEqual({ status: "blocked", reason: "lineageDepthLimit" });
  });

  it("blocks on distanceCeiling once accumulated canonicalDistance would exceed it", () => {
    const result = generateVariant(baseInput({ semanticDistanceCeiling: 0 }));
    expect(result).toEqual({ status: "blocked", reason: "distanceCeiling" });
  });
});

describe("mergeGeneratedVariants", () => {
  it("returns the same catalog reference when there is nothing to merge", () => {
    expect(mergeGeneratedVariants(CATALOG, [])).toBe(CATALOG);
  });

  it("appends new variants without touching existing ones, and skips ones already present by id", () => {
    const applied = applyMutationFactor(CATALOG.variants[0].meaning, "emphasisShift");
    if (!applied) throw new Error("test setup");
    const generated = generateVariant({
      catalog: CATALOG,
      parent: CATALOG.variants[0],
      claim: CLAIM,
      appliedFactors: [applied.factor],
      nextMeaning: applied.meaning,
      tick: 1,
      generatorAgentId: "agent-1",
      retellingEventId: "retelling-1",
      limits: DEFAULT_INFORMATION_PROPAGATION_LIMITS,
      semanticDistanceCeiling: 5,
    });
    if (generated.status !== "created") throw new Error("expected created");

    const merged = mergeGeneratedVariants(CATALOG, [generated.variant]);
    expect(merged.variants).toHaveLength(CATALOG.variants.length + 1);
    expect(CATALOG.variants).toHaveLength(1); // 入力catalogはmutateされない

    const mergedAgain = mergeGeneratedVariants(merged, [generated.variant]);
    expect(mergedAgain.variants).toHaveLength(merged.variants.length);
  });
});
