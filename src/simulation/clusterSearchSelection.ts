/**
 * Issue #250 (Phase 6 P6-D, standingParty, roadmap #172): `docs/spatial-dynamics-phase6-model.md`
 * (Issue #246 ADR)の§5(cluster候補選択の一般化)に基づく、通常再探索
 * (`state === "undecided"`かつ`pendingClusterTransition`を持たない、または無効化された後の
 * agent)の候補選択を、`nearestCandidate()`による最寄り1件選択から、観察半径内の複数候補を
 * 総合scoreで比較する形へ一般化する純粋関数群。
 *
 * 責務範囲(issue「実装範囲」節): 候補列挙(1) + score contract(2) + distance factor(3) +
 * social/Phase3/topic factorの統合(4, 5) + spatial factor(6) + approach vs continue roamingの
 * 境界(7)。pendingClusterTransitionの優先契約(8)はengine.ts側が担い、このモジュールは呼び出し時点で
 * 既にpendingTransitionが無い/無効化されていることを前提にする(ADR§5.5、変更しない)。
 *
 * 二重加算を避けるための設計(ADR§5.4、issue要件4節「既存social factorを二重加算しない」):
 *  - `socialAttractiveness`はengine.tsの`attractiveness()`をそのまま呼んだ結果を**呼び出し側が
 *    計算して渡す**(このモジュール自身は再実装しない)。engine.tsが本モジュールをimportする以上、
 *    本モジュールがengine.tsをimportすると循環参照になるため(`alternativeClusterInterest.ts`が
 *    同じ理由で`dominantClique`を独自に持つのと同じ事情)、値渡しで責務を分離する。
 *  - `alternativeInterest`/`informationOpportunity`は`alternativeClusterInterest.ts`の
 *    `deriveAlternativeClusterInterests`を1候補ずつ呼び出し、その`factors`から
 *    `knownParticipant`+`cliqueCompatibility`(既知member・clique適合そのもの)、
 *    `informationOpportunity`だけを抜き出す。同関数が返す`distance`/`joinability`/
 *    `outsiderBarrier`/`capacityPressure`/`recentlyDeparted`は、本モジュールの`distance`/
 *    `socialAttractiveness`(outsiderBarrierは`attractiveness()`側の同clique占有度penaltyと同じ
 *    概念)/`recentVisitPenalty`と重複するため使わない。
 *  - `crowdingPenalty`/`spatialExplorationBonus`は`spatialOccupancy.ts`(#249)のcrowding fieldが
 *    agent中心の押し出しvectorであり候補位置評価に転用しづらいため、同じ「距離重み付き局所密度」の
 *    考え方だけを候補位置中心に再計算する(#249のconfig値`crowdSampleRadius`/`crowdDensityThreshold`/
 *    `crowdClusterCenterWeight`を再利用し、新規config項目を増やさない)。
 *  - `recentVisitPenalty`は既存の`lastFailedCandidateId`/`lastDepartedClusterId`によるハード除外
 *    (cooldown期間中は列挙段階で除外、二重防御として維持)に加え、cooldown期間が過ぎた直後の
 *    弱い残存penaltyとして表現する(ADR§5.4「既存cooldownをscore減点としても表現する」)。
 *
 * 決定性(ADR§9.3「候補列挙・総合score・argmaxはrngを消費しない」): このファイルの関数はすべて
 * 純粋関数でrngを一切消費せず、`agent`/`candidates`/`agents`をmutationしない。列挙は距離昇順
 * (同着は`id`昇順)、選択はscore降順(同点は`clusterId`昇順)で決定するため、入力配列の並び順に
 * 依存しない(issue要件10節「candidate配列順を変えても結果一致」)。
 *
 * 全知性の制限(issue要件2節「Agentの非公開情報を全知的に参照しない」): このモジュールが直接読む
 * agent情報は自分自身の公開属性(`x`/`y`/`lastFailedCandidateId`/`lastDepartedClusterId`)のみ。
 * 他agentの非公開traitは`deriveAlternativeClusterInterests`経由でその関数自身の境界(観察可能情報
 * のみ)に従う。
 */
import type { Agent, GroupCandidate } from "./types";
import type { GroupCapacity } from "./formationPolicy";
import { clamp, distance } from "./model";
import type { SpatialDynamicsConfig } from "./spatialDynamics";
import { deriveAlternativeClusterInterests } from "./alternativeClusterInterest";
import type { AlternativeClusterInterestContext } from "./alternativeClusterInterest";

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

// --- candidate enumeration (issue実装範囲1節) --------------------------------------------------

export type EnumeratedClusterSearchCandidate = {
  candidate: GroupCandidate;
  dist: number;
};

/**
 * `isJoinable`(engine.ts)と同じstatus/capacity条件を、循環import回避のためここで独立に判定する
 * (`alternativeClusterInterest.ts`の`isCandidateAtCapacity`と同じ方針)。
 */
