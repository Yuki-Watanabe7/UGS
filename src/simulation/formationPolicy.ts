import type { ApproachFailureReason, Agent, GroupCandidate, SimParams, SimulationFinishReason } from "./types";
import { clamp, distance } from "./model";

/**
 * Issue #130 (Phase 1): シナリオごとに差し替え可能な「グループ形成・終了ルール」の集合。
 * 現状は二次会シナリオ(`afterParty`)のみが存在するが、学校のペア・班作り等の将来シナリオを
 * `scenarioId`分岐でengine.ts本体に散らすのではなく、この境界を実装する新しい
 * `FormationPolicy`を追加することで対応できるようにする。
 *
 * engine.ts側は責務ごとに以下のいずれかを呼ぶだけで、個々の判定式(しきい値・確率式)は
 * 一切知らない:
 *   1. 新しい候補(核)を作れるか・その基礎確率        -> evaluateCandidateInitiation
 *   2. 候補への接近確率の基礎倍率                    -> approachRateMultiplier
 *   3. 候補が成立(confirmed)する条件                -> shouldConfirmCandidate
 *      (未成立のまま解散/期限切れになる条件も含む)   -> evaluateUnconfirmedCandidateLifecycle
 *   4. エージェントが場から退出できるか              -> canLeave
 *      (退出判断に至るストレス蓄積の基礎式)          -> computeStressIncrement
 *   5. シミュレーション全体の終了条件                -> isFinished
 *   6. 候補の成立最小人数・収容最大人数(Issue #131)  -> resolveGroupCapacity
 *   7. 候補の成立判定に使う"集まった人数"の数え方     -> computeConfirmationCount
 *   8. 参加失敗(満員等)によるこのtickの追加stress増分 -> computeJoinFailureStressIncrement (Issue #133)
 *
 * 介入シナリオ(`interventions.ts`の`InterventionScenarioId`)はこれとは独立した軸であり、
 * ここでは一切参照しない。介入による確率・しきい値の補正は、従来どおりengine.ts側で
 * policyが返した基礎値に対して適用する(受入条件: engine内に学校シナリオ固有の分岐を先取りしない
 * ―― 同時に、既存の介入分岐もこのファイルへは持ち込まない)。
 *
 * Issue #132 (Phase 2): `classroomPair`は「教室で先生が自由にペアを作るよう指示する」シナリオ。
 * 定員2固定(min=max=2)・退出不可(canLeaveは常にfalse)・全員割当またはformationDeadlineTick到達で
 * 終了、という点でafterPartyと大きく異なるが、既存のinitiative/influenceAvoidance/conformity/
 * clique/stressの各エージェントフィールドとengine.tsの核形成→接近→合流のtickループ自体は再利用する。
 *
 * Issue #154 (Phase 4): `classroomPair`の2人固定ロジックを、任意の`GroupSizeRule`(固定/可変定員)を
 * 受け取る学校向けpolicy factory(`createClassroomGroupPolicy`)へ一般化した。内部IDは引き続き
 * `classroomPair`のまま(新しいscenarioIdは追加しない)で、`FormationRuntimeOptions.classroomGroupSize`
 * 省略時は`DEFAULT_CLASSROOM_PAIR_GROUP_SIZE`(2人固定)へ後方互換のfall backをする。こうすることで、
 * engine.ts側の`formationPolicy.id === "classroomPair"`分岐(メッセージ文言・deadline処理)を
 * 一切増やさずに固定3人/4人班・3〜4人可変定員班まで同じ形成ルール境界で表現できる
 * (受入条件: engineへ学校の班人数別条件分岐が散在していない)。
 *
 * Issue #174 (Phase 1): `standingParty`は「立食パーティーで、参加者が会話の輪を探し・離脱し・
 * 再探索する」シナリオ。#173のADR(`docs/interaction-cluster-model.md`)が採用した案3
 * (共通基底+シナリオ別ライフサイクル)に従い、`GroupCandidate`型は変更せず、成立後の会話クラスタが
 * 増減・再形成する挙動(ADRの責務9「クラスタ離脱判定」・責務10「確定後ライフサイクル」)は
 * 後続Issue(Follow-up A/B/C)で`FormationPolicy`へ追加実装する。**本Issueではその2責務を実装しない**
 * ため、`standingPartyPolicy`は成立(confirmed)後のクラスタが最終形になる点で暫定的に`afterParty`と
 * 同じ形成力学(核形成・接近・成立・未成立候補の解散/期限切れ)を再利用する。これは`afterParty`への
 * 黙示的なエイリアスではなく、`id: "standingParty"`を持つ独立した`FormationPolicy`実装であり、
 * 後続IssueがADRの責務9/10だけを追加すれば済むよう、意図的に明示している(受入条件: 未実装の後続機能を
 * afterPartyの挙動へ黙ってaliasしない)。
 */
