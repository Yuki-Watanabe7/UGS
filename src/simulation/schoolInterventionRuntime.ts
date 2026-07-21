import type { Agent, GroupCandidate, LogTag, SimParams, SimulationEventMetadata, SimulationEventType } from "./types";
import type { FormationPolicy } from "./formationPolicy";
import type { InterventionScenarioId, SchoolInterventionHook } from "./interventions";
import { SeededRandom } from "./random";
// Issue #157: 個別の学校向け介入実装。`stableSortById`等の下記ヘルパー(すべて関数宣言でhoistされる)を
// これらが逆に参照する循環import(nearbyPeerPrompt.ts/openGroupSignal.ts -> このファイル)になるが、
// 参照はいずれもhandler関数の呼び出し時点(モジュール評価完了後)に限られるため安全(TDZの影響を受けない)。
import { nearbyPeerPromptIntervention } from "./schoolInterventions/nearbyPeerPrompt";
import { openGroupSignalIntervention } from "./schoolInterventions/openGroupSignal";
import { anonymousHelpSignalIntervention } from "./schoolInterventions/anonymousHelpSignal";
import { teacherRecommendationIntervention } from "./schoolInterventions/teacherRecommendation";

/**
 * Issue #156 (Phase 4): 学校向け介入(教師介入)の実行契約。
 *
 * 個別の学校向け介入(近接促進・空き枠表示・推薦・締切時強制割当等)の実装自体はこのIssueの対象外
 * ―― ここで定義するのは、後続Issueがそれぞれの介入ロジックだけを実装できるようにするための
 * 「土台」のみ:
 *   1. 学校向け介入が参照できる読み取り専用の実行コンテキスト(`SchoolInterventionContext`)
 *   2. 6つの実行フック(`SchoolInterventionHook`、`interventions.ts`で定義)。介入は`SchoolIntervention`の
 *      対応するプロパティを実装したフックだけを持てばよく、未実装フックは`runSchoolInterventionHook`が
 *      自動的にno-op(空の結果)として扱う。
 *   3. 介入が`SimulationState`を自由にmutationしないよう、結果を`InterventionEffect`(engineの
 *      判断式への一時的な加算補正、`speechEffects.ts`の`SpeechActiveEffect`と同じ設計)・
 *      `InterventionAction`(割当操作等、状態を直接書き換える必要がある結果)・`InterventionEvent`
 *      (構造化ログとして記録する結果)という3種類の明示的な値でのみ返させる。
 *   4. 対象選択に乱数が必要な場合に、本体`SeededRandom`を追加消費せず済む介入専用rng
 *      (`createInterventionRandom`)と、rngすら不要な決定的選択のための安定ソート(`stableSortById`)。
 *   5. 複数tickにまたがる介入の状態を集約する`InterventionRuntimeState`。
 *
 * `engine.ts`はこれらの型・関数だけを介して介入を呼び出し、介入IDごとの詳細(何をどう選ぶか)を
 * 一切知らない(受入条件: 学校向け介入をengineの巨大なID分岐へ追加せず実装できる)。
 * 二次会向け介入(`interventions.ts`の6シナリオ)はこの契約を経由しない、既存の
 * `engine.ts`内`interventionId`分岐のままの独立した軸であり、このファイルは一切参照しない。
 */

/**
 * 学校向け介入1件分の、あるhook呼び出し時点での読み取り専用スナップショット。
 * 介入はこれ以外の経路(クロージャ経由の外部状態等)で`SimulationState`を参照してはならない
 * (受入条件: 介入から`SimulationState`を自由にmutationさせない)。
 */
