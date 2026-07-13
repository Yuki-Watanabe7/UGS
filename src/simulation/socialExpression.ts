import type { Agent, AgentState, GroupCandidate, SimParams, SimulationState } from "./types";
import type { SpeechActiveEffect } from "./speechEffects";
import { sumActiveEffectValue } from "./speechEffects";
import { attractiveness, isJoinable, nearestCandidate } from "./engine";
import type { InterventionRuntimeOptions } from "./interventions";
import { resolveEffectiveParams, resolveInterventionScenario } from "./interventions";
import { DEFAULT_SPEECH_RANGE } from "./speech";
import { clamp } from "./model";

/**
 * Phase 4(Issue #113): 本心・対外表現・行動を分離する三層モデルの型と導出境界。
 *
 * 三層の定義と既存概念との対応:
 * - 本心(`PrivateEvaluation`、本ファイル): エージェント内部の評価。既存の判断式
 *   (`attractiveness()`・接近確率計算・stress/`leaveThreshold`比較、いずれも`engine.ts`)の
 *   中間値から純関数で導出される観察用スナップショット。他エージェントには一切認知されない。
 *   Phase 1の`ExpressionEvent`(`expression.ts`)は、この本心側を観察者向けに言語化した演出データにあたる。
 * - 対外表現(`PublicExpression`、本ファイル): 対外的に表現される立場。Phase 2の`SpeechEvent`
 *   (`speech.ts`)は、この対外表現側が実際の発言として観測されたものにあたる。
 *   Issue #114により、遠慮(拒否回避)・同調圧力・印象管理(社交辞令)の3要因で本心から乖離しうる
 *   (`derivePublicExpressions`が唯一の変換境界。乖離した発言の生成はIssue #115で導入する)。
 *   乖離は既存personality(`influenceAvoidance`/`conformity`)・関係性(`cliqueId`/`existingTieStrength`)・
 *   場の状態(可聴範囲内の多数派)から決定的に導出される仮説ルールであり、rngは一切使わない。
 * - 行動(actualAction): 既存の`AgentState`遷移・移動そのもの(`types.ts`/`engine.ts`)。
 *   新しい型は導入しない。三層モデルにおける「実際にどう動いたか」はこれを指す。
 *
 * 処理境界(重要):
 * - 本ファイルの導出関数はすべて純関数であり、`SimulationState`を読み取るのみで一切mutationしない。
 * - 本体の`SeededRandom`を受け取らない/消費しない(導出の有無でPRNG列は変わらない)。
 * - `engine.ts`は本ファイルをimportしない(観察専用の一方向依存。`expression.ts`と同じ位置づけ)。
 *   engineの判断式への接続はIssue #115以降のスコープ。
 * - 導出結果は`SimulationState`に保持されない(呼び出し側が必要なtickで都度導出する)。
 *
 * 詳細は`docs/social-expression-phase4-boundary.md`参照。
 */

/** Phase 4三層モデルの導出有無を切り替える設定境界。`SpeechEffectsConfig`と同じ後方互換パターン */
export type SocialExpressionConfig = {
  /**
   * false(デフォルト)の場合、`derivePrivateEvaluations`/`derivePublicExpressions`は
   * いずれも空配列を返す。既存の設定・挙動との後方互換のためのデフォルト値。
   */
  enabled: boolean;
};

/** 未指定時に使う既定値。既存の呼び出し元を一切変更せずに済むよう無効化しておく */
export const DEFAULT_SOCIAL_EXPRESSION_CONFIG: SocialExpressionConfig = { enabled: false };

/** 部分指定を`DEFAULT_SOCIAL_EXPRESSION_CONFIG`で補完した`SocialExpressionConfig`を返す */
export function resolveSocialExpressionConfig(config?: Partial<SocialExpressionConfig>): SocialExpressionConfig {
  return { ...DEFAULT_SOCIAL_EXPRESSION_CONFIG, ...config };
}

/**
 * joinableな輪1件に対する本心側の評価。`attractiveness`は`engine.ts`の同名関数を
 * そのtickと同じ入力(実効params・介入ID・現在有効な発言効果)で呼んだ値そのもので、
 * 独自の評価式は導入しない(本心=既存判断式の中間値、という定義を保つため)。
 */