export type FormationScenarioId = "afterParty" | "classroomPair" | "standingParty";

/** Issue #154: 候補の成立最小人数・収容最大人数のペア。`minGroupSize === maxGroupSize`なら固定定員 */
export type GroupSizeRule = {
  minGroupSize: number;
  maxGroupSize: number;
};

/** Issue #154: `rule`が固定定員(min === max)かどうか */
export function isFixedGroupSizeRule(rule: GroupSizeRule): boolean {
  return rule.minGroupSize === rule.maxGroupSize;
}

/** Issue #154: `createClassroomGroupPolicy`へ渡す、学校向け形成設定のまとまり */
export type ClassroomGroupFormationOptions = {
  groupSize: GroupSizeRule;
  formationDeadlineTick: number;
};

/** `classroomGroupSize`省略時に使う既定値(既存`classroomPair`と同じ2人固定) */
export const DEFAULT_CLASSROOM_PAIR_GROUP_SIZE: GroupSizeRule = { minGroupSize: 2, maxGroupSize: 2 };

/**
 * Issue #154: 学校向け形成設定を初期化時に検証する。不正値を黙って実行しない(受入条件)。
 * - `minGroupSize`は2以上の整数
 * - `maxGroupSize`は`minGroupSize`以上の有限な整数(学校シナリオは実質無制限の定員を持たない)
 * - `formationDeadlineTick`は正の整数
 */
function validateClassroomGroupFormationOptions(options: ClassroomGroupFormationOptions): void {
  const { groupSize, formationDeadlineTick } = options;
  if (!Number.isInteger(groupSize.minGroupSize) || groupSize.minGroupSize < 2) {
    throw new Error(`classroomGroupSize.minGroupSize must be an integer >= 2 (got ${groupSize.minGroupSize})`);
  }
  if (!Number.isFinite(groupSize.maxGroupSize) || !Number.isInteger(groupSize.maxGroupSize)) {
    throw new Error(`classroomGroupSize.maxGroupSize must be a finite integer (got ${groupSize.maxGroupSize})`);
  }
  if (groupSize.maxGroupSize < groupSize.minGroupSize) {
    throw new Error(
      `classroomGroupSize.maxGroupSize (${groupSize.maxGroupSize}) must be >= minGroupSize (${groupSize.minGroupSize})`,
    );
  }
  if (!Number.isInteger(formationDeadlineTick) || formationDeadlineTick <= 0) {
    throw new Error(`formationDeadlineTick must be a positive integer (got ${formationDeadlineTick})`);
  }
}

/** `createInitialState`/`stepSimulation`に形成ポリシーを指定する際の実行時オプション */
export type FormationRuntimeOptions = {
  scenarioId: FormationScenarioId;
  /**
   * Issue #132: `classroomPair`固有の、全員割当に至らなくても強制終了するtick数。
   * `classroomPair`以外では無視される。省略時は`DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK`。
   */
  formationDeadlineTick?: number;
  /**
   * Issue #154: `classroomPair`固有の、成立最小人数・収容最大人数の上書き。`classroomPair`以外では
   * 無視される。省略時は`DEFAULT_CLASSROOM_PAIR_GROUP_SIZE`(2人固定、既存プリセットとの後方互換)。
   */
  classroomGroupSize?: GroupSizeRule;
};

/** 責務1(候補作成)の入力コンテキスト */
export type CandidateInitiationContext = {
  /** クリークメンバーの近接判定に使う、現時点の全エージェント */
  agents: Agent[];
  params: SimParams;
};

/** 責務1(候補作成)の判定結果 */
export type CandidateInitiationDecision = {
  /** このtickで核形成を試みてよいか(rng判定の対象になるかどうか) */
  eligible: boolean;
  /** `eligible`な場合の核形成確率(rng.chanceにそのまま渡す値。介入補正は呼び出し側が別途適用する) */
  probability: number;
  /** ログ文言の出し分け用(主導性ベースか、既存クリークベースか) */
  hasInitiative: boolean;
};

