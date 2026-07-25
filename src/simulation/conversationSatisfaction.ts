/**
 * Issue #187 (Phase 2): 会話満足度(`Agent.currentEpisode.conversationSatisfaction`)の初期化・
 * 時間変化・参加者変動モデル。`docs/conversation-satisfaction-model.md`(Issue #185, ADR)の
 * 契約に基づく純粋関数群 ―― `engine.ts`のtickループ・離脱意思決定・rngから独立しており、
 * 単体で検証できる(受入条件)。
 *
 * 対象外(ADR 1節・issue「対象外」節): 他clusterの魅力度比較、特定人物への好意、
 * observerJoiner固有の遠慮・愛着、話題の飽和・一致、満足度に基づく離脱確率の本実装(#188)。
 * ここではあくまで「今の会話エピソードの状態値」を計算するだけで、`evaluateClusterDeparture`
 * (離脱判定)へは一切接続しない。
 */
import type { Agent } from "./types";

/**
 * 会話満足度モデルの設定値。ADR 5.1節の方針どおり`SimParams`へは追加しない
 * (二次会・学校の既存validation/UI/seed結果への影響を避ける) ―― standingParty専用の
 * scenario configとしてこのモジュール内に閉じて置く。
 */
export type ConversationSatisfactionConfig = {
  /** join時点の基礎初期値 [0,1](人数・clique補正を加える前のベース値) */
  initialConversationSatisfaction: number;
  /** 1tickあたりの新鮮さの逓減量(>= 0)。小さい既定値とし、1tickで極端に0へ落ちないようにする */
  satisfactionDecayPerTick: number;
  /** 新規member1人あたりの新鮮さ回復量(>= 0)。0なら参加者増加による回復は一切起きない */
  newMemberFreshnessBoost: number;
  /** 同一tickに複数人の新規参加が観測された場合の、新鮮さ回復量の合算上限(>= 0) */
  maxNewMemberBoostPerTick: number;
  /** 「居心地のよい人数」の基準値(> 0)。実際の人数がここから離れるほど人数補正が下がる */
  preferredConversationSize: number;
  /** 人数補正(居心地のよい人数からの乖離によるペナルティ)の1tickあたりの上限(>= 0) */
  sizeMismatchPenaltyCap: number;
  /** 同clique構成補正の上限(>= 0)。`existingTieStrength=0`では常に補正0になる */
  cliqueCorrectionCap: number;
};

/**
 * ADR 7節「モデル上の注意」のとおり、ここでの数値は実データ較正前の仮説的な調整値であり、
 * 心理学的妥当性を主張しない(CLAUDE.mdのtuning方針と同じ性質)。
 * - `initialConversationSatisfaction = 0.6`: 満点でも0でもない中庸な基礎値からスタートし、
 *   人数・clique補正がその後の個体差を作れるようにする。
 * - `satisfactionDecayPerTick = 0.01`: `stress`蓄積(既存)と同様、1tickあたりの変化を小さく保ち、
 *   1tickで極端に0へ落ちない(要件)。
 * - `preferredConversationSize = 4`: 既定`groupConfirmSize`(3、presets.ts)より一段大きい、
 *   「成立直後よりもう少し賑わった状態」を居心地の基準とする。
 */
export const DEFAULT_CONVERSATION_SATISFACTION_CONFIG: ConversationSatisfactionConfig = {
  initialConversationSatisfaction: 0.6,
  satisfactionDecayPerTick: 0.01,
  newMemberFreshnessBoost: 0.05,
  maxNewMemberBoostPerTick: 0.15,
  preferredConversationSize: 4,
  sizeMismatchPenaltyCap: 0.03,
  cliqueCorrectionCap: 0.2,
};

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`conversationSatisfaction config: ${name} must be a finite number (got ${value})`);
  }
}

function assertRange(name: string, value: number, min: number, max: number): void {
  assertFinite(name, value);
  if (value < min || value > max) {
    throw new Error(`conversationSatisfaction config: ${name} must be within [${min}, ${max}] (got ${value})`);
  }
}

function assertNonNegative(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0) {
    throw new Error(`conversationSatisfaction config: ${name} must be >= 0 (got ${value})`);
  }
}