export type SchoolInterventionContext = {
  hook: SchoolInterventionHook;
  tick: number;
  agents: readonly Agent[];
  groupCandidates: readonly GroupCandidate[];
  /** 解決済みの形成ポリシー。成立最小人数・収容最大人数等は`formationPolicy.resolveGroupCapacity`経由で参照する */
  formationPolicy: FormationPolicy;
  params: SimParams;
  /** `formationPolicy`が締切概念を持つ場合のみ定義される締切tick(`classroomPair`系のみ) */
  deadlineTick?: number;
  /** このtick・このhook呼び出し時点までにengineが確定させた構造化イベント(表示用messageの解析は不要) */
  recentEvents: readonly { eventType?: SimulationEventType; metadata?: SimulationEventMetadata }[];
  /** このrunのbase seed。介入専用rngの導出元(本体`rng`とは独立、受入条件: 本体PRNG系列を不用意にずらさない) */
  runSeed: number;
  /** このrunを一意に識別するID(`createRunId`で導出)。UI/ログ相関用 */
  runId: string;
  runtimeState: InterventionRuntimeState;
};

/** engineの判断式(接近確率/魅力度/ストレス蓄積率/離脱しきい値)へ与える一時的な加算補正 */
export type InterventionEffectDimension =
  | "approachProbability"
  | "attractiveness"
  | "stressRate"
  | "leaveThreshold";

export type InterventionEffect = {
  dimension: InterventionEffectDimension;
  agentId: string;
  /** 加算される値(負値は抑制方向)。attractiveness限定で対象群を絞りたい場合は`targetGroupId`を使う */
  value: number;
  targetGroupId?: string;
  startedAtTick: number;
  expiresAtTick: number;
};

/**
 * 状態を直接書き換える必要がある結果(締切時強制割当等)。engineはこれをintervention IDごとの
 * 詳細を知らずに適用できる、汎用的な操作の集合として扱う。
 */
export type InterventionAction =
  | { kind: "assignToGroup"; agentId: string; groupId: string }
  | { kind: "markUnassigned"; agentId: string };

/** 構造化ログとして記録する結果。`metadata`は`SimulationEventMetadata`(Issue #156で拡張済み)をそのまま使う */
export type InterventionEvent = {
  message: string;
  tags?: LogTag[];
  eventType: SimulationEventType;
  metadata?: SimulationEventMetadata;
};

/** `runSchoolInterventionHook`の戻り値。すべて空(no-op)がデフォルト */
export type SchoolInterventionHookResult = {
  effects: InterventionEffect[];
  actions: InterventionAction[];
  events: InterventionEvent[];
  runtimeState: InterventionRuntimeState;
};

/** 個々のhookハンドラが返せる部分結果。省略したキーは空/変更なし扱いになる */
export type SchoolInterventionHookOutput = Partial<
  Pick<SchoolInterventionHookResult, "effects" | "actions" | "events" | "runtimeState">
>;

export type SchoolInterventionHookHandler = (
  ctx: SchoolInterventionContext,
) => SchoolInterventionHookOutput | void;

/**
 * 学校向け介入1件の実装。`id`以外の全プロパティは任意 —— 「教師強制割当だけがdeadlineフックを使い、
 * 低圧介入は通常tickフックを使う」といった責務の分離を、実装したいフックだけを持つことで表現できる。
 */
export type SchoolIntervention = {
  id: InterventionScenarioId;
  onInitialState?: SchoolInterventionHookHandler;
  onBeforeTick?: SchoolInterventionHookHandler;
  onBeforeApproachDecision?: SchoolInterventionHookHandler;
  onAfterStateTransition?: SchoolInterventionHookHandler;
  onBeforeDeadline?: SchoolInterventionHookHandler;
  onAtDeadline?: SchoolInterventionHookHandler;
};

const HOOK_HANDLER_KEY: Record<SchoolInterventionHook, keyof SchoolIntervention> = {
  initialState: "onInitialState",
  beforeTick: "onBeforeTick",
  beforeApproachDecision: "onBeforeApproachDecision",
  afterStateTransition: "onAfterStateTransition",
  beforeDeadline: "onBeforeDeadline",
  atDeadline: "onAtDeadline",
};

function emptyHookResult(runtimeState: InterventionRuntimeState): SchoolInterventionHookResult {
  return { effects: [], actions: [], events: [], runtimeState };
}