/** 責務4(退出)のストレス蓄積で参照する入力コンテキスト */
export type StressAccumulationContext = {
  /** 自分にとって「歓迎されている」とみなせる成立済みグループが存在するか */
  hasWelcomingConfirmedGroup: boolean;
  ambiguityDuration: number;
  /** 「行き場がない」ことに起因する追加ストレスにかける倍率(介入補正込み。既定1) */
  noDestinationStressMultiplier: number;
};

/** 責務3(未成立候補の解散/期限切れ)の入力コンテキスト。介入補正適用後の年齢しきい値を渡す */
export type UnconfirmedCandidateLifecycleContext = {
  weakResponseAge: number;
  maxAge: number;
};

export type UnconfirmedCandidateLifecycleOutcome = "continue" | "dissolve" | "expire";

/**
 * 責務6(Issue #131): 候補の成立最小人数・収容最大人数(容量制約)。
 * `maxGroupSize`に`Number.POSITIVE_INFINITY`を返すポリシー/候補は「実質無制限」を表す。
 */
export type GroupCapacity = {
  minGroupSize: number;
  maxGroupSize: number;
};

export interface FormationPolicy {
  readonly id: FormationScenarioId;

  /**
   * 核形成(forming状態への遷移+新規/既存GroupCandidateへの合流)を試みる際、既存のforming候補が
   * 近くにあればそちらへ合流させる代わりに新規候補を作るかどうかを判断するための併合半径。
   * `evaluateCandidateInitiation`のクリーク近接判定にも同じ値を使う。
   */
  readonly candidateMergeRadius: number;

  /** 責務1: エージェントが新しいグループ候補を作成できる条件と、その基礎確率 */
  evaluateCandidateInitiation(agent: Agent, ctx: CandidateInitiationContext): CandidateInitiationDecision;

  /** 責務2: undecidedなエージェントが候補へ接近する確率に使う基礎倍率(attractivenessスコアに掛ける係数) */
  readonly approachRateMultiplier: number;

  /** 責務3: forming候補がこのtickで成立(confirmed)とみなせる条件 */
  shouldConfirmCandidate(nearbyCount: number, params: SimParams): boolean;

  /** 責務3: 成立に至らなかったforming候補が、解散/期限切れ/継続のいずれになるか */
  evaluateUnconfirmedCandidateLifecycle(
    candidate: GroupCandidate,
    ctx: UnconfirmedCandidateLifecycleContext,
  ): UnconfirmedCandidateLifecycleOutcome;
  /** `evaluateUnconfirmedCandidateLifecycle`へ渡す年齢しきい値の既定値(介入補正前) */
  readonly defaultWeakResponseAge: number;
  readonly defaultMaxAge: number;

  /** 責務4: 未定状態が続くことによるこのtickのストレス増分(介入由来の補正は呼び出し側で加算する) */
  computeStressIncrement(agent: Agent, ctx: StressAccumulationContext): number;
  /** 責務4: 蓄積済みstressが実効しきい値を超えたエージェントが、実際に場から退出してよいか */
  canLeave(agent: Agent, stress: number, effectiveLeaveThreshold: number): boolean;

  /** 責務5: シミュレーション全体が終了とみなせるか */
  isFinished(agents: Agent[], tick: number): boolean;

  /**
   * Issue #134: 責務5の判定理由。未終了ならundefinedを返す。
   * `isFinished`と同じ条件を、`simulationFinished`の構造化metadataへ保持できる形で返す。
   */
  finishReason(agents: Agent[], tick: number): SimulationFinishReason | undefined;

  /**
   * 責務6(Issue #131): 候補の成立最小人数・収容最大人数を解決する。候補固有のオーバーライド
   * (`GroupCandidate.minGroupSize`/`maxGroupSize`)が設定されていればそちらを優先するのが一般的な実装。
   */
  resolveGroupCapacity(candidate: GroupCandidate, params: SimParams): GroupCapacity;

  /**
   * 責務7(Issue #132): `shouldConfirmCandidate`へ渡す"集まった人数"をこの候補についてどう数えるかを
   * 決める。afterPartyは既存の近接ヒューリスティック(まだ合流していない周辺の人も含めて数える)を
   * そのまま踏襲し、classroomPairは`candidate.memberIds.length`そのもの(定員厳格化のため
   * 近接しているだけの他候補の人を含めない)を返す。
   */
  computeConfirmationCount(candidate: GroupCandidate, agents: Agent[]): number;