export type PrivateCandidateEvaluation = {
  groupId: string;
  /** `isJoinable`を通過した候補のみ評価するため、forming/confirmedに限られる */
  groupStatus: "forming" | "confirmed";
  attractiveness: number;
  /** `engine.ts`の接近判定が対象にする最寄り候補かどうか(`nearestCandidate`と同一の判定) */
  isNearest: boolean;
};

/**
 * 本心: エージェント1人の、あるtick時点の内的評価スナップショット。
 *
 * 各フィールドは既存の判断式の入力・中間値をそのまま写しとったもので、新しい心理モデルは
 * 導入しない。engineの意思決定ルール上、接近判定・leave判定の入力になるのは`undecided`の
 * エージェントのみだが、観察対象としての本心は全エージェントについて導出する
 * (どの状態のエージェントかは`agentState`で判別できる)。
 */
export type PrivateEvaluation = {
  id: string;
  tick: number;
  agentId: string;
  /** 導出時点の行動状態(三層モデルのactualAction側)。本心と行動の対応を後から突き合わせるための複製 */
  agentState: AgentState;
  /** 二次会への参加意欲。既存personalityの`willingness`そのもの(本心の基礎値) */
  joinDesire: number;
  /**
   * 離脱傾向: stress / 実効leaveThreshold。engineのleave判定(`stress > effectiveLeaveThreshold`)と
   * 同じ入力の比率表現で、1.0以上はしきい値到達(=undecidedならこのtickでleaving遷移済み)を意味する。
   * 実効しきい値には"decline"由来の`SpeechActiveEffect`補正を含む(engineと同じ計算)。
   */
  leaveInclination: number;
  /** joinableな各輪への評価。`SimulationState.groupCandidates`の配列順(決定的) */
  candidateEvaluations: PrivateCandidateEvaluation[];
};

/**
 * 参加意欲の表明スタンス(Issue #114)。`joinDesire`(本心側)/`expressedJoinDesire`(対外表現側)を
 * しきい値(`POSITIVE_STANCE_MIN`/`NEGATIVE_STANCE_MAX`)で3値に丸めたもの。
 * - "positive": 積極的な表明(invite/approach表明に相当する立場)
 * - "none": 無表明(どちらとも表明しない様子見の立場)
 * - "negative": 消極的な表明(decline相当の立場)
 *
 * observerJoiner(参加したいが自分から影響を与えたくない)の典型的な乖離は、
 * 本心側スタンス"positive"・対外表現側スタンス"none"として判定される。
 */
export type ExpressedStance = "positive" | "none" | "negative";

/** 乖離が作用する表現の次元。`PrivateEvaluation`の同名フィールドに対応する */
export type PublicExpressionDimension = "joinDesire" | "leaveInclination";

/**
 * 乖離要因のキー(Issue #114で固定した3要因)。各要因が作用する次元と方向は固定:
 * - "reserve"(遠慮・拒否回避): joinDesire次元・抑制方向のみ。`influenceAvoidance`が高いほど、
 *   本心の積極さ(`joinDesire`の中立値超過分)を打ち消して無表明側へ寄せる。
 * - "conformityPressure"(同調圧力): joinDesire次元・符号は可聴範囲内の多数派に従う。
 *   `conformity`が高いほど、周囲のforming/approaching/joined優勢なら積極側へ、
 *   undecided/leaving優勢なら消極側へ表現を寄せる。
 * - "impressionManagement"(印象管理・社交辞令): leaveInclination次元・緩和方向のみ。
 *   可聴範囲内に同一cliqueの相手がいるとき、`existingTieStrength`が強いほど
 *   本心の離脱傾向の表明を和らげる。
 */
export type PublicExpressionFactorKey = "reserve" | "conformityPressure" | "impressionManagement";

