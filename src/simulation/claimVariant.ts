/**
 * Issue #232 (Phase 5, roadmap #172): `docs/information-propagation-phase5-model.md`(#228 ADR)
 * §6の契約に基づく、有限`ClaimMutationKind`だけを使ったClaimVariant変容の実装。
 *
 * このモジュールが行うのは「与えられた`ClaimMeaning`へ、どの変容factorが構造的に適用可能か」の判定と、
 * 「適用した結果のmeaning + `ClaimMutationFactor`」の純粋な計算、そして`informationModel.ts`の
 * dedup/lineageの正本(`computeSemanticFingerprint`/`deriveVariantId`/`findVariantByFingerprint`)を
 * 再利用したvariant生成/再利用/上限判定だけである。retelling decision(いつ・誰が・どの確率で変容を
 * 試みるか)は対象外(`retelling.ts`)。LLM・自由文章生成・自然言語類似度は一切使わない(ADR §6.2)。
 *
 * 全ての公開関数はRNGを受け取らない決定的関数。「どのfactorを適用するか」自体の確率的選択は
 * `retelling.ts`側がentity-key派生streamで行い、ここでは「適用するfactorが決まった後の変換規則」と
 * 「適用可能かどうかの構造的判定」だけを扱う。
 */
import type { ClaimCatalog, ClaimMeaning, ClaimMutationFactor, ClaimMutationKind, ClaimVariant, InformationClaim } from "./informationModel";
import { computeSemanticFingerprint, deriveVariantId, findVariantByFingerprint } from "./informationModel";
import type { InformationPropagationLimits } from "./informationState";

/** 固定順序(§6.2: 有限のkindだけを使う)。`retelling.ts`の`mutation-factor`stage draw順もこの順序を使う */
export const MUTATION_KINDS: readonly ClaimMutationKind[] = [
  "detailOmission",
  "certaintyShift",
  "magnitudeShift",
  "actorGeneralization",
  "sourceBlur",
  "emphasisShift",
];

/**
 * kindごとの固定semantic distance寄与(finite >= 0)。乱数を使わず、kindの構造的な「意味の変わり具合」
 * だけで決める(§6.2「hopDistanceとcanonicalDistanceを分離する」の元になる値)。
 */
const MUTATION_CONTRIBUTION: Record<ClaimMutationKind, number> = {
  detailOmission: 1,
  certaintyShift: 0.5,
  magnitudeShift: 0.75,
  actorGeneralization: 1,
  sourceBlur: 0.5,
  emphasisShift: 0.25,
};

/** actorGeneralizationを適用してよい`subjectKey`の有限whitelist(現実の個人属性推定を行わないための構造的制約) */
const ACTOR_SUBJECT_KEYS = new Set(["participant", "organizer", "speaker", "agent"]);

const CERTAINTY_LADDER = ["low", "medium", "high"] as const;
type CertaintyLevel = (typeof CERTAINTY_LADDER)[number];

const TIME_OF_DAY_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function isTimeOfDay(value: unknown): value is string {
  return typeof value === "string" && TIME_OF_DAY_PATTERN.test(value);
}

function timeToMinutes(value: string): number {
  const [h, m] = value.split(":").map((part) => Number.parseInt(part, 10));
  return h * 60 + m;
}

