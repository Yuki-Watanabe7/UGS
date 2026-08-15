/**
 * Issue #198 (Phase 3, ステップP3-A): `docs/cluster-transition-phase3-model.md`(Issue #197 ADR)の
 * 1.1節・4節・5節・6.2節で確定した型・観察範囲・パラメータ契約に基づく、他クラスタ関心
 * (`AlternativeClusterInterest`)の純粋関数群。
 *
 * 「今この瞬間に観察できる別の会話クラスタのうち、そこへ移りたいと感じる度合い」を、
 * 現在合流中(`state === "joined"`)のagentについて`[0,1]`の決定的なscoreとして算出する。
 * agentの恒久的traitでも、tickをまたいで蓄積する状態でもない ―― `SimulationState`にも`Agent`にも
 * 保存せず、呼び出し側がそのtickの評価にだけ使う一時的な導出結果(ADR 1.1節)。
 *
 * 対象外(ADR 9節P3-Aの区切り・issue「対象外」節): `engine.ts`のtickループへの結線
 * (このモジュールはまだどこからも呼ばれない)、離脱decisionそのもの・現在クラスタ愛着との合成
 * (#199/#200)、targetへの接近・参加フロー(#201)、任意の人物間好悪行列、話題一致・情報伝播、
 * 接触履歴による長期学習、Canvas・Inspector本実装。
 *
 * 境界(ADR 5節「観察可能情報と全知性の制限」): 引数に`SimulationState`全体を渡さず、
 * 参照してよい情報を明示的に絞る(`AlternativeClusterInterestContext`)。他agentの非公開な
 * 満足度・愛着・stress・willingness等のtraitや、将来の行動・確率は一切参照しない。
 * `isObserverJoiner`もいかなる式にも入力しない(ADR 1.4節)。
 *
 * 決定性・非干渉: すべて純粋関数。rngを一切消費せず、`agent`/`candidates`/`ctx`をmutationしない。
 * 候補配列の順序を入れ替えてもbest targetは変わらない(ADR 1.1.3節のtie-break規則)。
 */
import type { Agent, GroupCandidate } from "./types";
import type { GroupCapacity } from "./formationPolicy";
import { clamp, distance } from "./model";
import { MAX_TIE_CORRECTION, tiePairKey, type TieCorrectionState } from "./relationshipTie";
import type { ClusterTopicRuntimeState } from "./conversationTopic";
import type { ClaimCatalog, TopicCatalog } from "./informationModel";
import type { AgentInformationState } from "./informationState";
import type { TopicIntegrationConfig } from "./topicCompatibility";
import { computeTopicCompatibility, noveltyRatioOf } from "./topicCompatibility";

export type AlternativeClusterInterestFactorKind =
  | "distance"
  | "joinability"
  | "knownParticipant"
  | "cliqueCompatibility"
  | "outsiderBarrier"
  | "recentlyDeparted"
  | "capacityPressure"
  | "informationOpportunity";

export type AlternativeClusterInterestFactor = {
  kind: AlternativeClusterInterestFactorKind;
  /** この要因がscoreへ寄与した分。負の寄与を持つkindでは負値を取る */
  contribution: number;
  /** `knownParticipant`等、特定memberに由来する場合のみ設定する */
  relatedAgentId?: string;
};

export type AlternativeClusterInterest = {
  targetClusterId: string;
  /** 関心を主に駆動したmember(ADR 1.1.1節)。距離・入りやすさだけで選ばれた場合はundefined */
  focusAgentId?: string;
  /** [0,1] */
  score: number;
  /** contribution降順。寄与0のkindは含めない */
  factors: AlternativeClusterInterestFactor[];
  observedAtTick: number;
};

/**
 * `deriveAlternativeClusterInterests`が参照してよい情報だけを持つ読み取り専用contextを渡す
 * (`schoolInterventionRuntime.ts`の`SchoolInterventionContext`と同じ方針、ADR 5.1節)。
 * `SimulationState`/`SimParams`全体は渡さない。
 */
