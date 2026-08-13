import { describe, expect, it } from "vitest";
import {
  STANDING_PARTY_CLAIM_CATALOG,
  STANDING_PARTY_TOPIC_CATALOG,
  computeSemanticFingerprint,
  createRootVariant,
  findVariantByFingerprint,
  validateClaimCatalog,
  validateTopicCatalog,
  type ClaimCatalog,
  type ClaimVariant,
  type InformationClaim,
  type TopicCatalog,
} from "./informationModel";

/**
 * Issue #229 (Phase 5): Topic / canonical Claim / ClaimVariant catalogのschema・validationを検証する。
 * 発話・伝播ロジックは対象外(#230以降)であり、ここではcatalogの構造的な正しさだけを扱う。
 */

describe("STANDING_PARTY fixture catalogs", () => {
  it("is internally valid (validated again at module load time too)", () => {
    expect(() => validateTopicCatalog(STANDING_PARTY_TOPIC_CATALOG)).not.toThrow();
    expect(() => validateClaimCatalog(STANDING_PARTY_CLAIM_CATALOG, STANDING_PARTY_TOPIC_CATALOG)).not.toThrow();
  });

  it("contains only neutral topics (no political/health/personal-attribute fixture)", () => {
    const riskyKeywords = ["political", "health", "religion", "income"];
    for (const topic of STANDING_PARTY_TOPIC_CATALOG.topics) {
      for (const keyword of riskyKeywords) {
        expect(topic.id.toLowerCase()).not.toContain(keyword);
      }
    }
  });

  it("every claim's rootVariantId resolves to a root variant in the catalog", () => {
    for (const claim of STANDING_PARTY_CLAIM_CATALOG.claims) {
      const root = STANDING_PARTY_CLAIM_CATALOG.variants.find((v) => v.id === claim.rootVariantId);
      expect(root).toBeDefined();
      expect(root?.parentVariantId).toBeUndefined();
      expect(root?.canonicalClaimId).toBe(claim.id);
    }
  });

  it("opinion claims use verificationStatus 'notApplicable'", () => {
    const opinionClaims = STANDING_PARTY_CLAIM_CATALOG.claims.filter((c) => c.verifiability === "opinion");
    expect(opinionClaims.length).toBeGreaterThan(0);
    for (const claim of opinionClaims) {
      expect(claim.verificationStatus).toBe("notApplicable");
    }
  });
});

describe("validateTopicCatalog", () => {
  const baseTopic = (id: string, related: string[] = []) => ({
    id,
    labelKey: `${id}.label`,
    descriptionKey: `${id}.description`,
    relatedTopicIds: related,
    baseSalience: 0.5,
  });

  it("accepts a well-formed catalog", () => {
    const catalog: TopicCatalog = { id: "cat-1", topics: [baseTopic("a", ["b"]), baseTopic("b", ["a"])] };
    expect(() => validateTopicCatalog(catalog)).not.toThrow();
  });

  it("rejects duplicate topic ids", () => {
    const catalog: TopicCatalog = { id: "cat-1", topics: [baseTopic("a"), baseTopic("a")] };
    expect(() => validateTopicCatalog(catalog)).toThrow();
  });

  it("rejects self-referencing relatedTopicIds", () => {
    const catalog: TopicCatalog = { id: "cat-1", topics: [baseTopic("a", ["a"])] };
    expect(() => validateTopicCatalog(catalog)).toThrow();
  });

  it("rejects unknown relatedTopicIds", () => {
    const catalog: TopicCatalog = { id: "cat-1", topics: [baseTopic("a", ["ghost"])] };
    expect(() => validateTopicCatalog(catalog)).toThrow();
  });

  it("rejects duplicate relatedTopicIds", () => {
    const catalog: TopicCatalog = { id: "cat-1", topics: [baseTopic("a", ["b", "b"]), baseTopic("b")] };
    expect(() => validateTopicCatalog(catalog)).toThrow();
  });

  it("rejects NaN/Infinity baseSalience and out-of-range values", () => {
    expect(() =>
      validateTopicCatalog({ id: "c", topics: [{ ...baseTopic("a"), baseSalience: Number.NaN }] }),
    ).toThrow();
    expect(() =>
      validateTopicCatalog({ id: "c", topics: [{ ...baseTopic("a"), baseSalience: 1.5 }] }),
    ).toThrow();
  });
});