/**
 * `ctx.hook`に対応するハンドラを`intervention`から呼び出す。`intervention`が未指定、または
 * そのhookのハンドラを実装していない場合は常に`emptyHookResult`(no-op)を返す
 * (受入条件: 未実装フックはno-op、no-op介入は状態・イベント・本体PRNG系列を変えない)。
 * この関数自体はrngを一切参照しない(乱数が必要な介入は`ctx`から`createInterventionRandom`等を
 * 自前で呼ぶ)。
 */
export function runSchoolInterventionHook(
  intervention: SchoolIntervention | undefined,
  ctx: SchoolInterventionContext,
): SchoolInterventionHookResult {
  if (!intervention) return emptyHookResult(ctx.runtimeState);

  const handler = intervention[HOOK_HANDLER_KEY[ctx.hook]] as SchoolInterventionHookHandler | undefined;
  if (!handler) return emptyHookResult(ctx.runtimeState);

  const output = handler(ctx);
  if (!output) return emptyHookResult(ctx.runtimeState);

  return {
    effects: output.effects ?? [],
    actions: output.actions ?? [],
    events: output.events ?? [],
    runtimeState: output.runtimeState ?? ctx.runtimeState,
  };
}

// --- 決定的な対象選択と乱数分離 -------------------------------------------------------------