/**
 * NaN/Infinity/範囲外/負の減衰率等を明示的に拒否する(issue要件: 安全に正規化するのではなく、
 * 不正な設定を実行前に検知して即座に失敗させる ―― 学校シナリオの
 * `validateClassroomGroupFormationOptions`と同じ方針)。
 */
export function validateConversationSatisfactionConfig(config: ConversationSatisfactionConfig): void {
  assertRange("initialConversationSatisfaction", config.initialConversationSatisfaction, 0, 1);
  assertNonNegative("satisfactionDecayPerTick", config.satisfactionDecayPerTick);
  assertNonNegative("newMemberFreshnessBoost", config.newMemberFreshnessBoost);
  assertNonNegative("maxNewMemberBoostPerTick", config.maxNewMemberBoostPerTick);
  assertFinite("preferredConversationSize", config.preferredConversationSize);
  if (config.preferredConversationSize <= 0) {
    throw new Error(
      `conversationSatisfaction config: preferredConversationSize must be > 0 (got ${config.preferredConversationSize})`,
    );
  }
  assertNonNegative("sizeMismatchPenaltyCap", config.sizeMismatchPenaltyCap);
  assertNonNegative("cliqueCorrectionCap", config.cliqueCorrectionCap);
}

validateConversationSatisfactionConfig(DEFAULT_CONVERSATION_SATISFACTION_CONFIG);

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 「居心地のよい人数」からの乖離を[0,1]へ正規化してからペナルティ化する ―― 2人/3〜4人/大人数の
 * 違いを滑らかに扱い(要件5節)、`Math.min(..., 1)`によって収容人数無制限のstandingParty
 * クラスタでも発散しない(要件: 大人数でもNaN/Infinityにならない、容量無制限でも補正が発散しない)。
 */
function sizeAdjustment(memberCount: number, config: ConversationSatisfactionConfig): number {
  const normalizedDeviation = Math.abs(memberCount - config.preferredConversationSize) / config.preferredConversationSize;
  return -Math.min(normalizedDeviation, 1) * config.sizeMismatchPenaltyCap;
}

/**
 * `existingTieStrength=0`では常に0になる(要件)。`attractiveness()`(engine.ts)の
 * 同clique bonus/outsider penaltyと「同席者の構成が既存関係とどれだけ噛み合うか」という
 * 意味は共有するが、接近魅力度の式(dominant cliqueの占有率ベース)とは別の式として保つ
 * (ADR 6節: 同一関数にしない)。ここでは「エージェント自身のclique仲間の比率」を直接使う。
 */
function cliqueAdjustment(cliqueRatio: number, existingTieStrength: number, config: ConversationSatisfactionConfig): number {
  return clamp01(cliqueRatio) * clamp01(existingTieStrength) * config.cliqueCorrectionCap;
}

/**
 * 現在の同席者(`memberIds`、自分自身を含む)のうち、自分と同じcliqueに属する比率を返す。
 * 自分自身は分母・分子から除外する(要件: 自分自身のjoinを新規member参加と二重に数えない、
 * と同じ理由で「自分以外の同clique率」を見る)。cliqueId未設定のagentは常に0。
 */
export function computeCliqueMateRatio(
  agentId: string,
  agentCliqueId: number | undefined,
  memberIds: string[],
  agents: Agent[],
): number {
  if (agentCliqueId === undefined) return 0;
  const others = memberIds.filter((id) => id !== agentId);
  if (others.length === 0) return 0;
  const matches = others.filter((id) => agents.find((a) => a.id === id)?.cliqueId === agentCliqueId).length;
  return matches / others.length;
}

export type ConversationSatisfactionInitContext = {
  config: ConversationSatisfactionConfig;
  /** 合流が成立した瞬間の同席人数(自分自身を含む、`ConversationEpisode.memberCountAtJoin`と同じ値) */
  memberCountAtJoin: number;
  /** 合流時点での同clique比率(`computeCliqueMateRatio`) */
  cliqueRatio: number;
  /** `SimParams.existingTieStrength` */
  existingTieStrength: number;
};

/**
 * 会話エピソード開始時の満足度を決定的に初期化する(要件: 同じ入力からは同じ出力、rngを消費しない)。
 * observerJoinerだけを特別扱いしない(受入条件) ―― `isObserverJoiner`はこの関数のいかなる入力にも
 * 現れない。forming輪への参加/activeクラスタへの途中参加の違いは、`memberCountAtJoin`が
 * 前者では小さく後者では大きくなりやすいという既存の構造差を通じて自然に反映される
 * (専用のフラグ・追加定数は導入しない ―― 未検証の一時定数を増やさない設計判断)。
 */