export type AlternativeClusterInterestContext = {
  config: AlternativeClusterInterestConfig;
  tick: number;
  /** memberIdsの`cliqueId`(公開属性)解決にのみ使う。他agentの非公開traitへはアクセスしない */
  agents: Agent[];
  /** `SimParams.existingTieStrength` */
  existingTieStrength: number;
  /** `FormationPolicy.resolveGroupCapacity`をこの候補についてbindしたもの */
  resolveCapacity: (candidate: GroupCandidate) => GroupCapacity;
  /**
   * Phase 4(`relationshipTie.ts`)の観測者→話者ペア補正(存在する場合のみ、ADR 1.1.2節)。
   * 未指定/該当なしは常に中立(0)として扱う。
   */
  tieCorrections?: TieCorrectionState;
  /**
   * Issue #233 (Phase 5): 情報探索関心(`informationOpportunity` factor)の評価に使う、observation
   * 可能な情報だけの束。未設定(既定)ならこのfactorは一切計算されない(既存挙動と同一、後方互換)。
   * `agentInformation`はこのagent自身の情報state ―― target側の非公開claim stateは一切渡さない
   * (ADR 5節と同じ「観察可能情報の制限」)。
   */
  topicIntegration?: {
    config: TopicIntegrationConfig;
    /** target clusterの公開topic runtime state(clusterId -> state) */
    clusterTopicRuntime: ClusterTopicRuntimeState;
    topicCatalog: TopicCatalog;
    claimCatalog: ClaimCatalog;
    agentInformation: AgentInformationState | undefined;
    fatigueGain: number;
    fatigueDecay: number;
  };
};

export type AlternativeClusterInterestConfig = {
  /** この距離を超えるclusterは候補集合に入れない(> 0) */
  observationRadius: number;
  /** 距離寄与の減衰スケール(> 0) */
  distanceDecayRadius: number;
  /** distance factorの上限寄与 [0,1] */
  distanceWeight: number;
  /** 既知member(tie補正)による上限寄与 [0,1] */
  knownParticipantWeight: number;
  /** 同clique比率による上限寄与 [0,1] */
  cliqueCompatibilityWeight: number;
  /** 単一cliqueに占有された輪への減点上限 [0,1] */
  outsiderBarrierPenaltyCap: number;
  /** 満員に近いことによる減点上限 [0,1] */
  capacityPressurePenaltyCap: number;
  /** 直前に自分が離脱した輪への減点 [0,1] */
  recentlyDepartedPenalty: number;
  /** これ未満の関心では`selectBestAlternativeCluster`がtargetなしを返す [0,1] */
  minTargetInterestScore: number;
  /** 評価対象の上限。観察半径内の候補がこれを超える場合は距離昇順で切り捨てる(正整数) */
  maxTrackedCandidates: number;
};

// joinability factorの内訳(status差)。ADR 6.2節の一覧には無い実装Issue決定の内部定数
// (issue要件8節は「少なくとも」の一覧であり、joinability自体の重みを設定化するとは求めていない)。
// forming候補はまだ人を募っている最中で「入れる見込み」が高く、confirmed候補は既に一段落した輪という
// 既存の`attractiveness()`の非対称(forming/confirmedで式を分ける)と同じ方向性を、小さい正の値で表す。
const JOINABILITY_FORMING_BONUS = 0.15;
const JOINABILITY_CONFIRMED_BONUS = 0.08;
// 残り枠が1以下(=次の1人でちょうど満員になる)場合、単純な占有率だけでは表現しきれない
// 「到着前に満員化するリスク」をcapacityPressureへ追加で織り込む係数(要件5節)
const IMMINENT_FULL_RISK_WEIGHT = 0.3;

export const DEFAULT_ALTERNATIVE_CLUSTER_INTEREST_CONFIG: AlternativeClusterInterestConfig = {
  // 既存のtie観測範囲(`TIE_OBSERVATION_RANGE` = `DEFAULT_SPEECH_RANGE` = 200)よりやや広い程度に留め、
  // 「画面全体を無条件に知る」モデルにしない(issue要件2節)
  observationRadius: 220,
  // 既定では観察半径の端でちょうど寄与0になるよう観察半径と揃える(境界での不連続を避ける)
  distanceDecayRadius: 220,
  distanceWeight: 0.3,
  knownParticipantWeight: 0.25,
  cliqueCompatibilityWeight: 0.2,
  outsiderBarrierPenaltyCap: 0.2,
  capacityPressurePenaltyCap: 0.15,
  recentlyDepartedPenalty: 0.2,
  // 単発の弱い寄与(例: distanceだけがわずかに正)だけではtargetに選ばれない程度の中庸値
  minTargetInterestScore: 0.35,
  maxTrackedCandidates: 20,
};

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`alternativeClusterInterest config: ${name} must be a finite number (got ${value})`);
  }
}