/** FNV-1a風の単純な文字列ハッシュ(divergenceTemplates.ts/expression.tsの表現専用rngパターンを踏襲) */
function hashString(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 学校向け介入の対象選択専用rngを、本体`SeededRandom`とは独立に導出する
 * (受入条件: 対象選択のための乱数消費が本体の行動乱数系列を不用意にずらさない)。
 * `runSeed`・介入ID・tick・`salt`(候補ID等、対象を絞りたい場合に使う)から決定的に導出するため、
 * 同一組み合わせなら常に同じ乱数系列になる(受入条件: 同一seed・同一介入設定で対象・発火tick・
 * イベント列が一致する)。この関数自体は本体`rng`を一切読み書きしない。
 */
export function createInterventionRandom(
  runSeed: number,
  interventionId: InterventionScenarioId,
  tick: number,
  salt = "",
): SeededRandom {
  return new SeededRandom(hashString(`${runSeed}:${interventionId}:${tick}:${salt}`));
}

/** rngを使わない決定的選択が必要な場合の安定ソート(id昇順)ヘルパー */
export function stableSortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** このrunを一意に識別するID(UI/ログ相関用)。同一引数なら常に同じ文字列になる */
export function createRunId(
  formationScenarioId: string,
  interventionId: InterventionScenarioId,
  runSeed: number,
): string {
  return `${formationScenarioId}:${interventionId}:${runSeed}`;
}

// --- 介入ランタイム状態 ----------------------------------------------------------------------

/**
 * 複数tickにまたがる学校向け介入の進行状態。agent本体(`Agent`)へ介入ごとの任意フィールドを
 * 増やし続けず、可能な限りここへ集約する(既存の`Agent.invitedAtTick`は後方互換のため維持され、
 * 移行は必須ではない)。`createInitialInterventionRuntimeState`が返す空状態が唯一の初期値であり、
 * Reset・seed変更・プリセット変更・シナリオ遷移はいずれも`createInitialState`の再呼び出しを経由する
 * (`engine.ts`側の他のPhase 3/4状態と同じ経路)ため、この状態も自動的に空へ初期化される。
 */
export type InterventionRuntimeState = {
  /** 介入済みagentId一覧(重複した声かけ・重複した推薦を避けるための汎用集合) */
  intervenedAgentIds: string[];
  /** 介入済みgroupId一覧 */
  intervenedGroupIds: string[];
  /** 介入の種類ごと(呼び出し側が決める任意キー)の最終発火tick */
  lastTriggeredAtTick: Record<string, number>;
  /** agentId -> 一時効果の期限tick */
  temporaryEffectExpiryByAgentId: Record<string, number>;
  /** agentId -> 推薦先groupId(Issue #158: `teacher-recommendation`が受諾済みの班推薦を追跡する) */
  recommendedGroupIdByAgentId: Record<string, string>;
  /**
   * Issue #158: agentId -> 推薦先peerAgentId。`teacher-recommendation`が受諾済みの新規組み合わせ推薦
   * (既存候補が無く、他の未決定agentとのペア形成を推薦した場合)を追跡する
   */
  recommendedPeerIdByAgentId: Record<string, string>;
  /**
   * Issue #158: agentId -> 受諾済み推薦(`recommendedGroupIdByAgentId`)が発行されたtick。
   * その後実際にその班へ参加した際、`schoolInterventionTriggered`(outcome: "assigned")の
   * `metadata.effectStartedAtTick`との差分から「推薦から参加までのtick」を導出するために保持する。
   */
  recommendationIssuedAtTick: Record<string, number>;
  /** 匿名通知済みagentId一覧 */
  anonymouslyNotifiedAgentIds: string[];
  /** 締切時強制割当を実行済みか */
  forcedAssignmentApplied: boolean;
};

export function createInitialInterventionRuntimeState(): InterventionRuntimeState {
  return {
    intervenedAgentIds: [],
    intervenedGroupIds: [],
    lastTriggeredAtTick: {},
    temporaryEffectExpiryByAgentId: {},
    recommendedGroupIdByAgentId: {},
    recommendedPeerIdByAgentId: {},
    recommendationIssuedAtTick: {},
    anonymouslyNotifiedAgentIds: [],
    forcedAssignmentApplied: false,
  };
}

// --- 効果の集計 -------------------------------------------------------------------------------

/**
 * `effects`のうち、`tick`時点で有効(`startedAtTick <= tick < expiresAtTick`)かつ`agentId`/`dimension`
 * (`targetGroupId`指定時はそれも)が一致するものの`value`を合計する。`speechEffects.ts`の
 * `sumActiveEffectValue`と同じ集計方針(engineの判断式へ加算するだけの単純な合計)。
 */
export function sumInterventionEffectValue(
  effects: readonly InterventionEffect[],
  agentId: string,
  dimension: InterventionEffectDimension,
  tick: number,
  targetGroupId?: string,
): number {
  let total = 0;
  for (const effect of effects) {
    if (effect.agentId !== agentId || effect.dimension !== dimension) continue;
    if (tick < effect.startedAtTick || tick >= effect.expiresAtTick) continue;
    if (targetGroupId !== undefined && effect.targetGroupId !== undefined && effect.targetGroupId !== targetGroupId) {
      continue;
    }
    total += effect.value;
  }
  return total;
}

/** 期限切れの`InterventionEffect`を`tick`時点で取り除く(`speechEffects.ts`の`advanceActiveSpeechEffects`と同じ設計) */
export function advanceInterventionEffects(
  effects: readonly InterventionEffect[],
  tick: number,
): InterventionEffect[] {
  return effects.filter((effect) => tick < effect.expiresAtTick);
}

/**
 * レジストリに登録済みの学校向け介入。Issue #156では土台のみ(常に空)だったが、
 * Issue #157で最初の2件(`nearby-peer-prompt`/`open-group-signal`)を登録した。
 */
const SCHOOL_INTERVENTION_POLICIES: Partial<Record<InterventionScenarioId, SchoolIntervention>> = {
  "nearby-peer-prompt": nearbyPeerPromptIntervention,
  "open-group-signal": openGroupSignalIntervention,
  "anonymous-help-signal": anonymousHelpSignalIntervention,
  "teacher-recommendation": teacherRecommendationIntervention,
};

/**
 * `id`に対応する`SchoolIntervention`を解決する。`SCHOOL_INTERVENTION_POLICIES`に未登録のIDは
 * 常に`undefined`を返す(=`runSchoolInterventionHook`が常にno-opになる)。後続Issueも同様に個別介入を
 * `SCHOOL_INTERVENTION_POLICIES`へ登録することでこの土台上に実装を追加できる。
 */
export function resolveSchoolIntervention(id: InterventionScenarioId): SchoolIntervention | undefined {
  return SCHOOL_INTERVENTION_POLICIES[id];
}