/**
 * 乖離量を構成する要因1件分の内訳(Phase 3の`SpeechInterpretationFactor`のcontributionパターンを踏襲)。
 * `rawValue`/`normalizedValue`の意味はkeyごとに定義する(Phase 3と同じくkey別のセマンティクス):
 *
 * | key | rawValue | normalizedValue |
 * | --- | --- | --- |
 * | reserve | `influenceAvoidance`の生値 | 0〜1へclampした`influenceAvoidance` |
 * | conformityPressure | 可聴範囲内の多数派シグナル(-1〜1、正=forming/approaching/joined優勢) | 0〜1へclampした`conformity` |
 * | impressionManagement | 実効`existingTieStrength`の生値 | 関係の近さ(可聴範囲内に同一clique者がいれば実効tie、いなければ0) |
 *
 * `contribution`はこの要因が該当次元の乖離量(delta)へ加算した符号付きの値(clamp前)。
 * 要因の条件が不成立の場合もcontribution 0で固定順に必ず含まれる(観察の一貫性のため)。
 */
export type PublicExpressionFactor = {
  key: PublicExpressionFactorKey;
  dimension: PublicExpressionDimension;
  rawValue: number;
  normalizedValue: number;
  contribution: number;
};

/**
 * 次元1つ分の乖離判定結果(Issue #114)。`rawDelta`は各要因のcontributionの単純合計、
 * `delta`はclamp規則適用後に実際に表現へ反映された乖離量(`expressedValue - privateValue`)。
 * clamp規則: (1) rawDeltaを±`MAX_DIVERGENCE_PER_DIMENSION`へclamp、
 * (2) joinDesire次元は最終値を0〜1へ、leaveInclination次元は0以上へclampする。
 */
export type PublicExpressionDivergence = {
  dimension: PublicExpressionDimension;
  privateValue: number;
  expressedValue: number;
  /** 各要因のcontributionの合計(clamp前)。`delta`との差からclampの発動が読み取れる */
  rawDelta: number;
  /** 実際に反映された乖離量(= expressedValue - privateValue) */
  delta: number;
  /** この次元に作用する要因の内訳。固定順(joinDesire: reserve→conformityPressure、leaveInclination: impressionManagement) */
  factors: PublicExpressionFactor[];
};

/**
 * 対外表現: エージェント1人の、あるtick時点で対外的に表現される立場。
 *
 * Issue #114により、遠慮・同調圧力・印象管理の3要因(`PublicExpressionFactorKey`参照)で
 * 本心(`PrivateEvaluation`)から乖離しうる。乖離は入力からの決定的計算であり(rng不使用)、
 * `divergences`に次元ごとの乖離量と各要因の寄与が構造化して保持される。
 * `privateEvaluationId`により、どの本心から導出されたかを常に追跡できる。
 * personality基礎値(`willingness`/`conformity`/`influenceAvoidance`等)は一切変更しない。
 */
export type PublicExpression = {
  id: string;
  /** 導出元の`PrivateEvaluation.id`(因果追跡用のリンク) */
  privateEvaluationId: string;
  tick: number;
  agentId: string;
  /** 対外的に表現される参加意欲(乖離適用後、0〜1) */
  expressedJoinDesire: number;
  /** 対外的に表現される離脱傾向(乖離適用後、0以上) */
  expressedLeaveInclination: number;
  /** 本心側スタンス(`PrivateEvaluation.joinDesire`をしきい値で3値化したもの) */
  privateStance: ExpressedStance;
  /** 対外表現側スタンス(`expressedJoinDesire`をしきい値で3値化したもの) */
  expressedStance: ExpressedStance;
  /** 本心との乖離があるか(いずれかの次元で|delta|が`DIVERGENCE_EPSILON`を超えるか) */
  divergent: boolean;
  /** 次元ごとの乖離判定結果。固定順([0]: joinDesire、[1]: leaveInclination) */
  divergences: PublicExpressionDivergence[];
};

// leaveInclinationの分母の下限。実効leaveThresholdは"decline"由来の負の補正で理論上0以下に
// なりうるため、比率が発散しないよう下限を設ける(engineのleave判定自体は比較のみなので影響しない)
const MIN_EFFECTIVE_LEAVE_THRESHOLD = 0.01;

