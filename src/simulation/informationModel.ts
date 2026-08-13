/**
 * Issue #229 (Phase 5, roadmap #172): `docs/information-propagation-phase5-model.md`(#228 ADR)
 * §2.1〜§2.3の契約に基づく Topic / canonical Claim / ClaimVariant のcatalog型・validation・初期fixture。
 *
 * このモジュールが持つのはcatalogの構造(schema)とvalidationだけである。発話・伝播・受信・採用・
 * variant変容の実行ロジックは対象外(#230以降)。`informationState.ts`はこのcatalogを読み取り専用で
 * 参照し、agentごとのmutable stateを扱う。
 */

// --- Topic ------------------------------------------------------------------------------------

export type TopicDefinition = {
  id: string;
  /** presentation catalog参照キー。表示文言そのものはdomain modelへ直書きしない */
  labelKey: string;
  descriptionKey: string;
  /** 近接topic。同じ意味・同じclaimを表すものではない。自己参照・重複・未知IDは禁止 */
  relatedTopicIds: string[];
  /** [0, 1] */
  baseSalience: number;
};

export type TopicCatalog = {
  id: string;
  topics: TopicDefinition[];
};

export const MAX_TOPICS_PER_CATALOG = 32;

// --- canonical Claim ----------------------------------------------------------------------------

export type ClaimVerifiability = "verifiable" | "uncertain" | "opinion";
export type ClaimVerificationStatus = "unknown" | "disputed" | "verifiedTrue" | "verifiedFalse" | "notApplicable";

export type OriginalSource = {
  id: string;
  kind: "organizer" | "participant" | "ambient" | "synthetic";
  agentId?: string;
};

export type ClaimMeaning = {
  subjectKey: string;
  predicateKey: string;
  objectValue?: string | number | boolean;
  qualifiers: Record<string, string | number | boolean>;
};

export type InformationClaim = {
  id: string;
  topicId: string;
  /** root variantのID。`${id}:root`を推奨するが、catalog作成者が明示する */
  rootVariantId: string;
  /** presentation template参照キー。textそのものは正本にしない */
  contentKey: string;
  canonicalMeaning: ClaimMeaning;
  originalSource: OriginalSource;
  verifiability: ClaimVerifiability;
  verificationStatus: ClaimVerificationStatus;
  /** fixture holderの初期値 [0, 1] */
  initialConfidence: number;
};

export const MAX_CLAIMS_PER_CATALOG = 64;

// --- ClaimVariant -------------------------------------------------------------------------------

export type ClaimMutationKind =
  | "detailOmission"
  | "certaintyShift"
  | "magnitudeShift"
  | "actorGeneralization"
  | "sourceBlur"
  | "emphasisShift";

export type ClaimMutationFactor = {
  kind: ClaimMutationKind;
  fieldKey: string;
  before?: string | number | boolean;
  after?: string | number | boolean;
  direction: "increase" | "decrease" | "remove" | "replace";
  /** >= 0、semantic distanceへの寄与 */
  contribution: number;
};

export type ClaimVariant = {
  id: string;
  canonicalClaimId: string;
  /** canonical claimと同一。変更禁止 */
  topicId: string;
  /** rootのみundefined、派生variantは必須 */
  parentVariantId?: string;
  meaning: ClaimMeaning;
  semanticFingerprint: string;
  mutationFactors: ClaimMutationFactor[];
  /** parentからの距離、有限かつ >= 0 */
  hopDistance: number;
  /** rootからの累積距離、config ceiling以下 */
  canonicalDistance: number;
  lineageDepth: number;
  generatedAtTick: number;
  /** rootはundefined */
  generatorAgentId?: string;
  retellingEventId?: string;
};

export type ClaimCatalog = {
  id: string;
  claims: InformationClaim[];
  /** root variant(全claim分、`parentVariantId === undefined`)を含む */
  variants: ClaimVariant[];
};

