import type { Agent, GroupCandidate, SimParams } from "./types";
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
 */
export type FormationScenarioId = "afterParty" | "classroomPair";

/** `createInitialState`/`stepSimulation`に形成ポリシーを指定する際の実行時オプション */
export type FormationRuntimeOptions = {
  scenarioId: FormationScenarioId;
  /**
   * Issue #132: `classroomPair`固有の、全員割当に至らなくても強制終了するtick数。
   * `classroomPair`以外では無視される。省略時は`DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK`。
   */
  formationDeadlineTick?: number;
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
    const allSettled = agents.every((a) => a.state === "joined" || a.state === "left");
    return allSettled || tick >= MAX_SIMULATION_TICKS;
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
// `formationDeadlineTick`省略時の既定値
export const DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK = 200;

function createClassroomPairPolicy(formationDeadlineTick: number): FormationPolicy {
  return {
    id: "classroomPair",
    candidateMergeRadius: CLASSROOM_CANDIDATE_MERGE_RADIUS,
    approachRateMultiplier: CLASSROOM_APPROACH_RATE_MULTIPLIER,
    defaultWeakResponseAge: CLASSROOM_WEAK_RESPONSE_AGE,
    defaultMaxAge: CLASSROOM_CANDIDATE_MAX_AGE,

    evaluateCandidateInitiation(agent) {
      // observerJoiner相当(自らペアを作らず誘いを待ちやすい人)は、afterPartyと同様に
      // 自分からは核(ペア探し)を作らない
      if (agent.isObserverJoiner) {
        return { eligible: false, probability: 0, hasInitiative: false };
      }

      // 先生が「自由にペアを作ってください」と全員に指示しているため、afterPartyと異なり
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
      // 定員2固定。groupConfirmSize(params)は参照しない
      return nearbyCount >= 2;
    },

    evaluateUnconfirmedCandidateLifecycle(candidate, ctx) {
      // shouldConfirmCandidateが先に評価されるため、ここに到達する時点でmemberIds.length < 2
      if (candidate.memberIds.length < 2 && candidate.age >= ctx.weakResponseAge) {
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
      const allPaired = agents.every((a) => a.state === "joined");
      return allPaired || tick >= formationDeadlineTick;
    },

    resolveGroupCapacity(candidate) {
      // 定員2固定(候補固有のオーバーライドがあればそちらを優先する既存の一般ルールは維持)
      return {
        minGroupSize: candidate.minGroupSize ?? 2,
        maxGroupSize: candidate.maxGroupSize ?? 2,
      };
    },

    computeConfirmationCount(candidate) {
      // afterPartyの近接ヒューリスティックとは異なり、定員厳格化のため実際のmemberIdsのみを数える
      // (近くをたまたま通りかかった無関係な人を「集まった」と誤カウントしないため)
      return candidate.memberIds.length;
    },
  };
}

const FORMATION_POLICIES: Partial<Record<FormationScenarioId, FormationPolicy>> = {
  afterParty: afterPartyPolicy,
};

/**
 * `formationDeadlineTick`は`classroomPair`のみで参照される(他シナリオでは無視される)。
 * `classroomPair`は`formationDeadlineTick`ごとに異なる`FormationPolicy`が必要なため、
 * afterPartyのような固定シングルトンではなく毎回`createClassroomPairPolicy`で組み立てる。
 */
export function getFormationPolicyById(id: FormationScenarioId, formationDeadlineTick?: number): FormationPolicy {
  if (id === "classroomPair") {
    return createClassroomPairPolicy(formationDeadlineTick ?? DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK);
  }
  return FORMATION_POLICIES[id] ?? afterPartyPolicy;
}

/** `options`(未指定なら後方互換として`afterParty`)に対応する`FormationPolicy`を解決する */
export function resolveFormationPolicy(options?: FormationRuntimeOptions): FormationPolicy {
  return getFormationPolicyById(options?.scenarioId ?? "afterParty", options?.formationDeadlineTick);
}