/**
 * 乖離判定で「可聴範囲」として使う距離。Phase 2の発言の基礎到達距離(`DEFAULT_SPEECH_RANGE`)を
 * そのまま流用する — 「声が届く範囲にいる相手」が同調圧力・印象管理の対象になる、という対応を
 * Phase 2/3の認知モデルと一貫させるため。
 */
export const EXPRESSION_AUDIBLE_RANGE = DEFAULT_SPEECH_RANGE;

/** joinDesireの中立値。遠慮(reserve)はこの値を超える積極さだけを抑制する(積極→消極への反転はさせない) */
const NEUTRAL_JOIN_DESIRE = 0.5;

/** expressedJoinDesire/joinDesireがこの値以上なら"positive"(積極的な表明)とみなす */
export const POSITIVE_STANCE_MIN = 0.65;

/** expressedJoinDesire/joinDesireがこの値以下なら"negative"(消極的な表明)とみなす */
export const NEGATIVE_STANCE_MAX = 0.35;

/** 同調圧力の最大寄与(多数派シグナルが±1・conformityが1のときの乖離量) */
const CONFORMITY_PRESSURE_WEIGHT = 0.3;

/** 印象管理の最大緩和率(関係の近さが1のとき、離脱傾向の表明をどこまで和らげるか) */
const IMPRESSION_SOFTENING_WEIGHT = 0.6;

/** 1次元あたりの乖離量(rawDelta)の上限。これを超える要因の合計はここで頭打ちになる */
export const MAX_DIVERGENCE_PER_DIMENSION = 0.5;

// 乖離判定は決定的計算であり、要因の条件が不成立ならcontributionは正確に0になるが、
// 浮動小数点演算の合成で生じうる微小なノイズを「乖離あり」と誤判定しないための防御的なしきい値
const DIVERGENCE_EPSILON = 1e-9;

/** joinDesire(0〜1)をしきい値で3値の表明スタンスへ丸める */
export function stanceOfJoinDesire(joinDesire: number): ExpressedStance {
  if (joinDesire >= POSITIVE_STANCE_MIN) return "positive";
  if (joinDesire <= NEGATIVE_STANCE_MAX) return "negative";
  return "none";
}

// 抑制・緩和方向の寄与は負符号との乗算で計算するため、要因不成立時に-0が生じうる。
// Object.is上の-0/0の違いが呼び出し側の比較・テストで露出しないよう正規化する
// (`activeEffectStrengthAtTick`と同じ配慮)
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * `state`の全エージェントについて、そのtick時点の本心(`PrivateEvaluation`)を導出する純関数。
 *
 * engineが次のtickの判断で参照するのと同じ経路で入力を解決する:
 * - 介入は`state.interventionId`から(`stepSimulation`の未指定時fall backと同じ)
 * - 実効paramsは`resolveEffectiveParams`(介入のparamAdjustments適用後)
 * - 発言効果は`state.activeSpeechEffects`(Phase 3が無効なら常に空)を`state.tick`時点の強度で評価
 *
 * `config.enabled === false`(デフォルト)では空配列を返し、呼び出しても既存挙動に一切影響しない。
 * `state`をmutationせず、rngも受け取らない(導出の有無でシミュレーション結果・PRNG列は変わらない)。
 */