export function initializeConversationSatisfaction(ctx: ConversationSatisfactionInitContext): number {
  const { config } = ctx;
  const size = sizeAdjustment(ctx.memberCountAtJoin, config);
  const clique = cliqueAdjustment(ctx.cliqueRatio, ctx.existingTieStrength, config);
  return clamp01(config.initialConversationSatisfaction + size + clique);
}

export type ConversationSatisfactionUpdateContext = {
  config: ConversationSatisfactionConfig;
  /** 直前tickまでの満足度 */
  previousSatisfaction: number;
  /**
   * 直近の更新時点で観測済みの同席人数(`ConversationEpisode.lastObservedMemberCount`)。
   * 新規member参加の検出用ベースライン。
   */
  lastObservedMemberCount: number;
  /**
   * このtick開始時点(=前tick終了時点)で観測された同席人数。ADR 3.3節の順序ルールにより、
   * 「このtickのstep1-3で加入/離脱した人」は含めない ―― engine.ts側が`state.groupCandidates`
   * (このtickの合流/離脱処理より前のスナップショット)から渡す。人数補正・新規member検出の
   * 両方をこの1つの値だけから導出することで、同一tick内の他agentの処理順に一切依存しない
   * (ADR 3.3節: 処理順による結果の暗黙変化を排除する)。
   */
  observedMemberCount: number;
  /** このtickの同clique比率(`computeCliqueMateRatio`) */
  cliqueRatio: number;
  /** `SimParams.existingTieStrength` */
  existingTieStrength: number;
};

/** 各寄与要因を含む更新結果(要件7節: 少なくともこれらを返す) */
export type ConversationSatisfactionUpdateResult = {
  previousSatisfaction: number;
  nextSatisfaction: number;
  /** 滞在時間による新鮮さ逓減分(<= 0) */
  decayContribution: number;
  /** 新規member参加による回復分(>= 0、`maxNewMemberBoostPerTick`で頭打ち) */
  newMemberContribution: number;
  /**
   * 人数補正分(要件7節「departure / size contribution」を1つの値として扱う ―― member離脱の
   * 効果は「人数が居心地のよい人数からどれだけ離れたか」という本項に自然に現れるため、
   * 離脱専用の固定ペナルティは別途設けない。ADR「member減少が必ず悪影響とは限らない」を
   * 人数最適性の枠組みで扱うという設計判断)。
   */
  sizeContribution: number;
  /** 同clique構成による補正分(>= 0) */
  cliqueContribution: number;
};

/**
 * 1tick分の会話満足度更新(ADR 3.2節 step 5a)。呼び出し側は`joined`かつ有効なclusterに
 * 所属しているagentについて、tickごとに一度だけ呼び出す想定 ――
 * 合流したその場のtick(滞在0tick)では呼び出さない(engine.ts側の責務。このtickの
 * 初期化はすでに`initializeConversationSatisfaction`が済ませているため)。
 * rngを一切参照しないため、有効/無効の切り替えはPRNG消費順序に影響しない。
 */
export function updateConversationSatisfaction(
  ctx: ConversationSatisfactionUpdateContext,
): ConversationSatisfactionUpdateResult {
  const { config } = ctx;
  const decayContribution = -config.satisfactionDecayPerTick;
  const arrivedSinceLastObservation = Math.max(0, ctx.observedMemberCount - ctx.lastObservedMemberCount);
  const newMemberContribution = Math.min(
    arrivedSinceLastObservation * config.newMemberFreshnessBoost,
    config.maxNewMemberBoostPerTick,
  );
  const sizeContribution = sizeAdjustment(ctx.observedMemberCount, config);
  const cliqueContribution = cliqueAdjustment(ctx.cliqueRatio, ctx.existingTieStrength, config);
  const nextSatisfaction = clamp01(
    ctx.previousSatisfaction + decayContribution + newMemberContribution + sizeContribution + cliqueContribution,
  );
  return {
    previousSatisfaction: ctx.previousSatisfaction,
    nextSatisfaction,
    decayContribution,
    newMemberContribution,
    sizeContribution,
    cliqueContribution,
  };
}