  /**
   * 責務8(Issue #133): `approaching`のagentが参加に失敗した(満員等でengine.tsが
   * `undecided`へ戻した)このtickに、通常の曖昧さstress(`computeStressIncrement`)とは別に
   * 直接`agent.stress`へ加算する増分。`reason`が"capacityFull"(満員が理由)の場合のみ正の値を返し、
   * 候補の消滅・期限切れ(自分の意思とは無関係な理由)では0を返すのが一般的な実装
   * (「最後の1枠を逃した」という個別の失敗体験にのみ追加stressを紐づけるため)。
   */
  computeJoinFailureStressIncrement(agent: Agent, reason: ApproachFailureReason): number;
}

// --- afterParty: 現行の二次会シナリオのロジック(既存挙動を維持したまま移設) --------------------

// 未定状態が続く間に蓄積するstressの基礎割合。移動速度と釣り合うよう調整済み
// (速すぎると誰も離脱せず、遅すぎると誰も輪にたどり着く前に離脱してしまう)。
const BASE_STRESS_RATE = 0.007;
const OBSERVER_EXTRA_STRESS_RATE = 0.0035;
// forming候補が成立しないまま存続できる最大tick数。これを超えたら期限切れ(expired)にする
const CANDIDATE_MAX_AGE = 40;
// このtick数までにfounder以外が誰も加わらない(反応が薄い)場合は解散(dissolving)にする
const CANDIDATE_WEAK_RESPONSE_AGE = 15;
// 核形成時、近くの既存forming候補へ合流するか新規候補を作るかを分ける併合半径。
// クリークメンバーの近接判定(核形成条件)にも同じ値を使う。
const CANDIDATE_MERGE_RADIUS = 40;
// undecidedからforming候補への接近確率に掛ける基礎倍率
const APPROACH_RATE_MULTIPLIER = 0.35;
// シミュレーション全体の安全上限tick数
const MAX_SIMULATION_TICKS = 400;
// 責務7: 成立判定用に"集まった人数"とみなす近接半径(旧engine.tsのGROUP_GATHER_RADIUSを移設)。
// まだ正式にmemberIdsへ加わっていない、接近中/形成中/参加済みの人も範囲内なら数える近似値
const AFTER_PARTY_GATHER_RADIUS = 60;
// 責務8(Issue #133): 満員による参加失敗1回あたりの追加stress基礎割合。willingnessが高いほど
// 「入りたかったのに入れなかった」ショックが大きくなるよう、agent.willingnessに掛けて使う
const JOIN_FAILURE_STRESS_RATE = 0.08;

function afterPartyFinishReason(agents: Agent[], tick: number): SimulationFinishReason | undefined {
  const allSettled = agents.every((a) => a.state === "joined" || a.state === "left");
  if (allSettled) return "allSettled";
  if (tick >= MAX_SIMULATION_TICKS) return "maxTicksReached";
  return undefined;
}