describe("computeSemanticFingerprint / createRootVariant", () => {
  const claim: InformationClaim = {
    id: "claim:test",
    topicId: "topic:test",
    rootVariantId: "claim:test:root",
    contentKey: "claim.test",
    canonicalMeaning: { subjectKey: "s", predicateKey: "p", objectValue: "v", qualifiers: { a: 1, b: "x" } },
    originalSource: { id: "source:organizer", kind: "organizer" },
    verifiability: "verifiable",
    verificationStatus: "unknown",
    initialConfidence: 0.5,
  };

  it("is deterministic and order-independent over qualifier keys", () => {
    const meaningA = { subjectKey: "s", predicateKey: "p", objectValue: "v", qualifiers: { a: 1, b: "x" } };
    const meaningB = { subjectKey: "s", predicateKey: "p", objectValue: "v", qualifiers: { b: "x", a: 1 } };
    expect(computeSemanticFingerprint(meaningA)).toBe(computeSemanticFingerprint(meaningB));
  });

  it("differs when meaning differs", () => {
    const meaningA = { subjectKey: "s", predicateKey: "p", objectValue: "v", qualifiers: {} };
    const meaningB = { subjectKey: "s", predicateKey: "p", objectValue: "different", qualifiers: {} };
    expect(computeSemanticFingerprint(meaningA)).not.toBe(computeSemanticFingerprint(meaningB));
  });

  it("createRootVariant produces a variant matching claim.rootVariantId with no parent", () => {
    const root = createRootVariant(claim);
    expect(root.id).toBe(claim.rootVariantId);
    expect(root.parentVariantId).toBeUndefined();
    expect(root.canonicalClaimId).toBe(claim.id);
    expect(root.topicId).toBe(claim.topicId);
    expect(root.semanticFingerprint).toBe(computeSemanticFingerprint(claim.canonicalMeaning));
  });

  it("findVariantByFingerprint finds an existing variant for dedup", () => {
    const root = createRootVariant(claim);
    const catalog: ClaimCatalog = { id: "cat", claims: [claim], variants: [root] };
    expect(findVariantByFingerprint(catalog, claim.id, root.semanticFingerprint)?.id).toBe(root.id);
    expect(findVariantByFingerprint(catalog, claim.id, "nonexistent")).toBeUndefined();
  });
});