function assertPositive(name: string, value: number): void {
  assertFinite(name, value);
  if (value <= 0) {
    throw new Error(`alternativeClusterInterest config: ${name} must be > 0 (got ${value})`);
  }
}

function assertRange01(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0 || value > 1) {
    throw new Error(`alternativeClusterInterest config: ${name} must be within [0, 1] (got ${value})`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  assertFinite(name, value);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`alternativeClusterInterest config: ${name} must be a positive integer (got ${value})`);
  }
}

/**
 * NaN/Infinity・範囲外・不正な整数を明示的に拒否する(`conversationSatisfaction.ts`/
 * `clusterDepartureDecision.ts`と同じ方針。domain layerを最終防衛線とする)。
 */
export function validateAlternativeClusterInterestConfig(config: AlternativeClusterInterestConfig): void {
  assertPositive("observationRadius", config.observationRadius);
  assertPositive("distanceDecayRadius", config.distanceDecayRadius);
  assertRange01("distanceWeight", config.distanceWeight);
  assertRange01("knownParticipantWeight", config.knownParticipantWeight);
  assertRange01("cliqueCompatibilityWeight", config.cliqueCompatibilityWeight);
  assertRange01("outsiderBarrierPenaltyCap", config.outsiderBarrierPenaltyCap);
  assertRange01("capacityPressurePenaltyCap", config.capacityPressurePenaltyCap);
  assertRange01("recentlyDepartedPenalty", config.recentlyDepartedPenalty);
  assertRange01("minTargetInterestScore", config.minTargetInterestScore);
  assertPositiveInteger("maxTrackedCandidates", config.maxTrackedCandidates);
}