export const afterPartyPolicy: FormationPolicy = {
  id: "afterParty",
  candidateMergeRadius: CANDIDATE_MERGE_RADIUS,
  approachRateMultiplier: APPROACH_RATE_MULTIPLIER,
  defaultWeakResponseAge: CANDIDATE_WEAK_RESPONSE_AGE,
  defaultMaxAge: CANDIDATE_MAX_AGE,

  evaluateCandidateInitiation(agent, ctx) {
    // observerJoinerは自ら場を作らない
    if (agent.isObserverJoiner) {
      return { eligible: false, probability: 0, hasInitiative: false };
    }

    // 核を作れるのは主導性が十分高い人、または既存の仲良しグループが
    // 近くに揃っている人だけ(主導者0人・既存関係性も弱い場なら誰も場を作らない)
    const hasInitiative = agent.initiative >= 0.5;
    const cliqueReady =
      agent.cliqueId !== undefined &&
      ctx.params.existingTieStrength > 0.5 &&
      ctx.agents.filter(
        (other) =>
          other.id !== agent.id &&
          other.cliqueId === agent.cliqueId &&
          other.state === "undecided" &&
          distance(agent.x, agent.y, other.x, other.y) < CANDIDATE_MERGE_RADIUS,
      ).length >= 2;

    if (!hasInitiative && !cliqueReady) {
      return { eligible: false, probability: 0, hasInitiative };
    }

    const probability = hasInitiative
      ? agent.willingness * agent.initiative * 0.08 * (1 + ctx.params.numLeaders * 0.15)
      : ctx.params.existingTieStrength * 0.1;

    return { eligible: true, probability, hasInitiative };
  },

  shouldConfirmCandidate(nearbyCount, params) {
    return nearbyCount >= params.groupConfirmSize;
  },

  evaluateUnconfirmedCandidateLifecycle(candidate, ctx) {
    // founder以外誰も加わらないまま反応が薄ければ、時間切れを待たずに解散する。
    // ただし公開の集合場所(isPublicMeetingPoint)はfounderがいないことに変わりないため、
    // 反応の薄さだけで早期解散の対象にはしない(期限切れ判定は引き続き適用する)
    if (!candidate.isPublicMeetingPoint && candidate.memberIds.length < 2 && candidate.age >= ctx.weakResponseAge) {
      return "dissolve";
    }
    if (candidate.age >= ctx.maxAge) {
      return "expire";
    }
    return "continue";
  },

  computeStressIncrement(agent, ctx) {
    let increment =
      (agent.willingness * (1 - agent.ambiguityTolerance) * BASE_STRESS_RATE) / Math.max(0.2, ctx.ambiguityDuration);

    if (agent.isObserverJoiner && !ctx.hasWelcomingConfirmedGroup) {
      increment +=
        (agent.willingness * agent.influenceAvoidance * OBSERVER_EXTRA_STRESS_RATE * ctx.noDestinationStressMultiplier) /
        Math.max(0.2, ctx.ambiguityDuration);
    }

    return increment;
  },

  canLeave(_agent, stress, effectiveLeaveThreshold) {
    return stress > effectiveLeaveThreshold;
  },

  isFinished(agents, tick) {
    return afterPartyFinishReason(agents, tick) !== undefined;
  },

  finishReason(agents, tick) {
    return afterPartyFinishReason(agents, tick);
  },

  resolveGroupCapacity(candidate, params) {
    // 二次会シナリオでは成立に必要な人数(groupConfirmSize)以上は自由に混ざれるため、
    // 収容人数は実質無制限(候補固有のオーバーライドがない限り)
    return {
      minGroupSize: candidate.minGroupSize ?? params.groupConfirmSize,
      maxGroupSize: candidate.maxGroupSize ?? Number.POSITIVE_INFINITY,
    };
  },

  computeConfirmationCount(candidate, agents) {
    // 旧engine.tsのstep 9に直接書かれていたヒューリスティックをそのまま移設(既存挙動を維持)。
    // まだcandidate.memberIdsに加わっていなくても、接近中/形成中/参加済みで近くにいれば
    // 「集まっている」とみなす(輪に人が集まってきている様子を素朴に近似する)
    return agents.filter(
      (a) =>
        (a.state === "forming" || a.state === "joined" || a.state === "approaching") &&
        (candidate.memberIds.includes(a.id) ||
          distance(a.x, a.y, candidate.x, candidate.y) < AFTER_PARTY_GATHER_RADIUS),
    ).length;
  },

  computeJoinFailureStressIncrement(agent, reason) {
    if (reason !== "capacityFull") return 0;
    return agent.willingness * JOIN_FAILURE_STRESS_RATE;
  },
};

// --- standingParty: Issue #174 (Phase 1) 立食パーティーで会話の輪を探すシナリオ -----------------
//
// Phase 1時点では、複数の会話の輪が並行して形成される様子(核形成・接近・成立・未成立候補の解散/
// 期限切れ)をafterPartyと同じ力学でそのまま表現する。会話クラスタからの離脱・再参加・縮小/再形成
// (ADRの責務9/10)は後続Issueの対象であり、本Issueでは意図的に実装しない(対象外: 終了しないtick
// ループの完成、離脱・再参加ロジック、成立済みクラスタの縮小・解散)。そのため`canLeave`到達後の
// `leaving`は「会話の輪を諦めて会場を出る」を表し、`isFinished`もafterPartyと同じ安全上限
// (`MAX_SIMULATION_TICKS`)付きの`allSettled`判定を暫定的に踏襲する。

function standingPartyFinishReason(agents: Agent[], tick: number): SimulationFinishReason | undefined {
  const allSettled = agents.every((a) => a.state === "joined" || a.state === "left");
  if (allSettled) return "allSettled";
  if (tick >= MAX_SIMULATION_TICKS) return "maxTicksReached";
  return undefined;
}