function minutesToTime(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, totalMinutes));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** FNV-1a風の単純な文字列ハッシュ(他Phase 5モジュールと同じ表現専用パターン)。乱数streamではなく決定的parity判定専用 */
function hashString(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** rngを使わず、meaningの内容だけから決定的に増減方向を選ぶ(値の対称性のためだけの補助、統計的偏りは許容する) */
function directionParity(meaning: ClaimMeaning): "increase" | "decrease" {
  const key = `${meaning.subjectKey}|${meaning.predicateKey}|${String(meaning.objectValue ?? "")}`;
  return hashString(key) % 2 === 0 ? "increase" : "decrease";
}

function firstNumericQualifierKey(qualifiers: ClaimMeaning["qualifiers"]): string | undefined {
  return Object.keys(qualifiers)
    .sort()
    .find((key) => typeof qualifiers[key] === "number");
}

/**
 * 与えられた`meaning`へ`kind`を構造的に適用できるかを判定する(§6.2「適用不能なclaimへ無理に適用しない」)。
 * `sourceBlur`/`emphasisShift`は真偽qualifierのtoggleとして常に適用可能(終端がなく、増減どちらへも戻せる)。
 */
export function isMutationKindApplicable(meaning: ClaimMeaning, kind: ClaimMutationKind): boolean {
  switch (kind) {
    case "detailOmission":
      return Object.keys(meaning.qualifiers).length > 0 || meaning.objectValue !== undefined;
    case "certaintyShift":
      return (CERTAINTY_LADDER as readonly string[]).includes(String(meaning.qualifiers.certainty));
    case "magnitudeShift":
      return (
        typeof meaning.objectValue === "number" ||
        isTimeOfDay(meaning.objectValue) ||
        firstNumericQualifierKey(meaning.qualifiers) !== undefined
      );
    case "actorGeneralization":
      return typeof meaning.subjectKey === "string" && ACTOR_SUBJECT_KEYS.has(meaning.subjectKey) && meaning.subjectKey !== "someone";
    case "sourceBlur":
    case "emphasisShift":
      return true;
  }
}

/** 現在のmeaningに構造的に適用可能な`ClaimMutationKind`を固定順で返す(検査・テスト用の純粋helper) */
export function computeApplicableMutationKinds(meaning: ClaimMeaning): ClaimMutationKind[] {
  return MUTATION_KINDS.filter((kind) => isMutationKindApplicable(meaning, kind));
}

export type AppliedMutation = { meaning: ClaimMeaning; factor: ClaimMutationFactor };

/**
 * `kind`を`meaning`へ適用した結果のmeaningとfactorを返す。適用不能なら`undefined`(呼び出し側で必ず
 * `isMutationKindApplicable`相当のチェックを経ていることを前提とするが、ここでも防御的に再チェックする)。
 * rngを一切使わない決定的関数 ―― 増減方向が両方構造的に妥当な場合だけ`directionParity`で決定的に選ぶ。
 */
export function applyMutationFactor(meaning: ClaimMeaning, kind: ClaimMutationKind): AppliedMutation | undefined {
  if (!isMutationKindApplicable(meaning, kind)) return undefined;

  switch (kind) {
    case "detailOmission": {
      const qualifierKeys = Object.keys(meaning.qualifiers).sort();
      if (qualifierKeys.length > 0) {
        const key = qualifierKeys[0];
        const before = meaning.qualifiers[key];
        const rest = { ...meaning.qualifiers };
        delete rest[key];
        return {
          meaning: { ...meaning, qualifiers: rest },
          factor: { kind, fieldKey: `qualifiers.${key}`, before, after: undefined, direction: "remove", contribution: MUTATION_CONTRIBUTION[kind] },
        };
      }
      const before = meaning.objectValue;
      return {
        meaning: { ...meaning, objectValue: undefined },
        factor: { kind, fieldKey: "objectValue", before, after: undefined, direction: "remove", contribution: MUTATION_CONTRIBUTION[kind] },
      };
    }
    case "certaintyShift": {
      const current = String(meaning.qualifiers.certainty) as CertaintyLevel;
      const index = CERTAINTY_LADDER.indexOf(current);
      const direction: "increase" | "decrease" = index <= 0 ? "increase" : index >= CERTAINTY_LADDER.length - 1 ? "decrease" : "increase";
      const nextIndex = direction === "increase" ? index + 1 : index - 1;
      const after = CERTAINTY_LADDER[nextIndex];
      return {
        meaning: { ...meaning, qualifiers: { ...meaning.qualifiers, certainty: after } },
        factor: { kind, fieldKey: "qualifiers.certainty", before: current, after, direction, contribution: MUTATION_CONTRIBUTION[kind] },
      };
    }
    case "magnitudeShift": {
      if (typeof meaning.objectValue === "number") {
        const before = meaning.objectValue;
        const step = before === 0 ? 1 : Math.max(1, Math.round(Math.abs(before) * 0.1));
        const direction: "increase" | "decrease" = before <= 0 ? "increase" : directionParity(meaning);
        const after = direction === "increase" ? before + step : Math.max(0, before - step);
        return {
          meaning: { ...meaning, objectValue: after },
          factor: { kind, fieldKey: "objectValue", before, after, direction, contribution: MUTATION_CONTRIBUTION[kind] },
        };
      }
      if (isTimeOfDay(meaning.objectValue)) {
        const before = meaning.objectValue;
        const direction: "increase" | "decrease" = directionParity(meaning);
        const minutes = timeToMinutes(before);
        const nextMinutes = direction === "increase" ? minutes + 30 : minutes - 30;
        const after = minutesToTime(nextMinutes);
        return {
          meaning: { ...meaning, objectValue: after },
          factor: { kind, fieldKey: "objectValue", before, after, direction, contribution: MUTATION_CONTRIBUTION[kind] },
        };
      }
      const numericKey = firstNumericQualifierKey(meaning.qualifiers);
      if (numericKey !== undefined) {
        const before = meaning.qualifiers[numericKey] as number;
        const step = before === 0 ? 1 : Math.max(1, Math.round(Math.abs(before) * 0.1));
        const direction: "increase" | "decrease" = before <= 0 ? "increase" : directionParity(meaning);
        const after = direction === "increase" ? before + step : Math.max(0, before - step);
        return {
          meaning: { ...meaning, qualifiers: { ...meaning.qualifiers, [numericKey]: after } },
          factor: {
            kind,
            fieldKey: `qualifiers.${numericKey}`,
            before,
            after,
            direction,
            contribution: MUTATION_CONTRIBUTION[kind],
          },
        };
      }
      return undefined;
    }
    case "actorGeneralization": {
      const before = meaning.subjectKey;
      const after = "someone";
      return {
        meaning: { ...meaning, subjectKey: after },
        factor: { kind, fieldKey: "subjectKey", before, after, direction: "replace", contribution: MUTATION_CONTRIBUTION[kind] },
      };
    }
    case "sourceBlur": {
      const before = meaning.qualifiers.sourceBlurred === true;
      const after = !before;
      return {
        meaning: { ...meaning, qualifiers: { ...meaning.qualifiers, sourceBlurred: after } },
        factor: {
          kind,
          fieldKey: "qualifiers.sourceBlurred",
          before,
          after,
          direction: after ? "increase" : "decrease",
          contribution: MUTATION_CONTRIBUTION[kind],
        },
      };
    }
    case "emphasisShift": {
      const before = meaning.qualifiers.emphasized === true;
      const after = !before;
      return {
        meaning: { ...meaning, qualifiers: { ...meaning.qualifiers, emphasized: after } },
        factor: {
          kind,
          fieldKey: "qualifiers.emphasized",
          before,
          after,
          direction: after ? "increase" : "decrease",
          contribution: MUTATION_CONTRIBUTION[kind],
        },
      };
    }
  }
}

export type GenerateVariantInput = {
  /** 既存fixture catalog + このrunでこれまでに生成された全variantをmergeしたもの(呼び出し側の責務) */
  catalog: ClaimCatalog;
  parent: ClaimVariant;
  claim: InformationClaim;
  /** この一手番で適用された(順序付き)factor */
  appliedFactors: ClaimMutationFactor[];
  nextMeaning: ClaimMeaning;
  tick: number;
  generatorAgentId: string;
  retellingEventId: string;
  limits: InformationPropagationLimits;
  semanticDistanceCeiling: number;
};

export type GenerateVariantResult =
  | { status: "reused"; variant: ClaimVariant }
  | { status: "created"; variant: ClaimVariant }
  | { status: "blocked"; reason: "variantLimit" | "lineageDepthLimit" | "distanceCeiling" };

/**
 * dedup・lineage・上限を守ってvariantを生成/再利用する(§6.3、§8.2)。
 * 1. 正規化済みmeaningのfingerprintが既存variantと一致すれば再利用する(古いvariantを削除・付け替えない)。
 * 2. variant数上限(`limits.maxVariantsPerClaim`)、lineage深さ上限(`limits.maxLineageDepth`)、
 *    root からの累積distance上限(`semanticDistanceCeiling`)のいずれかを超える場合は`blocked`を返す
 *    (呼び出し側はfaithful retellingへfallbackするか、発話自体を見送る)。
 */
export function generateVariant(input: GenerateVariantInput): GenerateVariantResult {
  const fingerprint = computeSemanticFingerprint(input.nextMeaning);
  const existing = findVariantByFingerprint(input.catalog, input.claim.id, fingerprint);
  if (existing) return { status: "reused", variant: existing };

  const existingCount = input.catalog.variants.filter((variant) => variant.canonicalClaimId === input.claim.id).length;
  if (existingCount >= input.limits.maxVariantsPerClaim) return { status: "blocked", reason: "variantLimit" };

  const lineageDepth = input.parent.lineageDepth + 1;
  if (lineageDepth > input.limits.maxLineageDepth) return { status: "blocked", reason: "lineageDepthLimit" };

  const hopDistance = input.appliedFactors.reduce((sum, factor) => sum + factor.contribution, 0);
  const canonicalDistance = input.parent.canonicalDistance + hopDistance;
  if (canonicalDistance > input.semanticDistanceCeiling) return { status: "blocked", reason: "distanceCeiling" };

  const variant: ClaimVariant = {
    id: deriveVariantId(input.claim.id, fingerprint),
    canonicalClaimId: input.claim.id,
    topicId: input.claim.topicId,
    parentVariantId: input.parent.id,
    meaning: input.nextMeaning,
    semanticFingerprint: fingerprint,
    mutationFactors: input.appliedFactors,
    hopDistance,
    canonicalDistance,
    lineageDepth,
    generatedAtTick: input.tick,
    generatorAgentId: input.generatorAgentId,
    retellingEventId: input.retellingEventId,
  };
  return { status: "created", variant };
}

/**
 * runtimeで生成されたvariantをcatalogへ非破壊で追記する(重複IDは無視する)。呼び出し側
 * (`engine.ts`)は毎tick、静的fixture catalogへこれまで生成した全variantをmergeしてから
 * `contentUtterance.ts`/`retelling.ts`へ渡す。
 */
export function mergeGeneratedVariants(catalog: ClaimCatalog, generated: readonly ClaimVariant[]): ClaimCatalog {
  if (generated.length === 0) return catalog;
  const existingIds = new Set(catalog.variants.map((variant) => variant.id));
  const additions = generated.filter((variant) => !existingIds.has(variant.id));
  if (additions.length === 0) return catalog;
  return { ...catalog, variants: [...catalog.variants, ...additions] };
}