function isCandidateSearchable(candidate: GroupCandidate, capacity: GroupCapacity): boolean {
  if (candidate.status !== "forming" && candidate.status !== "confirmed") return false;
  return candidate.memberIds.length < capacity.maxGroupSize;
}

/**
 * join可能なclusterを観察半径内から列挙する(issue実装範囲1節)。
 * - 既存`isJoinable`相当のstatus/capacity条件を維持する
 * - `cooldownExcludeIds`(`lastFailedCandidateId`/`lastDepartedClusterId`のcooldown中)を維持する
 * - `agent.joinedGroupId`と一致する候補(current/source cluster)は誤って候補へ戻さない
 * - `candidateSelectionObservationRadius`の外側は候補にしない
 * - 距離昇順(同着は`candidate.id`昇順)でソートし、`candidateSelectionMaxObserved`で切り捨てる
 *   (ADR§5.2「上限で切り捨てる」、`maxTrackedCandidates`と同じ方針)
 *
 * rngを消費せず、`candidates`をmutationしない。`candidates`配列の元の順序には依存しない。
 */
export function enumerateClusterSearchCandidates(
  agent: Agent,
  candidates: readonly GroupCandidate[],
  capacityOf: (candidate: GroupCandidate) => GroupCapacity,
  cooldownExcludeIds: ReadonlySet<string> | undefined,
  config: SpatialDynamicsConfig,
): EnumeratedClusterSearchCandidate[] {
  const observed: EnumeratedClusterSearchCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.id === agent.joinedGroupId) continue;
    if (cooldownExcludeIds?.has(candidate.id)) continue;
    if (!isCandidateSearchable(candidate, capacityOf(candidate))) continue;
    const dist = distance(agent.x, agent.y, candidate.x, candidate.y);
    if (dist > config.candidateSelectionObservationRadius) continue;
    observed.push({ candidate, dist });
  }

  observed.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
  });

  return observed.slice(0, config.candidateSelectionMaxObserved);
}

// --- score contract (issue実装範囲2節) ----------------------------------------------------------

export type ClusterSearchCandidateFactors = {
  distance: number;
  socialAttractiveness: number;
  alternativeInterest?: number;
  informationOpportunity?: number;
  crowdingPenalty?: number;
  recentVisitPenalty?: number;
  spatialExplorationBonus?: number;
};

export type ClusterSearchCandidateScore = {
  clusterId: string;
  eligible: boolean;
  score: number;
  factors: ClusterSearchCandidateFactors;
};

// --- spatial factor (issue実装範囲6節、#249のconfig値を再利用) -----------------------------------

/** `spatialOccupancy.ts`の`isCrowdingDensitySource`と同じallowlist(循環import回避のため再実装) */
function isDensitySourceAgent(agent: Agent): boolean {
  return (
    agent.state === "undecided" ||
    agent.state === "approaching" ||
    agent.state === "forming" ||
    agent.state === "joined"
  );
}

/**
 * 候補位置を中心とした距離重み付き局所密度(方向成分を持たないスカラー版、issue要件6節
 * 「candidate centerのlocal densityはruntime座標から導出する」)。候補自身のmemberは
 * 「輪の中にいるのは混雑ではない」という#249 ADR§4.3の理由をそのまま踏襲し除外する。
 */
function computeLocalDensityAtCandidate(
  candidate: GroupCandidate,
  agents: readonly Agent[],
  candidates: readonly GroupCandidate[],
  config: SpatialDynamicsConfig,
): number {
  let density = 0;
  for (const other of agents) {
    if (!isDensitySourceAgent(other)) continue;
    if (other.joinedGroupId === candidate.id) continue;
    const d = distance(candidate.x, candidate.y, other.x, other.y);
    if (d >= config.crowdSampleRadius) continue;
    density += 1 - d / config.crowdSampleRadius;
  }
  for (const other of candidates) {
    if (other.status !== "confirmed" || other.id === candidate.id) continue;
    const d = distance(candidate.x, candidate.y, other.x, other.y);
    if (d >= config.crowdSampleRadius) continue;
    density += (1 - d / config.crowdSampleRadius) * config.crowdClusterCenterWeight;
  }
  return density;
}

// --- scoring (issue実装範囲3〜6節) --------------------------------------------------------------

export type ClusterSearchScoringExtras = {
  agents: readonly Agent[];
  candidates: readonly GroupCandidate[];
  /**
   * Issue #198/#233: 既知member・clique適合・topic機会の評価に使う、`deriveAlternativeClusterInterests`
   * 用のcontext。未指定(既定)なら`alternativeInterest`/`informationOpportunity`は常にundefined
   * (寄与0)になる ―― `standingPartyConfig.transition.enabled`が false の間の既存挙動と同じ境界。
   */
  alternativeInterestCtx?: AlternativeClusterInterestContext;
};