export const standingPartyPolicy: FormationPolicy = {
  id: "standingParty",
  candidateMergeRadius: CANDIDATE_MERGE_RADIUS,
  approachRateMultiplier: APPROACH_RATE_MULTIPLIER,
  defaultWeakResponseAge: CANDIDATE_WEAK_RESPONSE_AGE,
  defaultMaxAge: CANDIDATE_MAX_AGE,

  evaluateCandidateInitiation(agent, ctx) {
    return afterPartyPolicy.evaluateCandidateInitiation(agent, ctx);
  },

  shouldConfirmCandidate(nearbyCount, params) {
    return afterPartyPolicy.shouldConfirmCandidate(nearbyCount, params);
  },

  evaluateUnconfirmedCandidateLifecycle(candidate, ctx) {
    return afterPartyPolicy.evaluateUnconfirmedCandidateLifecycle(candidate, ctx);
  },

  computeStressIncrement(agent, ctx) {
    return afterPartyPolicy.computeStressIncrement(agent, ctx);
  },

  canLeave(agent, stress, effectiveLeaveThreshold) {
    return afterPartyPolicy.canLeave(agent, stress, effectiveLeaveThreshold);
  },

  isFinished(agents, tick) {
    return standingPartyFinishReason(agents, tick) !== undefined;
  },

  finishReason(agents, tick) {
    return standingPartyFinishReason(agents, tick);
  },

  resolveGroupCapacity(candidate, params) {
    return afterPartyPolicy.resolveGroupCapacity(candidate, params);
  },

  computeConfirmationCount(candidate, agents) {
    return afterPartyPolicy.computeConfirmationCount(candidate, agents);
  },

  computeJoinFailureStressIncrement(agent, reason) {
    return afterPartyPolicy.computeJoinFailureStressIncrement(agent, reason);
  },
};

// --- classroomPair: Issue #132 (Phase 2) 教室で自由にペアを作るシナリオ ------------------------

// 教室シナリオでの核形成確率にかける基礎倍率。teacherの指示による活動のため、二次会の
// APPROACH_RATE_MULTIPLIERよりやや高めに設定し、時間内にペアが決まりやすくしてある
const CLASSROOM_APPROACH_RATE_MULTIPLIER = 0.5;
// 核形成(ペア探し開始)確率に掛ける基礎割合
const CLASSROOM_INITIATION_RATE = 0.12;
// 併合半径(教室内での「近く」の目安。二次会と同じ値を踏襲)
const CLASSROOM_CANDIDATE_MERGE_RADIUS = 40;
// 相手が見つからないまま解散/期限切れとみなすtick数。deadline内に何度か探し直せるよう、
// 二次会(15/40)より短めに設定している
const CLASSROOM_WEAK_RESPONSE_AGE = 10;
const CLASSROOM_CANDIDATE_MAX_AGE = 25;
// 未定状態が続く間に蓄積するstressの基礎割合(退出には使わないが、既存のstressフィールド・
// UI表示は引き続き意味を持たせるため既存式を再利用する)
const CLASSROOM_STRESS_RATE = 0.005;
// 責務8(Issue #133): ペアの最後の1枠を逃した際の追加stress基礎割合。定員2固定のため
// 「最後の1枠を取られる」経験がafterPartyより起こりやすく、afterPartyよりやや高めに設定している
const CLASSROOM_JOIN_FAILURE_STRESS_RATE = 0.1;
// `formationDeadlineTick`省略時の既定値
export const DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK = 200;

function classroomPairFinishReason(
  agents: Agent[],
  tick: number,
  formationDeadlineTick: number,
): SimulationFinishReason | undefined {
  if (agents.every((a) => a.state === "joined")) return "allAssigned";
  if (tick >= formationDeadlineTick) return "deadlineReached";
  return undefined;
}

/**
 * Issue #154: `classroomPair`の一般化。固定定員(min===max、ペア・3人班・4人班等)・可変定員
 * (min<max、例: 3〜4人班)のいずれも`options.groupSize`で表現する学校向けpolicy factory。
 * 内部IDは常に`"classroomPair"`を返す(新しいscenarioIdは追加しない)ため、engine.ts側の
 * `formationPolicy.id === "classroomPair"`分岐(メッセージ文言・deadline処理)や、既存の
 * `state.formationScenarioId`の保存値・URL等はこの一般化の影響を受けない。
 */