describe("validateClaimCatalog", () => {
  const topicCatalog: TopicCatalog = {
    id: "topics",
    topics: [
      { id: "topic:a", labelKey: "a.label", descriptionKey: "a.desc", relatedTopicIds: [], baseSalience: 0.5 },
    ],
  };

  function makeClaim(overrides: Partial<InformationClaim> = {}): InformationClaim {
    return {
      id: "claim:a",
      topicId: "topic:a",
      rootVariantId: "claim:a:root",
      contentKey: "claim.a",
      canonicalMeaning: { subjectKey: "s", predicateKey: "p", objectValue: "v", qualifiers: {} },
      originalSource: { id: "source:organizer", kind: "organizer" },
      verifiability: "verifiable",
      verificationStatus: "unknown",
      initialConfidence: 0.5,
      ...overrides,
    };
  }

  it("accepts a valid single-claim catalog with a root variant", () => {
    const claim = makeClaim();
    const catalog: ClaimCatalog = { id: "claims", claims: [claim], variants: [createRootVariant(claim)] };
    expect(() => validateClaimCatalog(catalog, topicCatalog)).not.toThrow();
  });

  it("rejects a claim referencing an unknown topicId", () => {
    const claim = makeClaim({ topicId: "topic:ghost" });
    const catalog: ClaimCatalog = { id: "claims", claims: [claim], variants: [createRootVariant(claim)] };
    expect(() => validateClaimCatalog(catalog, topicCatalog)).toThrow();
  });

  it("rejects duplicate claim ids", () => {
    const claim = makeClaim();
    const catalog: ClaimCatalog = {
      id: "claims",
      claims: [claim, makeClaim()],
      variants: [createRootVariant(claim)],
    };
    expect(() => validateClaimCatalog(catalog, topicCatalog)).toThrow();
  });

  it("rejects an opinion claim whose verificationStatus is not notApplicable", () => {
    const claim = makeClaim({ verifiability: "opinion", verificationStatus: "unknown" });
    const catalog: ClaimCatalog = { id: "claims", claims: [claim], variants: [createRootVariant(claim)] };
    expect(() => validateClaimCatalog(catalog, topicCatalog)).toThrow();
  });

  it("rejects a claim whose rootVariantId does not resolve to a variant", () => {
    const claim = makeClaim();
    const catalog: ClaimCatalog = { id: "claims", claims: [claim], variants: [] };
    expect(() => validateClaimCatalog(catalog, topicCatalog)).toThrow();
  });

  it("rejects a root variant with a parentVariantId", () => {
    const claim = makeClaim();
    const root = { ...createRootVariant(claim), parentVariantId: claim.rootVariantId };
    const catalog: ClaimCatalog = { id: "claims", claims: [claim], variants: [root] };
    expect(() => validateClaimCatalog(catalog, topicCatalog)).toThrow();
  });

  it("rejects a non-root variant with no parentVariantId", () => {
    const claim = makeClaim();
    const root = createRootVariant(claim);
    const orphan: ClaimVariant = {
      ...root,
      id: "claim:a:orphan",
      parentVariantId: undefined,
      meaning: { ...root.meaning, objectValue: "different" },
      semanticFingerprint: computeSemanticFingerprint({ ...root.meaning, objectValue: "different" }),
    };
    const catalog: ClaimCatalog = { id: "claims", claims: [claim], variants: [root, orphan] };
    expect(() => validateClaimCatalog(catalog, topicCatalog)).toThrow();
  });

  it("rejects a variant whose semanticFingerprint does not match its meaning", () => {
    const claim = makeClaim();
    const root = { ...createRootVariant(claim), semanticFingerprint: "tampered" };
    const catalog: ClaimCatalog = { id: "claims", claims: [claim], variants: [root] };
    expect(() => validateClaimCatalog(catalog, topicCatalog)).toThrow();
  });

  it("rejects a lineage cycle", () => {
    const claim = makeClaim();
    const root = createRootVariant(claim);
    const childMeaning = { ...root.meaning, objectValue: "child" };
    const child: ClaimVariant = {
      ...root,
      id: "claim:a:child",
      parentVariantId: root.id,
      meaning: childMeaning,
      semanticFingerprint: computeSemanticFingerprint(childMeaning),
      lineageDepth: 1,
    };
    // root->childは正しいが、childを自分自身の親として書き換えてcycleを作る
    const cyclicRoot: ClaimVariant = { ...root, parentVariantId: child.id };
    const catalog: ClaimCatalog = { id: "claims", claims: [claim], variants: [cyclicRoot, child] };
    expect(() => validateClaimCatalog(catalog, topicCatalog)).toThrow();
  });

  it("rejects a variant whose parent belongs to a different claim", () => {
    const claimA = makeClaim({ id: "claim:a", rootVariantId: "claim:a:root" });
    const claimB = makeClaim({
      id: "claim:b",
      rootVariantId: "claim:b:root",
      canonicalMeaning: { subjectKey: "s2", predicateKey: "p2", objectValue: "v2", qualifiers: {} },
    });
    const rootA = createRootVariant(claimA);
    const rootB = createRootVariant(claimB);
    const crossClaimChild: ClaimVariant = {
      ...rootB,
      id: "claim:b:child",
      parentVariantId: rootA.id,
      lineageDepth: 1,
    };
    const catalog: ClaimCatalog = {
      id: "claims",
      claims: [claimA, claimB],
      variants: [rootA, rootB, crossClaimChild],
    };
    expect(() => validateClaimCatalog(catalog, topicCatalog)).toThrow();
  });

  it("rejects a claim exceeding the initialConfidence [0,1] range", () => {
    const claim = makeClaim({ initialConfidence: 1.2 });
    const catalog: ClaimCatalog = { id: "claims", claims: [claim], variants: [createRootVariant(claim)] };
    expect(() => validateClaimCatalog(catalog, topicCatalog)).toThrow();
  });
});