export function derivePrivateEvaluations(
  state: SimulationState,
  params: SimParams,
  config: SocialExpressionConfig,
): PrivateEvaluation[] {
  if (!config.enabled) return [];

  const intervention: InterventionRuntimeOptions | undefined = state.interventionId
    ? { interventionId: state.interventionId }
    : undefined;
  const effectiveParams = resolveEffectiveParams(params, intervention);
  const interventionId = resolveInterventionScenario(intervention).id;
  const activeEffects: SpeechActiveEffect[] = state.speechEffectsEnabled ? (state.activeSpeechEffects ?? []) : [];
  const joinableCandidates = state.groupCandidates.filter(isJoinable);

  return state.agents.map((agent) => {
    const nearest = nearestCandidate(agent, state.groupCandidates);
    const candidateEvaluations: PrivateCandidateEvaluation[] = joinableCandidates.map((candidate: GroupCandidate) => ({
      groupId: candidate.id,
      // isJoinableを通過した候補はforming/confirmedのどちらかに限られる
      groupStatus: candidate.status as "forming" | "confirmed",
      attractiveness: attractiveness(
        agent,
        candidate,
        state.agents,
        effectiveParams,
        interventionId,
        state.tick,
        activeEffects,
      ),
      isNearest: candidate.id === nearest?.id,
    }));

    const effectiveLeaveThreshold =
      agent.leaveThreshold + sumActiveEffectValue(activeEffects, agent.id, "leaveThreshold", state.tick);

    return {
      id: `private-${state.tick}-${agent.id}`,
      tick: state.tick,
      agentId: agent.id,
      agentState: agent.state,
      joinDesire: agent.willingness,
      leaveInclination: agent.stress / Math.max(MIN_EFFECTIVE_LEAVE_THRESHOLD, effectiveLeaveThreshold),
      candidateEvaluations,
    };
  });
}

/** 可聴範囲内(自分自身とleftを除く)の近傍エージェントを返す。乖離判定の同調圧力・印象管理の対象 */
function audibleNeighbors(agent: Agent, agents: Agent[]): Agent[] {
  return agents.filter(
    (other) =>
      other.id !== agent.id &&
      other.state !== "left" &&
      Math.hypot(other.x - agent.x, other.y - agent.y) <= EXPRESSION_AUDIBLE_RANGE,
  );
}

/**
 * 可聴範囲内の多数派シグナル(-1〜1)。forming/approaching/joined(参加へ動いている側)と
 * undecided/leaving(様子見・離脱側)の人数差の比率で、正なら参加ムード優勢、負なら様子見・離脱優勢。
 * 近傍が誰もいなければ0(同調圧力は働かない)。
 */
function majoritySignal(neighbors: Agent[]): number {
  let participating = 0;
  let notParticipating = 0;
  for (const neighbor of neighbors) {
    if (neighbor.state === "forming" || neighbor.state === "approaching" || neighbor.state === "joined") {
      participating += 1;
    } else {
      notParticipating += 1;
    }
  }
  const total = participating + notParticipating;
  return total === 0 ? 0 : (participating - notParticipating) / total;
}

/**
 * 本心(`PrivateEvaluation`)から対外表現(`PublicExpression`)を導出する純関数。
 * この関数が「本心→対外表現」変換の唯一の境界であり、Issue #114の乖離判定はすべてここに閉じる。
 *
 * 乖離判定(`PublicExpressionFactorKey`参照)は、既存personality・関係性・場の状態からの
 * 決定的計算のみで行う: 同一の`state`/`params`/`privateEvaluations`に対して常に同一の結果を返し、
 * rngを受け取らない/消費しない(乖離判定の有無でPRNG列・状態系列は変わらない)。
 * `state`はmutationせず、personality基礎値も一切変更しない。
 *
 * 関係性(`existingTieStrength`)は`derivePrivateEvaluations`と同じ経路
 * (`state.interventionId`→`resolveEffectiveParams`)で実効値へ解決する。
 * `config.enabled === false`(デフォルト)では空配列を返す。
 * 対応するAgentが`state.agents`に見つからない`PrivateEvaluation`(防御的、通常は起こらない)はスキップする。
 */