function createClassroomGroupPolicy(options: ClassroomGroupFormationOptions): FormationPolicy {
  validateClassroomGroupFormationOptions(options);
  const { groupSize, formationDeadlineTick } = options;

  return {
    id: "classroomPair",
    candidateMergeRadius: CLASSROOM_CANDIDATE_MERGE_RADIUS,
    approachRateMultiplier: CLASSROOM_APPROACH_RATE_MULTIPLIER,
    defaultWeakResponseAge: CLASSROOM_WEAK_RESPONSE_AGE,
    defaultMaxAge: CLASSROOM_CANDIDATE_MAX_AGE,

    evaluateCandidateInitiation(agent) {
      // observerJoiner相当(自らペアを作らず誘いを待ちやすい人)は、afterPartyと同様に
      // 自分からは核(班探し)を作らない
      if (agent.isObserverJoiner) {
        return { eligible: false, probability: 0, hasInitiative: false };
      }

      // 先生が「自由に班を作ってください」と全員に指示しているため、afterPartyと異なり
      // 主導性の高い人だけに限定しない(numLeaders: 0のプリセットでも誰も動けない、という
      // afterParty的な事態を避ける)。initiative/willingnessは頻度の重み付けとしてのみ再利用する
      const hasInitiative = agent.initiative >= 0.5;
      const probability = clamp(
        agent.willingness * (0.4 + 0.6 * agent.initiative) * CLASSROOM_INITIATION_RATE,
        0,
        1,
      );

      return { eligible: true, probability, hasInitiative };
    },

    shouldConfirmCandidate(nearbyCount) {
      // 成立最小人数以上集まれば成立(可変定員では、maxGroupSizeに達するまで引き続き参加を受け付ける)。
      // groupConfirmSize(params)は参照しない
      return nearbyCount >= groupSize.minGroupSize;
    },

    evaluateUnconfirmedCandidateLifecycle(candidate, ctx) {
      // shouldConfirmCandidateが先に評価されるため、ここに到達する時点でmemberIds.length < minGroupSize
      if (candidate.memberIds.length < groupSize.minGroupSize && candidate.age >= ctx.weakResponseAge) {
        return "dissolve";
      }
      if (candidate.age >= ctx.maxAge) {
        return "expire";
      }
      return "continue";
    },

    computeStressIncrement(agent, ctx) {
      // 既存の「未定状態が続くほどstressが上がる」式を再利用するが、canLeaveが常にfalseのため
      // 退出には結びつかない(UI上のstress表示・観察用途のみに意味を持つ)
      return (
        (agent.willingness * (1 - agent.ambiguityTolerance) * CLASSROOM_STRESS_RATE) /
        Math.max(0.2, ctx.ambiguityDuration)
      );
    },

    canLeave() {
      // 受入条件: 学校シナリオではleave/leftへ遷移しない
      return false;
    },

    isFinished(agents, tick) {
      return classroomPairFinishReason(agents, tick, formationDeadlineTick) !== undefined;
    },

    finishReason(agents, tick) {
      return classroomPairFinishReason(agents, tick, formationDeadlineTick);
    },

    resolveGroupCapacity(candidate) {
      // 候補固有のオーバーライドがあればそちらを優先する既存の一般ルールは維持
      return {
        minGroupSize: candidate.minGroupSize ?? groupSize.minGroupSize,
        maxGroupSize: candidate.maxGroupSize ?? groupSize.maxGroupSize,
      };
    },

    computeConfirmationCount(candidate) {
      // afterPartyの近接ヒューリスティックとは異なり、定員厳格化のため実際のmemberIdsのみを数える
      // (近くをたまたま通りかかった無関係な人を「集まった」と誤カウントしないため)
      return candidate.memberIds.length;
    },

    computeJoinFailureStressIncrement(agent, reason) {
      if (reason !== "capacityFull") return 0;
      return agent.willingness * CLASSROOM_JOIN_FAILURE_STRESS_RATE;
    },
  };
}

/** `classroomGroupSize`省略時は`DEFAULT_CLASSROOM_PAIR_GROUP_SIZE`(既存2人固定)にfall backする */
function createClassroomPairPolicy(
  formationDeadlineTick: number,
  groupSize: GroupSizeRule = DEFAULT_CLASSROOM_PAIR_GROUP_SIZE,
): FormationPolicy {
  return createClassroomGroupPolicy({ groupSize, formationDeadlineTick });
}