validateAlternativeClusterInterestConfig(DEFAULT_ALTERNATIVE_CLUSTER_INTEREST_CONFIG);

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** そのクラスタ候補で最も多い`cliqueId`とその占有率(`engine.ts`の`dominantClique`と同じ計算だが、
 * `alternativeClusterInterest.ts`は`engine.ts`から独立させる方針(ADRが#185で確立した
 * 「同一関数にしない」判断を踏襲、将来`engine.ts`がこのモジュールを呼ぶ側になるため循環を避ける)
 * のためここで小さく再実装する。 */
function dominantCliqueAmongMembers(memberIds: string[], agents: Agent[]): { cliqueId: number; ratio: number } | undefined {
  if (memberIds.length === 0) return undefined;
  const counts = new Map<number, number>();
  for (const id of memberIds) {
    const cliqueId = agents.find((a) => a.id === id)?.cliqueId;
    if (cliqueId !== undefined) counts.set(cliqueId, (counts.get(cliqueId) ?? 0) + 1);
  }
  let bestId: number | undefined;
  let bestCount = 0;
  for (const [cliqueId, count] of counts) {
    if (count > bestCount) {
      bestId = cliqueId;
      bestCount = count;
    }
  }
  return bestId === undefined ? undefined : { cliqueId: bestId, ratio: bestCount / memberIds.length };
}

/** 自分以外のmemberのうち、自分と同じcliqueに属する比率。`cliqueId`未設定なら常に0 */
function cliqueMateRatio(agent: Agent, memberIds: string[], agents: Agent[]): number {
  if (agent.cliqueId === undefined || memberIds.length === 0) return 0;
  const matches = memberIds.filter((id) => agents.find((a) => a.id === id)?.cliqueId === agent.cliqueId).length;
  return matches / memberIds.length;
}

/**
 * `tieCorrections`から、関心を最も強く押し上げる正の補正を持つmemberを1人選ぶ
 * (ADR 1.1.3節: 同点はmemberId昇順でtie-break、負・0の補正は「既知member」とみなさない)。
 */
function bestKnownParticipant(
  agentId: string,
  memberIds: string[],
  tieCorrections: TieCorrectionState | undefined,
): { memberId: string; correction: number } | undefined {
  if (!tieCorrections) return undefined;
  let best: { memberId: string; correction: number } | undefined;
  for (const memberId of [...memberIds].sort()) {
    const correction = tieCorrections[tiePairKey(agentId, memberId)] ?? 0;
    if (correction <= 0) continue;
    if (!best || correction > best.correction) {
      best = { memberId, correction };
    }
  }
  return best;
}

function isCandidateAtCapacity(candidate: GroupCandidate, capacity: GroupCapacity): boolean {
  return candidate.memberIds.length >= capacity.maxGroupSize;
}

/**
 * 満員に近いことによる負の寄与(要件5節: 容量無制限でも発散しない、満員直前のリスクを扱える)。
 * `maxGroupSize`が無制限(`Number.POSITIVE_INFINITY`、standingPartyの既定)なら常に0。
 */
function computeCapacityPressureContribution(
  candidate: GroupCandidate,
  capacity: GroupCapacity,
  config: AlternativeClusterInterestConfig,
): number {
  if (!Number.isFinite(capacity.maxGroupSize) || capacity.maxGroupSize <= 0) return 0;
  const occupancyRatio = clamp01(candidate.memberIds.length / capacity.maxGroupSize);
  const remaining = capacity.maxGroupSize - candidate.memberIds.length;
  const imminentRisk = remaining <= 1 ? IMMINENT_FULL_RISK_WEIGHT : 0;
  return config.capacityPressurePenaltyCap * clamp01(occupancyRatio + imminentRisk);
}

function scoreObservedCandidate(
  agent: Agent,
  candidate: GroupCandidate,
  dist: number,
  capacity: GroupCapacity,
  ctx: AlternativeClusterInterestContext,
): AlternativeClusterInterest {
  const { config } = ctx;
  const tieStrength = clamp01(ctx.existingTieStrength);
  const factors: AlternativeClusterInterestFactor[] = [];

  const distanceContribution = config.distanceWeight * clamp01(1 - dist / config.distanceDecayRadius);
  if (distanceContribution > 0) factors.push({ kind: "distance", contribution: distanceContribution });

  const joinabilityContribution = candidate.status === "forming" ? JOINABILITY_FORMING_BONUS : JOINABILITY_CONFIRMED_BONUS;
  factors.push({ kind: "joinability", contribution: joinabilityContribution });

  const cliqueRatio = cliqueMateRatio(agent, candidate.memberIds, ctx.agents);
  const cliqueCompatibilityContribution = config.cliqueCompatibilityWeight * cliqueRatio * tieStrength;
  if (cliqueCompatibilityContribution > 0) {
    factors.push({ kind: "cliqueCompatibility", contribution: cliqueCompatibilityContribution });
  }

  const dominant = dominantCliqueAmongMembers(candidate.memberIds, ctx.agents);
  let outsiderBarrierContribution = 0;
  if (dominant !== undefined && dominant.cliqueId !== agent.cliqueId) {
    const dominanceBeyondHalf = clamp01((dominant.ratio - 0.5) * 2);
    outsiderBarrierContribution = config.outsiderBarrierPenaltyCap * dominanceBeyondHalf * tieStrength;
    if (outsiderBarrierContribution > 0) {
      factors.push({ kind: "outsiderBarrier", contribution: -outsiderBarrierContribution });
    }
  }

  const capacityPressureContribution = computeCapacityPressureContribution(candidate, capacity, config);
  if (capacityPressureContribution > 0) {
    factors.push({ kind: "capacityPressure", contribution: -capacityPressureContribution });
  }

  const recentlyDepartedContribution = agent.lastDepartedClusterId === candidate.id ? config.recentlyDepartedPenalty : 0;
  if (recentlyDepartedContribution > 0) {
    factors.push({ kind: "recentlyDeparted", contribution: -recentlyDepartedContribution });
  }

  const known = bestKnownParticipant(agent.id, candidate.memberIds, ctx.tieCorrections);
  let knownParticipantContribution = 0;
  let focusAgentId: string | undefined;
  if (known !== undefined) {
    knownParticipantContribution = config.knownParticipantWeight * clamp01(known.correction / MAX_TIE_CORRECTION);
    if (knownParticipantContribution > 0) {
      factors.push({ kind: "knownParticipant", contribution: knownParticipantContribution, relatedAgentId: known.memberId });
      focusAgentId = known.memberId;
    }
  }

  // Issue #233 (Phase 5): `ctx.topicIntegration`未設定なら一切計算しない(既存挙動と完全に同一、
  // rawScoreへの寄与も常に0)。target clusterの公開topic runtime stateとagent自身のinformation state
  // だけを使う(他agentの非公開claim stateは一切参照しない)。
  let informationOpportunityContribution = 0;
  if (ctx.topicIntegration) {
    const { config: topicConfig, clusterTopicRuntime, topicCatalog, claimCatalog, agentInformation, fatigueGain, fatigueDecay } =
      ctx.topicIntegration;
    const compatibility = computeTopicCompatibility({
      config: topicConfig.compatibility,
      tick: ctx.tick,
      clusterId: candidate.id,
      clusterTopic: clusterTopicRuntime[candidate.id],
      topicCatalog,
      claimCatalog,
      agentInformation,
      fatigueGain,
      fatigueDecay,
    });
    informationOpportunityContribution = topicConfig.informationSeekingWeight * noveltyRatioOf(compatibility);
    if (informationOpportunityContribution > 0) {
      factors.push({ kind: "informationOpportunity", contribution: informationOpportunityContribution });
    }
  }

  const rawScore =
    distanceContribution +
    joinabilityContribution +
    cliqueCompatibilityContribution +
    knownParticipantContribution +
    informationOpportunityContribution -
    outsiderBarrierContribution -
    capacityPressureContribution -
    recentlyDepartedContribution;

  factors.sort((a, b) => b.contribution - a.contribution);

  return {
    targetClusterId: candidate.id,
    focusAgentId,
    score: clamp01(rawScore),
    factors,
    observedAtTick: ctx.tick,
  };
}

/**
 * 合流中(`state === "joined"`)のagentが、`state.groupCandidates`のスナップショットから観察可能な
 * 他クラスタを列挙し、決定的な関心scoreを算出する(issue要件2〜7節)。`candidates`/`agent`/`ctx`を
 * 一切mutationせず、rngを消費しない。候補配列の順序を入れ替えても返り値の集合・各値は変わらない。
 *
 * 除外条件(要件2節): 現在クラスタ自身(`candidate.id === agent.joinedGroupId`)、forming/confirmed
 * 以外(dissolving/dissolved/expired)、容量上限に達したもの、観察半径外。
 * `maxTrackedCandidates`を超える場合は距離昇順(同着は`candidate.id`昇順)で切り捨てる(ADR 5.3節)。
 */
export function deriveAlternativeClusterInterests(
  agent: Agent,
  candidates: GroupCandidate[],
  ctx: AlternativeClusterInterestContext,
): AlternativeClusterInterest[] {
  const { config } = ctx;

  const observed: { candidate: GroupCandidate; dist: number; capacity: GroupCapacity }[] = [];
  for (const candidate of candidates) {
    if (candidate.id === agent.joinedGroupId) continue;
    if (candidate.status !== "forming" && candidate.status !== "confirmed") continue;
    const capacity = ctx.resolveCapacity(candidate);
    if (isCandidateAtCapacity(candidate, capacity)) continue;
    const dist = distance(agent.x, agent.y, candidate.x, candidate.y);
    if (dist > config.observationRadius) continue;
    observed.push({ candidate, dist, capacity });
  }

  observed.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
  });

  return observed
    .slice(0, config.maxTrackedCandidates)
    .map(({ candidate, dist, capacity }) => scoreObservedCandidate(agent, candidate, dist, capacity, ctx));
}

/**
 * 関心一覧から最良targetを選ぶ純粋関数(issue要件7節)。score降順、同点は`targetClusterId`昇順で
 * tie-break(ADR 1.1.3節)。`minTargetInterestScore`未満ならtargetなし(undefined)を返す。
 * `interests`をmutationせず、rngを消費しない。配列順序を入れ替えても結果は変わらない。
 */
export function selectBestAlternativeCluster(
  interests: AlternativeClusterInterest[],
  minTargetInterestScore: number,
): AlternativeClusterInterest | undefined {
  if (interests.length === 0) return undefined;

  const sorted = [...interests].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.targetClusterId < b.targetClusterId ? -1 : a.targetClusterId > b.targetClusterId ? 1 : 0;
  });

  const best = sorted[0];
  return best.score >= minTargetInterestScore ? best : undefined;
}