export const MAX_VARIANTS_PER_CLAIM = 16;
export const MAX_LINEAGE_DEPTH = 8;

// --- validation -----------------------------------------------------------------------------

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`informationModel: ${name} must be a finite number (got ${value})`);
  }
}

function assertUnit(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0 || value > 1) {
    throw new Error(`informationModel: ${name} must be within [0, 1] (got ${value})`);
  }
}

/**
 * related topicの自己参照・未知ID・重複を拒否し、baseSalience等の数値がNaN/Infinity・定義域外でないことを
 * validationする(受入条件)。
 */
export function validateTopicCatalog(catalog: TopicCatalog): void {
  if (!catalog.id) throw new Error("informationModel: TopicCatalog.id must not be empty");
  if (catalog.topics.length > MAX_TOPICS_PER_CATALOG) {
    throw new Error(
      `informationModel: topic catalog "${catalog.id}" exceeds ${MAX_TOPICS_PER_CATALOG} topics (got ${catalog.topics.length})`,
    );
  }

  const seenIds = new Set<string>();
  for (const topic of catalog.topics) {
    if (!topic.id) throw new Error("informationModel: TopicDefinition.id must not be empty");
    if (seenIds.has(topic.id)) throw new Error(`informationModel: duplicate topic id "${topic.id}"`);
    seenIds.add(topic.id);
    assertUnit(`topic "${topic.id}".baseSalience`, topic.baseSalience);
  }

  for (const topic of catalog.topics) {
    const seenRelated = new Set<string>();
    for (const relatedId of topic.relatedTopicIds) {
      if (relatedId === topic.id) {
        throw new Error(`informationModel: topic "${topic.id}" lists itself in relatedTopicIds`);
      }
      if (seenRelated.has(relatedId)) {
        throw new Error(`informationModel: topic "${topic.id}" lists duplicate relatedTopicId "${relatedId}"`);
      }
      seenRelated.add(relatedId);
      if (!seenIds.has(relatedId)) {
        throw new Error(`informationModel: topic "${topic.id}" references unknown relatedTopicId "${relatedId}"`);
      }
    }
  }
}