const FORMATION_POLICIES: Partial<Record<FormationScenarioId, FormationPolicy>> = {
  afterParty: afterPartyPolicy,
  standingParty: standingPartyPolicy,
};

/**
 * `formationDeadlineTick`/`classroomGroupSize`は`classroomPair`のみで参照される(他シナリオでは
 * 無視される)。`classroomPair`はこれらの組み合わせごとに異なる`FormationPolicy`が必要なため、
 * afterPartyのような固定シングルトンではなく毎回`createClassroomPairPolicy`で組み立てる。
 */
export function getFormationPolicyById(
  id: FormationScenarioId,
  formationDeadlineTick?: number,
  classroomGroupSize?: GroupSizeRule,
): FormationPolicy {
  if (id === "classroomPair") {
    return createClassroomPairPolicy(formationDeadlineTick ?? DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK, classroomGroupSize);
  }
  return FORMATION_POLICIES[id] ?? afterPartyPolicy;
}

/** `options`(未指定なら後方互換として`afterParty`)に対応する`FormationPolicy`を解決する */
export function resolveFormationPolicy(options?: FormationRuntimeOptions): FormationPolicy {
  return getFormationPolicyById(options?.scenarioId ?? "afterParty", options?.formationDeadlineTick, options?.classroomGroupSize);
}

/**
 * Issue #136: 特定の候補(GroupCandidate)に依存しない、そのポリシーの「標準的な」収容人数を解決する。
 * `resolveGroupCapacity`は候補固有のオーバーライドを優先する設計だが、classroomPairのように
 * 候補に関わらず常に固定サイズ(2人)を返すポリシーでは、まだ存在しないダミー候補を渡しても
 * 同じ結果が得られる。Monte Carlo集計(`pairFormation.ts`)が「奇数人口では何人が必然的に
 * 割当不可能か」を判定する際に使う。
 */
export function resolveNominalGroupCapacity(policy: FormationPolicy, params: SimParams): GroupCapacity {
  const nominalCandidate: GroupCandidate = {
    id: "__nominal__",
    x: 0,
    y: 0,
    memberIds: [],
    status: "forming",
    age: 0,
  };
  return policy.resolveGroupCapacity(nominalCandidate, params);
}

/**
 * Issue #154: `capacity`(`minGroupSize..maxGroupSize`)の範囲内で人口`populationSize`を過不足なく
 * 班へ分割できるかを決定的に判定し、できない場合に理論上どうしても割当不可能な最小人数
 * (構造的未割当人数)を返す純粋関数。固定定員(min===max、`populationSize % minGroupSize`と同値)・
 * 可変定員のどちらにも同じAPIで対応する(受入条件: `resolveNominalGroupCapacity`と
 * `pairFormation.ts`の`structuralUnassignedFloor`が可変定員でも正しい値を返せる)。
 *
 * 例: 10人を3〜4人班(3+3+4)に分ける場合は構造的未割当0。5人を3〜4人班に分ける場合、
 * 3人班1つ(残り2人は班を作れない)が最善のため構造的未割当は1。
 *
 * `capacity.maxGroupSize`が有限であることを前提とする(呼び出し側は`Number.isFinite`で
 * 実質無制限の定員を先に除外すること。afterPartyのように無制限なら構造的未割当という概念自体が
 * 不要なため、この関数の対象外)。
 */
export function computeStructuralUnassignedFloor(populationSize: number, capacity: GroupCapacity): number {
  if (populationSize <= 0) return 0;

  const { minGroupSize, maxGroupSize } = capacity;
  // reachable[n] = ちょうどn人を、min..maxの班だけで(0個以上)過不足なく分割できるか
  const reachable = new Array<boolean>(populationSize + 1).fill(false);
  reachable[0] = true;
  for (let n = minGroupSize; n <= populationSize; n++) {
    for (let size = minGroupSize; size <= Math.min(maxGroupSize, n); size++) {
      if (reachable[n - size]) {
        reachable[n] = true;
        break;
      }
    }
  }

  for (let assignable = populationSize; assignable >= 0; assignable--) {
    if (reachable[assignable]) {
      return populationSize - assignable;
    }
  }
  // populationSize >= 1でreachable[0]は常にtrueのため、ここには到達しない
  return populationSize;
}