/**
 * 1候補についての構造化scoreを計算する(issue実装範囲2〜6節)。`socialAttractiveness`は
 * 呼び出し側が`engine.ts`の`attractiveness()`で計算済みの値を渡す(このモジュールは再実装しない、
 * ファイル冒頭コメント参照)。純粋関数でrngを消費せず、引数をmutationしない。
 */
export function computeClusterSearchCandidateScore(
  agent: Agent,
  candidate: GroupCandidate,
  dist: number,
  socialAttractiveness: number,
  config: SpatialDynamicsConfig,
  extras: ClusterSearchScoringExtras,
): ClusterSearchCandidateScore {
  // distance factor(issue実装範囲3節): 0距離で有限、観察半径端で滑らかに0へ収束する線形penalty
  const distanceContribution =
    config.candidateSelectionDistanceWeight * clamp01(1 - dist / config.candidateSelectionObservationRadius);
  const socialContribution = config.candidateSelectionSocialWeight * socialAttractiveness;

  let alternativeInterest: number | undefined;
  let informationOpportunity: number | undefined;
  if (extras.alternativeInterestCtx) {
    const [interest] = deriveAlternativeClusterInterests(agent, [candidate], extras.alternativeInterestCtx);
    if (interest) {
      const tieContribution = interest.factors
        .filter((f) => f.kind === "knownParticipant" || f.kind === "cliqueCompatibility")
        .reduce((sum, f) => sum + f.contribution, 0);
      if (tieContribution > 0) {
        alternativeInterest = config.candidateSelectionAlternativeInterestWeight * clamp01(tieContribution);
      }
      const infoContribution = interest.factors.find((f) => f.kind === "informationOpportunity")?.contribution ?? 0;
      if (infoContribution > 0) {
        informationOpportunity = config.candidateSelectionTopicOpportunityWeight * clamp01(infoContribution);
      }
    }
  }

  // spatial factor(issue実装範囲6節): 同じ局所密度から、過密なら減点・閑散としていれば小さな加点を
  // 導く(「遠いほど常に良い」という単純な外向きbonusにはしない ―― 密度だけを見る)
  const density = computeLocalDensityAtCandidate(candidate, extras.agents, extras.candidates, config);
  const threshold = Math.max(config.crowdDensityThreshold, 1e-6);
  let crowdingPenalty: number | undefined;
  let spatialExplorationBonus: number | undefined;
  if (density > threshold) {
    crowdingPenalty = config.candidateSelectionCrowdingPenalty * clamp01((density - threshold) / threshold);
  } else {
    spatialExplorationBonus = config.candidateSelectionExplorationWeight * clamp01(1 - density / threshold);
  }

  // recentlyDepartedOrFailedPenalty(issue実装範囲7節): cooldown期間中は列挙段階で既に除外済み
  // (二重防御)。ここでは「同一候補」であること自体への弱い残存penaltyとして表現する。
  let recentVisitPenalty: number | undefined;
  if (agent.lastFailedCandidateId === candidate.id || agent.lastDepartedClusterId === candidate.id) {
    recentVisitPenalty = config.candidateSelectionCooldownPenalty;
  }

  const score = clamp01(
    socialContribution +
      distanceContribution +
      (alternativeInterest ?? 0) +
      (informationOpportunity ?? 0) +
      (spatialExplorationBonus ?? 0) -
      (crowdingPenalty ?? 0) -
      (recentVisitPenalty ?? 0),
  );

  return {
    clusterId: candidate.id,
    eligible: true,
    score,
    factors: {
      distance: distanceContribution,
      socialAttractiveness: socialContribution,
      alternativeInterest,
      informationOpportunity,
      crowdingPenalty,
      recentVisitPenalty,
      spatialExplorationBonus,
    },
  };
}

// --- approach vs continue roaming (issue実装範囲7節) ---------------------------------------------

/**
 * 評価済みscoreからbest candidateを選ぶ(ADR§5.2「観察半径内の候補列挙 + 総合score最大」)。
 * score降順、同点は`clusterId`昇順でtie-break(決定的)。best scoreが`minScore`未満なら
 * `undefined`(=候補なし、呼び出し側でroaming継続)を返す ―― 案3(確率的な探索継続)をrngなしで
 * 内包する(ADR§5.3)。高score候補ほど選択確率が下がることはない(softmax/weighted choiceを使わない
 * 決定的argmaxのため)。`scores`をmutationせず、配列順序を入れ替えても結果は変わらない。
 */
export function pickBestClusterSearchCandidate(
  scores: readonly ClusterSearchCandidateScore[],
  minScore: number,
): ClusterSearchCandidateScore | undefined {
  if (scores.length === 0) return undefined;

  const sorted = [...scores].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0;
  });

  const best = sorted[0];
  return best.score >= minScore ? best : undefined;
}