export function derivePublicExpressions(
  privateEvaluations: PrivateEvaluation[],
  state: SimulationState,
  params: SimParams,
  config: SocialExpressionConfig,
): PublicExpression[] {
  if (!config.enabled) return [];

  const intervention: InterventionRuntimeOptions | undefined = state.interventionId
    ? { interventionId: state.interventionId }
    : undefined;
  const effectiveParams = resolveEffectiveParams(params, intervention);
  const agentById = new Map(state.agents.map((agent) => [agent.id, agent]));

  const expressions: PublicExpression[] = [];
  for (const evaluation of privateEvaluations) {
    const agent = agentById.get(evaluation.agentId);
    if (!agent) continue;

    const neighbors = audibleNeighbors(agent, state.agents);
    const signal = majoritySignal(neighbors);

    // 遠慮(拒否回避): influenceAvoidanceが高いほど、中立値を超える積極さを打ち消す(最大で中立=無表明まで)
    const normalizedInfluenceAvoidance = clamp(agent.influenceAvoidance, 0, 1);
    const reserveContribution = normalizeZero(
      -normalizedInfluenceAvoidance * Math.max(0, evaluation.joinDesire - NEUTRAL_JOIN_DESIRE),
    );

    // 同調圧力: conformityが高いほど、可聴範囲内の多数派の方向へ表現を寄せる
    const normalizedConformity = clamp(agent.conformity, 0, 1);
    const conformityContribution = normalizeZero(normalizedConformity * CONFORMITY_PRESSURE_WEIGHT * signal);

    // 印象管理(社交辞令): 可聴範囲内に同一cliqueの相手がいるとき、関係が強いほど離脱傾向の表明を和らげる。
    // 緩和量は本心の離脱傾向(0〜1へclamp)に比例するため、表明が0未満へ反転することはない
    const hasNearbyCliqueMate =
      agent.cliqueId !== undefined && neighbors.some((neighbor) => neighbor.cliqueId === agent.cliqueId);
    const relationCloseness = hasNearbyCliqueMate ? clamp(effectiveParams.existingTieStrength, 0, 1) : 0;
    const impressionContribution = normalizeZero(
      -relationCloseness * IMPRESSION_SOFTENING_WEIGHT * clamp(evaluation.leaveInclination, 0, 1),
    );

    const joinFactors: PublicExpressionFactor[] = [
      {
        key: "reserve",
        dimension: "joinDesire",
        rawValue: agent.influenceAvoidance,
        normalizedValue: normalizedInfluenceAvoidance,
        contribution: reserveContribution,
      },
      {
        key: "conformityPressure",
        dimension: "joinDesire",
        rawValue: signal,
        normalizedValue: normalizedConformity,
        contribution: conformityContribution,
      },
    ];
    const leaveFactors: PublicExpressionFactor[] = [
      {
        key: "impressionManagement",
        dimension: "leaveInclination",
        rawValue: effectiveParams.existingTieStrength,
        normalizedValue: relationCloseness,
        contribution: impressionContribution,
      },
    ];

    const rawJoinDelta = reserveContribution + conformityContribution;
    const expressedJoinDesire = clamp(
      evaluation.joinDesire + clamp(rawJoinDelta, -MAX_DIVERGENCE_PER_DIMENSION, MAX_DIVERGENCE_PER_DIMENSION),
      0,
      1,
    );
    const rawLeaveDelta = impressionContribution;
    const expressedLeaveInclination = Math.max(
      0,
      evaluation.leaveInclination + clamp(rawLeaveDelta, -MAX_DIVERGENCE_PER_DIMENSION, MAX_DIVERGENCE_PER_DIMENSION),
    );

    const divergences: PublicExpressionDivergence[] = [
      {
        dimension: "joinDesire",
        privateValue: evaluation.joinDesire,
        expressedValue: expressedJoinDesire,
        rawDelta: rawJoinDelta,
        delta: expressedJoinDesire - evaluation.joinDesire,
        factors: joinFactors,
      },
      {
        dimension: "leaveInclination",
        privateValue: evaluation.leaveInclination,
        expressedValue: expressedLeaveInclination,
        rawDelta: rawLeaveDelta,
        delta: expressedLeaveInclination - evaluation.leaveInclination,
        factors: leaveFactors,
      },
    ];

    expressions.push({
      id: `public-${evaluation.tick}-${evaluation.agentId}`,
      privateEvaluationId: evaluation.id,
      tick: evaluation.tick,
      agentId: evaluation.agentId,
      expressedJoinDesire,
      expressedLeaveInclination,
      privateStance: stanceOfJoinDesire(evaluation.joinDesire),
      expressedStance: stanceOfJoinDesire(expressedJoinDesire),
      divergent: divergences.some((divergence) => Math.abs(divergence.delta) > DIVERGENCE_EPSILON),
      divergences,
    });
  }
  return expressions;
}