/** FNV-1a風の単純な文字列ハッシュ(`schoolInterventionRuntime.ts`/`model.ts`と同じ表現専用パターン) */
function hashString(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeMeaning(meaning: ClaimMeaning): string {
  const qualifierKeys = Object.keys(meaning.qualifiers).sort();
  const qualifierPart = qualifierKeys.map((key) => `${key}=${String(meaning.qualifiers[key])}`).join(",");
  return `${meaning.subjectKey}|${meaning.predicateKey}|${meaning.objectValue ?? ""}|${qualifierPart}`;
}

/**
 * variant dedupの正本となるfingerprint。正規化済みの構造化`meaning`から決定的に導出するため、
 * 同じ意味なら常に同じ値になる(受入条件: 表示文言差はvariantにしない)。
 */
export function computeSemanticFingerprint(meaning: ClaimMeaning): string {
  return hashString(normalizeMeaning(meaning)).toString(36);
}

/** `canonicalClaimId + normalized meaning`から決定的にvariant IDを作る(§2.3) */
export function deriveVariantId(canonicalClaimId: string, fingerprint: string): string {
  return `${canonicalClaimId}:${fingerprint}`;
}

/** 同じfingerprintの既存variantがあれば返す(再利用判定に使う純粋関数) */
export function findVariantByFingerprint(
  catalog: ClaimCatalog,
  canonicalClaimId: string,
  fingerprint: string,
): ClaimVariant | undefined {
  return catalog.variants.find(
    (variant) => variant.canonicalClaimId === canonicalClaimId && variant.semanticFingerprint === fingerprint,
  );
}

/** claimのcanonical meaningをそのまま持つroot variantを作る(rootは`generatorAgentId`/`retellingEventId`を持たない) */
export function createRootVariant(claim: InformationClaim): ClaimVariant {
  return {
    id: claim.rootVariantId,
    canonicalClaimId: claim.id,
    topicId: claim.topicId,
    parentVariantId: undefined,
    meaning: claim.canonicalMeaning,
    semanticFingerprint: computeSemanticFingerprint(claim.canonicalMeaning),
    mutationFactors: [],
    hopDistance: 0,
    canonicalDistance: 0,
    lineageDepth: 0,
    generatedAtTick: 0,
    generatorAgentId: undefined,
    retellingEventId: undefined,
  };
}

/**
 * 不正ID参照・lineage cycle・NaN/Infinity・定義域外値を拒否する(受入条件)。少なくとも次を検証する:
 * - claim/variant IDの一意性、claimのtopicId解決可能性
 * - `opinion`は`verificationStatus: "notApplicable"`(§2.2)
 * - root variantの存在・`parentVariantId === undefined`、非rootは`parentVariantId`必須
 * - variant数上限(`MAX_VARIANTS_PER_CLAIM`)・lineage深さ上限(`MAX_LINEAGE_DEPTH`)
 * - `semanticFingerprint`が正規化済みmeaningと一致すること
 * - parent chainの自己参照・未知ID・別claim混入・cycleがないこと(§6.3)
 */
export function validateClaimCatalog(catalog: ClaimCatalog, topicCatalog: TopicCatalog): void {
  if (!catalog.id) throw new Error("informationModel: ClaimCatalog.id must not be empty");
  if (catalog.claims.length > MAX_CLAIMS_PER_CATALOG) {
    throw new Error(
      `informationModel: claim catalog "${catalog.id}" exceeds ${MAX_CLAIMS_PER_CATALOG} claims (got ${catalog.claims.length})`,
    );
  }

  const topicIds = new Set(topicCatalog.topics.map((topic) => topic.id));
  const claimIds = new Set<string>();
  const claimById = new Map<string, InformationClaim>();
  for (const claim of catalog.claims) {
    if (!claim.id) throw new Error("informationModel: InformationClaim.id must not be empty");
    if (claimIds.has(claim.id)) throw new Error(`informationModel: duplicate claim id "${claim.id}"`);
    claimIds.add(claim.id);
    claimById.set(claim.id, claim);
    if (!topicIds.has(claim.topicId)) {
      throw new Error(`informationModel: claim "${claim.id}" references unknown topicId "${claim.topicId}"`);
    }
    assertUnit(`claim "${claim.id}".initialConfidence`, claim.initialConfidence);
    if (claim.verifiability === "opinion" && claim.verificationStatus !== "notApplicable") {
      throw new Error(
        `informationModel: claim "${claim.id}" is an opinion but verificationStatus is "${claim.verificationStatus}" (must be "notApplicable")`,
      );
    }
  }

  const variantsByClaim = new Map<string, ClaimVariant[]>();
  const variantIds = new Set<string>();
  const variantById = new Map<string, ClaimVariant>();
  for (const variant of catalog.variants) {
    if (!variant.id) throw new Error("informationModel: ClaimVariant.id must not be empty");
    if (variantIds.has(variant.id)) throw new Error(`informationModel: duplicate variant id "${variant.id}"`);
    variantIds.add(variant.id);
    variantById.set(variant.id, variant);

    const claim = claimById.get(variant.canonicalClaimId);
    if (!claim) {
      throw new Error(`informationModel: variant "${variant.id}" references unknown canonicalClaimId "${variant.canonicalClaimId}"`);
    }
    if (variant.topicId !== claim.topicId) {
      throw new Error(
        `informationModel: variant "${variant.id}".topicId "${variant.topicId}" does not match claim "${claim.id}".topicId "${claim.topicId}"`,
      );
    }
    assertFinite(`variant "${variant.id}".hopDistance`, variant.hopDistance);
    if (variant.hopDistance < 0) throw new Error(`informationModel: variant "${variant.id}".hopDistance must be >= 0`);
    assertFinite(`variant "${variant.id}".canonicalDistance`, variant.canonicalDistance);
    if (variant.canonicalDistance < 0) {
      throw new Error(`informationModel: variant "${variant.id}".canonicalDistance must be >= 0`);
    }
    if (!Number.isInteger(variant.lineageDepth) || variant.lineageDepth < 0) {
      throw new Error(`informationModel: variant "${variant.id}".lineageDepth must be a non-negative integer`);
    }
    if (variant.lineageDepth > MAX_LINEAGE_DEPTH) {
      throw new Error(`informationModel: variant "${variant.id}".lineageDepth exceeds cap ${MAX_LINEAGE_DEPTH}`);
    }
    const expectedFingerprint = computeSemanticFingerprint(variant.meaning);
    if (variant.semanticFingerprint !== expectedFingerprint) {
      throw new Error(`informationModel: variant "${variant.id}".semanticFingerprint does not match its normalized meaning`);
    }

    const list = variantsByClaim.get(variant.canonicalClaimId) ?? [];
    list.push(variant);
    variantsByClaim.set(variant.canonicalClaimId, list);
  }

  for (const claim of catalog.claims) {
    const variants = variantsByClaim.get(claim.id) ?? [];
    if (variants.length > MAX_VARIANTS_PER_CLAIM) {
      throw new Error(
        `informationModel: claim "${claim.id}" exceeds ${MAX_VARIANTS_PER_CLAIM} variants (got ${variants.length})`,
      );
    }
    const root = variantById.get(claim.rootVariantId);
    if (!root || root.canonicalClaimId !== claim.id) {
      throw new Error(`informationModel: claim "${claim.id}".rootVariantId "${claim.rootVariantId}" does not resolve to one of its variants`);
    }
    if (root.parentVariantId !== undefined) {
      throw new Error(`informationModel: claim "${claim.id}" root variant "${root.id}" must not have a parentVariantId`);
    }
    for (const variant of variants) {
      if (variant.id !== root.id && variant.parentVariantId === undefined) {
        throw new Error(`informationModel: non-root variant "${variant.id}" must have a parentVariantId`);
      }
    }
  }

  // parent chainのself-reference/未知ID/別claim混入/cycleを検出する(§6.3、古いvariantを削除して
  // つなぎ替えることは禁止 ―― ここではvalidationのみ行い、削除・修復はしない)
  for (const variant of catalog.variants) {
    const visited = new Set<string>();
    let current: ClaimVariant | undefined = variant;
    let depth = 0;
    while (current?.parentVariantId !== undefined) {
      if (visited.has(current.id)) {
        throw new Error(`informationModel: lineage cycle detected involving variant "${variant.id}"`);
      }
      visited.add(current.id);
      depth += 1;
      if (depth > MAX_LINEAGE_DEPTH) {
        throw new Error(`informationModel: lineage chain for variant "${variant.id}" exceeds depth cap ${MAX_LINEAGE_DEPTH}`);
      }
      const parent = variantById.get(current.parentVariantId);
      if (!parent) {
        throw new Error(`informationModel: variant "${current.id}" references unknown parentVariantId "${current.parentVariantId}"`);
      }
      if (parent.canonicalClaimId !== variant.canonicalClaimId) {
        throw new Error(`informationModel: variant "${current.id}" parent "${parent.id}" belongs to a different claim`);
      }
      current = parent;
    }
  }
}

// --- 初期fixture(立食パーティー向け) -------------------------------------------------------

/**
 * 職業・趣味・イベント情報等の中立的で立食パーティーに自然な少数topic。政治・健康・個人属性等の
 * 高リスクな現実判断は含めない(受入条件)。
 */
export const STANDING_PARTY_TOPIC_CATALOG: TopicCatalog = {
  id: "standing-party-topics-v1",
  topics: [
    {
      id: "topic:event-program",
      labelKey: "topic.eventProgram.label",
      descriptionKey: "topic.eventProgram.description",
      relatedTopicIds: ["topic:venue-logistics"],
      baseSalience: 0.6,
    },
    {
      id: "topic:venue-logistics",
      labelKey: "topic.venueLogistics.label",
      descriptionKey: "topic.venueLogistics.description",
      relatedTopicIds: ["topic:event-program"],
      baseSalience: 0.4,
    },
    {
      id: "topic:food-and-drink",
      labelKey: "topic.foodAndDrink.label",
      descriptionKey: "topic.foodAndDrink.description",
      relatedTopicIds: [],
      baseSalience: 0.5,
    },
    {
      id: "topic:occupation",
      labelKey: "topic.occupation.label",
      descriptionKey: "topic.occupation.description",
      relatedTopicIds: ["topic:hobby"],
      baseSalience: 0.45,
    },
    {
      id: "topic:hobby",
      labelKey: "topic.hobby.label",
      descriptionKey: "topic.hobby.description",
      relatedTopicIds: ["topic:occupation"],
      baseSalience: 0.5,
    },
  ],
};

const STANDING_PARTY_FIXTURE_CLAIMS: InformationClaim[] = [
  {
    id: "claim:event-program:closing-time",
    topicId: "topic:event-program",
    rootVariantId: "claim:event-program:closing-time:root",
    contentKey: "claim.eventProgram.closingTime",
    canonicalMeaning: { subjectKey: "event", predicateKey: "closesAt", objectValue: "21:00", qualifiers: {} },
    originalSource: { id: "source:organizer", kind: "organizer" },
    verifiability: "verifiable",
    verificationStatus: "unknown",
    initialConfidence: 0.9,
  },
  {
    id: "claim:venue-logistics:coat-check",
    topicId: "topic:venue-logistics",
    rootVariantId: "claim:venue-logistics:coat-check:root",
    contentKey: "claim.venueLogistics.coatCheck",
    canonicalMeaning: { subjectKey: "venue", predicateKey: "hasCoatCheck", objectValue: true, qualifiers: {} },
    originalSource: { id: "source:organizer", kind: "organizer" },
    verifiability: "verifiable",
    verificationStatus: "unknown",
    initialConfidence: 0.7,
  },
  {
    id: "claim:food-and-drink:menu-highlight",
    topicId: "topic:food-and-drink",
    rootVariantId: "claim:food-and-drink:menu-highlight:root",
    contentKey: "claim.foodAndDrink.menuHighlight",
    canonicalMeaning: { subjectKey: "menu", predicateKey: "featuresDish", objectValue: "seasonal-special", qualifiers: {} },
    originalSource: { id: "source:ambient", kind: "ambient" },
    verifiability: "uncertain",
    verificationStatus: "unknown",
    initialConfidence: 0.4,
  },
  {
    id: "claim:hobby:favorite-recommendation",
    topicId: "topic:hobby",
    rootVariantId: "claim:hobby:favorite-recommendation:root",
    contentKey: "claim.hobby.favoriteRecommendation",
    canonicalMeaning: { subjectKey: "participant", predicateKey: "recommends", objectValue: "hiking-spot", qualifiers: {} },
    originalSource: { id: "source:participant", kind: "participant" },
    verifiability: "opinion",
    verificationStatus: "notApplicable",
    initialConfidence: 0.5,
  },
];

export const STANDING_PARTY_CLAIM_CATALOG: ClaimCatalog = {
  id: "standing-party-claims-v1",
  claims: STANDING_PARTY_FIXTURE_CLAIMS,
  variants: STANDING_PARTY_FIXTURE_CLAIMS.map(createRootVariant),
};

validateTopicCatalog(STANDING_PARTY_TOPIC_CATALOG);
validateClaimCatalog(STANDING_PARTY_CLAIM_CATALOG, STANDING_PARTY_TOPIC_CATALOG);
