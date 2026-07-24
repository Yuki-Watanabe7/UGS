import type {
  Agent,
  ApproachFailureReason,
  GroupCandidate,
  LogEntry,
  LogTag,
  SimParams,
  SimulationEventMetadata,
  SimulationEventType,
  SimulationFinishReason,
  SimulationState,
} from "./types";
import type { InterventionRuntimeOptions, InterventionScenarioId, SchoolInterventionHook } from "./interventions";
import type { FormationPolicy, FormationRuntimeOptions, GroupCapacity } from "./formationPolicy";
import { DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK, resolveFormationPolicy } from "./formationPolicy";
import type {
  InterventionAction,
  InterventionEffect,
  InterventionRuntimeState,
  SchoolIntervention,
  SchoolInterventionContext,
} from "./schoolInterventionRuntime";
import {
  advanceInterventionEffects,
  createInitialInterventionRuntimeState,
  createRunId,
  resolveSchoolIntervention,
  runSchoolInterventionHook,
  sumInterventionEffectValue,
} from "./schoolInterventionRuntime";
import type { SpeechEvent } from "./speech";
import { createSpeechEvent, deriveSpeechEvents } from "./speech";
import type { SpeechActiveEffect, SpeechEffectsConfig } from "./speechEffects";
import {
  advanceActiveSpeechEffects,
  deriveSpeechActiveEffects,
  deriveSpeechEffects,
  deriveSpeechInterpretations,
  deriveSpeechReceptions,
  registerActiveSpeechEffects,
  resolveSpeechEffectsConfig,
  sumActiveEffectValue,
} from "./speechEffects";
import {
  applyLightInvitationEffect,
  isUnderLightInvitationBoost,
  LIGHT_INVITATION_APPROACH_MULTIPLIER,
  LIGHT_INVITATION_INFLUENCE_AVOIDANCE_RESIDUAL,
  LIGHT_INVITATION_STRESS_MULTIPLIER,
  resolveEffectiveParams,
  resolveInterventionScenario,
  selectInvitationAgent,
  shouldTriggerLightObserverInvitation,
} from "./interventions";
import { SeededRandom } from "./random";
import { WORLD_WIDTH, WORLD_HEIGHT, clamp, distance, createInitialAgents } from "./model";
import { formatTick } from "./time";
// Issue #115: 発言生成の後段調整(乖離を反映した対外発言の選択)のためだけの依存。
// socialExpression.ts側もattractiveness等のためにengine.tsをimportする循環参照になるが、
// どちらもモジュール初期化時には相手側の値を評価しない(関数呼び出し時のみ参照する)ため安全。
// engineの状態遷移・行動判断式そのものへの接続は引き続き存在しない。
import type { SocialExpressionConfig } from "./socialExpression";
import {
  applyPublicExpressionsToSpeech,
  derivePrivateEvaluations,
  derivePublicExpressions,
  resolveSocialExpressionConfig,
} from "./socialExpression";
import type { SpeechTrustConfig } from "./speechTrust";
import {
  createSpeechTrustResolver,
  deriveSpeechTrustUpdates,
  deriveSpeechTruthfulness,
  registerSpeechTrustCommitments,
  resolveSpeechTrustConfig,
} from "./speechTrust";
import type { RelationshipTieConfig } from "./relationshipTie";
import {
  aggregateGroupTieCorrection,
  createTieCorrectionResolver,
  deriveTieCorrections,
  deriveTieObservations,
  registerTieCommitments,
  resolveRelationshipTieConfig,
} from "./relationshipTie";

const APPROACH_SPEED = 14;
const WANDER_SPEED = 0.5;
const JOIN_DISTANCE = 26;
// dissolving/dissolved/expired が画面上に留まる(フェードアウト表現用の)tick数。これを超えたら配列から除去する
const CANDIDATE_LINGER_TICKS = 4;
// Issue #133: 参加失敗した候補への即時再接近を避けるクールダウンtick数。
// `maxGroupSize`はcandidate存続中に変化しないため実質恒久的な除外に近いが、明示的な制御として持たせる
const REAPPROACH_COOLDOWN_TICKS = 8;
// Issue #176: クラスタ離脱直後、同じクラスタへ即座に再接近するのを避けるクールダウンtick数
// (責務9の判定式そのものではなく、離脱後の移動・再探索という「経路」側の制御)
const CLUSTER_REJOIN_COOLDOWN_TICKS = 10;
// Issue #176: クラスタ離脱時、離脱元の中心から一度に離れる距離。JOIN_DISTANCE(26)より大きくして
// 「同じ場所に重なったまま即時再参加」を避ける(3節の受入条件)
const CLUSTER_DEPARTURE_STEP_DISTANCE = 34;

// `predecided-venue`: 成立済みグループへのattractivenessに加える固定ボーナス
const PREDECIDED_VENUE_CONFIRMED_BONUS = 0.25;
// `predecided-venue`: observerJoinerの「行き場がない」ことに起因する追加ストレスの倍率
const PREDECIDED_VENUE_STRESS_MULTIPLIER = 0.4;
// `short-ambiguity-window`: 同じ追加ストレスに対する倍率(predecided-venueほど強くはない)
const SHORT_AMBIGUITY_WINDOW_STRESS_MULTIPLIER = 0.5;
// `short-ambiguity-window`: 未成立候補の弱反応解散/期限切れ判断を早めるための短縮率
const SHORT_AMBIGUITY_WINDOW_AGE_FACTOR = 0.5;
// `explicit-meeting-point`: 集合場所でのattractivenessにおける影響回避の壁の残存率
// (影響回避が高くても、公開済みの集合場所へ向かうこと自体は「場を動かす」ことにならないため壁が薄くなる)
const MEETING_POINT_INFLUENCE_AVOIDANCE_RESIDUAL = 0.4;
// `late-join-ok`: 成立済みグループへのattractivenessに加える固定ボーナス
// (predecided-venueより小さい。「行き先」自体ではなく「後から入ってよいという許可」への反応のため)
const LATE_JOIN_OK_CONFIRMED_BONUS = 0.15;
// `late-join-ok`: hasWelcomingConfirmedGroup判定で「歓迎されていない」とみなす、
// 単一cliqueによる占有率のしきい値(通常は0.5)。明示的な許可があるほど、
// ある程度clique優勢な成立済みグループでも「行き場がない」とはみなされにくくする
const LATE_JOIN_OK_WELCOMING_DOMINANCE_THRESHOLD = 0.85;
// `anonymous-low-pressure-intent`: forming候補への接近確率にかける倍率
// (「参加したい」と直接言わなくてよいため、輪に近づくこと自体の抵抗が少し下がる)
const ANONYMOUS_INTENT_APPROACH_MULTIPLIER = 1.25;
// `anonymous-low-pressure-intent`: 核形成確率にかける倍率
// (匿名の合図により「参加したい人が一定数いる」ことが主導者/既存グループに伝わりやすくなるが、
// 強い主導者を追加したような挙動にならないよう控えめな値に留める)
const ANONYMOUS_INTENT_FORMING_PROBABILITY_MULTIPLIER = 1.2;
// `anonymous-low-pressure-intent`: observerJoinerの「行き場がない」ことに起因する追加ストレスの倍率
const ANONYMOUS_INTENT_STRESS_MULTIPLIER = 0.6;

export function createInitialState(
  seed: number,
  params: SimParams,
  intervention?: InterventionRuntimeOptions,
  speechEffects?: Partial<SpeechEffectsConfig>,
  socialExpression?: Partial<SocialExpressionConfig>,
  speechTrust?: Partial<SpeechTrustConfig>,
  relationshipTie?: Partial<RelationshipTieConfig>,
  formation?: FormationRuntimeOptions,
  /**
   * Issue #175: 意味論的な自然終了を持たないシナリオ(`standingParty`)向けの、観測期間の上限tick
   * (observation horizon)。省略時は上限なし(対話的UI実行を想定、手動のpause/resume/resetのみで
   * 実行を制御する)。詳細は`SimulationState.observationHorizonTick`のコメント参照。
   */
  observationHorizonTick?: number,
): SimulationState {
  const scenario = resolveInterventionScenario(intervention);
  const formationPolicy = resolveFormationPolicy(formation);
  const speechEffectsConfig = resolveSpeechEffectsConfig(speechEffects);
  const socialExpressionConfig = resolveSocialExpressionConfig(socialExpression);
  const speechTrustConfig = resolveSpeechTrustConfig(speechTrust);
  const relationshipTieConfig = resolveRelationshipTieConfig(relationshipTie);
  const effectiveParams = resolveEffectiveParams(params, intervention);
  const agents = createInitialAgents(seed, effectiveParams);
  // Issue #132: 教室ペア形成シナリオの初期ログは、二次会シナリオ向けの文言(「二次会に行くか」)を
  // そのまま使うと文脈が合わないため、formationPolicy.idで出し分ける
  // Issue #174: 立食パーティーでも同様に、二次会固有の文言を避け会場で会話の輪を探す文脈にする
  const openingMessage =
    formationPolicy.id === "classroomPair"
      ? "先生が「自由にペアを作ってください」と指示した。まだ誰も相手を決めていない。"
      : formationPolicy.id === "standingParty"
        ? "立食パーティーの会場に参加者が集まり始めた。まだ誰も会話の輪に加わっていない。"
        : "参加者が集まり始めた。まだ誰も二次会に行くかは決めていない。";
  const log: LogEntry[] = [
    {
      tick: 0,
      message: openingMessage,
      tags: ["simulation"],
      eventType: "simulationStarted",
    },
  ];
  if (scenario.id !== "none") {
    log.push({
      tick: 0,
      message: `${formatTick(0)} 介入シナリオ「${scenario.name}」が適用された`,
      tags: ["intervention"],
      eventType: "interventionApplied",
      metadata: { interventionId: scenario.id },
    });
  }

  const groupCandidates: GroupCandidate[] = [];
  if (scenario.id === "explicit-meeting-point") {
    const meetingPoint: GroupCandidate = {
      id: `group-0-meeting-point`,
      x: WORLD_WIDTH / 2,
      y: WORLD_HEIGHT / 2,
      memberIds: [],
      status: "forming",
      age: 0,
      isPublicMeetingPoint: true,
    };
    groupCandidates.push(meetingPoint);
    pushLog(
      log,
      0,
      `幹事が「行く人は店の前に集まりましょう」と集合場所を明示した`,
      ["intervention"],
      "publicMeetingPointEstablished",
      { groupId: meetingPoint.id },
    );
  }
  if (scenario.id === "late-join-ok") {
    pushLog(
      log,
      0,
      `誰かが「途中参加OK、後から合流してもいいよ」と明示した`,
      ["intervention"],
      "lateJoinPermissionAnnounced",
    );
  }
  if (scenario.id === "anonymous-low-pressure-intent") {
    pushLog(
      log,
      0,
      `挙手ではなく紙に丸をつけるような、匿名・低圧に参加意向を示せる方法が用意された`,
      ["intervention"],
      "anonymousIntentSignalAnnounced",
    );
  }

  // Issue #156: 学校向け介入の"initialState"フック。登録済み介入が存在しない間は常にno-op。
  const initialDeadlineTick =
    formationPolicy.id === "classroomPair"
      ? (formation?.formationDeadlineTick ?? DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK)
      : undefined;
  const initialInterventionEffects: InterventionEffect[] = [];
  const interventionRuntimeState = fireSchoolInterventionHook(
    resolveSchoolIntervention(scenario.id),
    buildSchoolInterventionContext(
      "initialState",
      0,
      agents,
      groupCandidates,
      formationPolicy,
      effectiveParams,
      initialDeadlineTick,
      [],
      log,
      seed,
      createRunId(formationPolicy.id, scenario.id, seed),
      createInitialInterventionRuntimeState(),
    ),
    agents,
    groupCandidates,
    formationPolicy,
    effectiveParams,
    log,
    initialInterventionEffects,
  );

  return {
    tick: 0,
    agents,
    groupCandidates,
    log,
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    finished: false,
    seed,
    interventionId: scenario.id,
    formationScenarioId: formationPolicy.id,
    formationDeadlineTick: formation?.formationDeadlineTick,
    formationClassroomGroupSize: formation?.classroomGroupSize,
    observationHorizonTick,
    interventionRuntimeState,
    activeInterventionEffects: initialInterventionEffects,
    speechLog: [],
    speechReceptionLog: [],
    speechInterpretationLog: [],
    speechEffectLog: [],
    speechEffectsEnabled: speechEffectsConfig.enabled,
    socialExpressionEnabled: socialExpressionConfig.enabled,
    activeSpeechEffects: [],
    speechTrustEnabled: speechTrustConfig.enabled,
    speechTrust: {},
    speechTrustUpdateLog: [],
    speechTruthfulnessLog: [],
    speechTrustCommitments: [],
    relationshipTieEnabled: relationshipTieConfig.enabled,
    tieHistory: {},
    relationshipTieUpdateLog: [],
    tieCommitments: [],
  };
}

function pushLog(
  log: LogEntry[],
  tick: number,
  message: string,
  tags: LogTag[] = [],
  eventType?: SimulationEventType,
  metadata?: SimulationEventMetadata,
): void {
  log.push({ tick, message: `${formatTick(tick)} ${message}`, tags, eventType, metadata });
}

/** Issue #131: `addMemberToCandidate`の結果。呼び出し側はこれを見て成功/失敗を判断する */
export type AddMemberOutcome = "added" | "alreadyMember" | "full";

/**
 * candidate.memberIdsへの追加は必ずこの関数を通し、同一agentの重複登録と`capacity.maxGroupSize`
 * を超える追加を防ぐ。既に埋まっている場合は候補を一切変更せず"full"を返す(呼び出し側が
 * フォールバック——新規候補の作成、または合流を諦めてundecidedへ戻す等——を決める)。
 */
function addMemberToCandidate(candidate: GroupCandidate, agentId: string, capacity: GroupCapacity): AddMemberOutcome {
  if (candidate.memberIds.includes(agentId)) return "alreadyMember";
  if (isCandidateFull(candidate, capacity)) return "full";
  candidate.memberIds.push(agentId);
  return "added";
}

/** Issue #131: `capacity.maxGroupSize`に対して現在人数が既に埋まっているか(派生判定。専用のstatusは持たない) */
export function isCandidateFull(candidate: GroupCandidate, capacity: GroupCapacity): boolean {
  return candidate.memberIds.length >= capacity.maxGroupSize;
}

/**
 * Issue #176 (ADR 3.3節「join/leave時のagent側・cluster側の原子的更新」): candidate.memberIdsからの
 * 除去は必ずこの関数を通す。`addMemberToCandidate`と対になるヘルパーで、対象が既に含まれていなければ
 * 何もせず"notMember"を返す(受入条件: 離脱開始・完了を複数回行ってもmemberが二重削除されない)。
 */
function detachMemberFromCandidate(candidate: GroupCandidate, agentId: string): "removed" | "notMember" {
  const index = candidate.memberIds.indexOf(agentId);
  if (index === -1) return "notMember";
  candidate.memberIds.splice(index, 1);
  return "removed";
}

/**
 * Issue #131: 構造化イベントmetadataへ定員・空き人数を載せる際の共通ヘルパー。
 * `maxGroupSize`が有限(候補固有のオーバーライド等で実際に容量制限がある)場合のみ値を持たせ、
 * 「実質無制限」(Number.POSITIVE_INFINITY)の場合はmetadataに含めない(JSON化できない値を
 * ログへ持ち込まないため、かつ無制限であることを示す情報に実質的な価値がないため)。
 */
function capacityMetadataFields(
  capacity: GroupCapacity,
  memberCount: number,
): { maxGroupSize?: number; remainingCapacity?: number } {
  if (!Number.isFinite(capacity.maxGroupSize)) return {};
  return { maxGroupSize: capacity.maxGroupSize, remainingCapacity: capacity.maxGroupSize - memberCount };
}

// --- Issue #156: 学校向け介入(教師介入)の実行契約の結線 ----------------------------------------
// 個別介入の実装自体はこのIssueの対象外であり、`resolveSchoolIntervention`は常に`undefined`を
// 返す(=以下のフック呼び出しは常にno-op)。詳細な設計はschoolInterventionRuntime.ts参照。

/**
 * `SchoolInterventionContext`を組み立てる。`agents`/`groupCandidates`はこの時点のスナップショットを
 * そのまま渡す(読み取り専用として扱う契約は呼び出し側=介入実装の責務。この関数自体はコピーしない)。
 */
function buildSchoolInterventionContext(
  hook: SchoolInterventionHook,
  tick: number,
  agents: Agent[],
  candidates: GroupCandidate[],
  formationPolicy: FormationPolicy,
  params: SimParams,
  deadlineTick: number | undefined,
  priorLog: LogEntry[],
  tickLog: LogEntry[],
  runSeed: number,
  runId: string,
  runtimeState: InterventionRuntimeState,
): SchoolInterventionContext {
  return {
    hook,
    tick,
    agents,
    groupCandidates: candidates,
    formationPolicy,
    params,
    deadlineTick,
    recentEvents: [...priorLog, ...tickLog].map((entry) => ({ eventType: entry.eventType, metadata: entry.metadata })),
    runSeed,
    runId,
    runtimeState,
  };
}

/**
 * `actions`(割当操作等)を汎用的に適用する。engineは`InterventionAction.kind`だけを見て処理し、
 * どの介入がこのactionを生成したかは一切参照しない(受入条件: engineが介入IDごとの詳細を知らずに
 * 結果を適用できる)。
 */
/**
 * 割当系action(`assignToGroup`/`createGroup`)が実際に成立させたjoinについて、接近中の残存速度・
 * 直前の参加失敗クールダウンを一括で片付ける(受入条件: approaching中のagentを割り当てる場合、
 * 古いtargetやcooldownをクリアする)。位置も候補の座標へ揃え(#149の成立済み表示上、
 * 割り当てられた本人がその班の位置に居るように見せるため)、以後の移動計算に残存速度を残さない。
 */
function settleIntoGroup(agent: Agent, candidate: GroupCandidate, tick: number): void {
  agent.state = "joined";
  agent.joinedGroupId = candidate.id;
  agent.x = candidate.x;
  agent.y = candidate.y;
  agent.vx = 0;
  agent.vy = 0;
  agent.lastFailedCandidateId = undefined;
  agent.lastFailedCandidateAtTick = undefined;
  // Issue #176: 責務9(クラスタ離脱判定)の滞在tick計算に使う合流tick。classroomPair等
  // 離脱経路を持たないシナリオでは参照されないが、settleIntoGroup経由の全joinで一貫して設定する。
  agent.clusterJoinedAtTick = tick;
}

function applyInterventionActions(
  agents: Agent[],
  candidates: GroupCandidate[],
  actions: InterventionAction[],
  formationPolicy: FormationPolicy,
  params: SimParams,
  tick: number,
): void {
  for (const action of actions) {
    if (action.kind === "createGroup") {
      // Issue #159: 呼び出し側(介入実装)がmin/maxを満たす構成のみをここへ渡す契約だが、
      // 防御的にも検証する(受入条件: min未満・max超過のconfirmed班を作らない)。
      if (action.memberIds.length < action.minGroupSize || action.memberIds.length > action.maxGroupSize) continue;
      const memberAgents = action.memberIds
        .map((id) => agents.find((a) => a.id === id))
        .filter((a): a is Agent => a !== undefined);
      if (memberAgents.length !== action.memberIds.length) continue;

      const candidate: GroupCandidate = {
        id: action.groupId,
        x: action.x,
        y: action.y,
        memberIds: [...action.memberIds],
        status: "confirmed",
        age: 0,
        minGroupSize: action.minGroupSize,
        maxGroupSize: action.maxGroupSize,
      };
      candidates.push(candidate);
      for (const memberAgent of memberAgents) settleIntoGroup(memberAgent, candidate, tick);
      continue;
    }

    const agent = agents.find((a) => a.id === action.agentId);
    if (!agent) continue;

    if (action.kind === "assignToGroup") {
      const candidate = candidates.find((c) => c.id === action.groupId);
      if (!candidate) continue;
      const capacity = formationPolicy.resolveGroupCapacity(candidate, params);
      if (addMemberToCandidate(candidate, agent.id, capacity) === "full") continue;
      settleIntoGroup(agent, candidate, tick);
    } else if (action.kind === "removeFromGroup") {
      const candidate = candidates.find((c) => c.id === action.groupId);
      if (!candidate) continue;
      candidate.memberIds = candidate.memberIds.filter((id) => id !== agent.id);
    } else if (action.kind === "markUnassigned") {
      agent.state = "unassigned";
      agent.joinedGroupId = undefined;
    }
  }
}

/**
 * `hook`を発火し、その結果(`events`/`actions`/`effects`)を`log`/`agents`/`candidates`/
 * `collectedEffects`へ反映したうえで、更新後の`InterventionRuntimeState`を返す。
 * `schoolIntervention`が`undefined`(=登録済み介入なし。現状は常にこれ)の間は
 * `runSchoolInterventionHook`が空の結果を返すため、この呼び出し全体が実質no-opになる。
 */
function fireSchoolInterventionHook(
  schoolIntervention: SchoolIntervention | undefined,
  ctx: SchoolInterventionContext,
  agents: Agent[],
  candidates: GroupCandidate[],
  formationPolicy: FormationPolicy,
  params: SimParams,
  log: LogEntry[],
  collectedEffects: InterventionEffect[],
): InterventionRuntimeState {
  const result = runSchoolInterventionHook(schoolIntervention, ctx);

  applyInterventionActions(agents, candidates, result.actions, formationPolicy, params, ctx.tick);
  for (const event of result.events) {
    pushLog(log, ctx.tick, event.message, event.tags ?? ["intervention"], event.eventType, event.metadata);
  }
  collectedEffects.push(...result.effects);

  return result.runtimeState;
}

/**
 * 解散中・解散済み・期限切れの候補は接近/合流対象として扱わない。
 * Issue #131: `capacity`を渡すと満員判定も含める。省略時は状態のみの判定(既存呼び出し元との後方互換用。
 * 既に参加済みのメンバーにとって自分の輪がまだ有効かを確認する用途では、容量は無関係なので省略する)。
 */
export function isJoinable(candidate: GroupCandidate, capacity?: GroupCapacity): boolean {
  const statusOk = candidate.status === "forming" || candidate.status === "confirmed";
  if (!statusOk) return false;
  return capacity ? !isCandidateFull(candidate, capacity) : true;
}

export function nearestCandidate(
  agent: Agent,
  candidates: GroupCandidate[],
  capacityOf?: (candidate: GroupCandidate) => GroupCapacity,
  /**
   * Issue #133/#176: 再探索時のクールダウン制御用。指定されたID群の候補は(満員/消滅で既に
   * 除外されているかどうかに関わらず)この呼び出しでは選択肢から外す。省略時は従来どおり除外しない。
   * Issue #176で、参加失敗クールダウン(単一ID)とクラスタ離脱クールダウン(単一ID)を同時に
   * 除外できるよう、単一IDからSetへ一般化した。
   */
  excludeIds?: ReadonlySet<string>,
): GroupCandidate | undefined {
  let best: GroupCandidate | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (excludeIds !== undefined && excludeIds.has(c.id)) continue;
    if (!isJoinable(c, capacityOf?.(c))) continue;
    const d = distance(agent.x, agent.y, c.x, c.y);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** そのグループ候補で最も多いcliqueIdとその占有率を返す(既存関係性がない/バラバラな場合はundefined) */
export function dominantClique(
  candidate: GroupCandidate,
  agents: Agent[],
): { cliqueId: number; ratio: number } | undefined {
  const counts = new Map<number, number>();
  for (const id of candidate.memberIds) {
    const cliqueId = agents.find((a) => a.id === id)?.cliqueId;
    if (cliqueId !== undefined) counts.set(cliqueId, (counts.get(cliqueId) ?? 0) + 1);
  }
  if (candidate.memberIds.length === 0) return undefined;
  let bestId: number | undefined;
  let bestCount = 0;
  for (const [cliqueId, count] of counts) {
    if (count > bestCount) {
      bestId = cliqueId;
      bestCount = count;
    }
  }
  return bestId === undefined ? undefined : { cliqueId: bestId, ratio: bestCount / candidate.memberIds.length };
}

export function attractiveness(
  agent: Agent,
  candidate: GroupCandidate,
  agents: Agent[],
  params: SimParams,
  interventionId?: InterventionScenarioId,
  tick?: number,
  activeEffects: SpeechActiveEffect[] = [],
  tieCorrection = 0,
  activeInterventionEffects: InterventionEffect[] = [],
): number {
  const dominant = dominantClique(candidate, agents);
  const isDominantMember = dominant !== undefined && agent.cliqueId === dominant.cliqueId;
  // 仲間内なら後押しされる。既に一つの仲良しグループにほぼ占められた輪ほど、
  // 部外者(observerJoiner含む)には既存関係性の強さに応じて入りにくくなる
  // (占有率50%で影響なし、100%かつ既存関係性MAXでほぼ門前払いになるまで滑らかに強まる)
  const dominanceBeyondHalf = dominant ? clamp((dominant.ratio - 0.5) * 2, 0, 1) : 0;
  // Issue #117: 整合性履歴由来のtie補正(`tieCorrection`、既定0で従来挙動)を、同clique bonus /
  // outsider penaltyへ加算方式で反映する。正の補正は(同一cliqueならbonus増、部外者ならpenalty減で)
  // 常に魅力度を上げ、負は下げる。`existingTieStrength`基礎値そのものは変更しない。
  const cliqueTieBonus = isDominantMember ? Math.max(0, params.existingTieStrength * 0.5 + tieCorrection) : 0;
  const outsiderPenalty = isDominantMember
    ? 0
    : Math.max(0, params.existingTieStrength * dominanceBeyondHalf * 0.75 - tieCorrection);
  // Issue #96: "welcome"由来のSpeechActiveEffectは、受け手のjoinedGroupIdスナップショット
  // (=`SpeechActiveEffect.targetGroupId`)と一致するcandidateへのattractivenessにのみ加算される
  const speechAttractivenessBonus = sumActiveEffectValue(
    activeEffects,
    agent.id,
    "attractiveness",
    tick ?? 0,
    candidate.id,
  );
  // Issue #157: 学校向け介入(教師介入)由来の一時的なattractiveness補正。介入未登録/無効時は
  // 常に空配列で+0(既存挙動に影響しない)。`open-group-signal`はこれを使ってtargetGroupId指定で
  // 「空きあり」表示中の候補だけを底上げする。
  const interventionAttractivenessBonus = sumInterventionEffectValue(
    activeInterventionEffects,
    agent.id,
    "attractiveness",
    tick ?? 0,
    candidate.id,
  );

  if (candidate.status === "confirmed") {
    const base = agent.willingness * (0.5 + 0.5 * agent.conformity);
    const lateJoinBonus = params.lateJoinEase * 0.4;
    // `predecided-venue`: 行き先の不確実性が先に取り除かれているため、成立済みグループへは
    // 素直に近づきやすくなる
    const predecidedVenueBonus = interventionId === "predecided-venue" ? PREDECIDED_VENUE_CONFIRMED_BONUS : 0;
    // `late-join-ok`: 「後から合流してよい」という明示的な許可により、成立済みグループへの
    // 参加コストが下がる。未確定の輪(forming)へは影響しない
    const lateJoinOkBonus = interventionId === "late-join-ok" ? LATE_JOIN_OK_CONFIRMED_BONUS : 0;
    return clamp(
      base +
        lateJoinBonus +
        predecidedVenueBonus +
        lateJoinOkBonus +
        cliqueTieBonus -
        outsiderPenalty +
        speechAttractivenessBonus +
        interventionAttractivenessBonus,
      0,
      1.5,
    );
  }

  // `light-observer-invitation`: 声をかけられた直後の一定期間は、他者からの後押しにより
  // 「自分から場を動かす」ことへの抵抗が(完全にではなく)いくらか薄れる
  const lightInvitationBoosted =
    interventionId === "light-observer-invitation" && tick !== undefined && isUnderLightInvitationBoost(agent, tick);
  // `explicit-meeting-point`: 公開された集合場所へ向かうことは「自分が場を動かしてしまう」ことに
  // ならないため、influenceAvoidanceによる壁を薄くする
  const influenceAvoidanceFactor = candidate.isPublicMeetingPoint
    ? 1 - agent.influenceAvoidance * MEETING_POINT_INFLUENCE_AVOIDANCE_RESIDUAL
    : 1 - agent.influenceAvoidance * (lightInvitationBoosted ? LIGHT_INVITATION_INFLUENCE_AVOIDANCE_RESIDUAL : 1);
  const base = agent.willingness * agent.conformity * influenceAvoidanceFactor;
  return clamp(
    base + cliqueTieBonus * 0.5 - outsiderPenalty * 0.5 + speechAttractivenessBonus + interventionAttractivenessBonus,
    0,
    1.5,
  );
}

const APPROACH_FAILURE_REASON_TEXT: Record<ApproachFailureReason, string> = {
  capacityFull: "満員になり",
  groupDissolved: "消滅し",
  groupExpired: "時間切れになり",
  groupMissing: "見当たらなくなり",
};

/**
 * Issue #133: approaching中のagentが参加失敗した(target無効化、または到着時点の容量競合)ことを
 * 記録する共通処理。state遷移(`approaching -> undecided`、`approaching -> searchingAgain`相当)、
 * 再探索クールダウン用フィールドの更新、参加失敗stress、構造化ログ(失敗理由イベント+`searchRestarted`)
 * をまとめて行う。呼び出し側は候補が無効化された(到着前)場合と、到着時点で満員が判明した場合の
 * 両方からこれを呼ぶ(`eventType`で区別)。
 */
function recordApproachFailure(
  agent: Agent,
  candidate: GroupCandidate | undefined,
  capacity: GroupCapacity | undefined,
  reason: ApproachFailureReason,
  eventType: "approachTargetInvalidated" | "joinFailedCapacity",
  tick: number,
  log: LogEntry[],
  formationPolicy: FormationPolicy,
): void {
  const failedCandidateId = agent.joinedGroupId;
  const memberCount = candidate?.memberIds.length ?? 0;
  const capacityFields = candidate && capacity ? capacityMetadataFields(capacity, memberCount) : {};

  agent.state = "undecided";
  agent.joinedGroupId = undefined;
  if (failedCandidateId) {
    agent.lastFailedCandidateId = failedCandidateId;
    agent.lastFailedCandidateAtTick = tick;
  }
  agent.searchRestartCount = (agent.searchRestartCount ?? 0) + 1;
  if (reason === "capacityFull") {
    agent.capacityFailureCount = (agent.capacityFailureCount ?? 0) + 1;
  }

  const stressIncrement = formationPolicy.computeJoinFailureStressIncrement(agent, reason);
  if (stressIncrement > 0) {
    agent.stress = clamp(agent.stress + stressIncrement, 0, 1);
    agent.maxStress = Math.max(agent.maxStress ?? agent.stress, agent.stress);
  }

  const tags: LogTag[] = agent.isObserverJoiner ? ["observerJoiner", "joinFailure"] : ["joinFailure"];
  const failureMetadata: SimulationEventMetadata = {
    agentId: agent.id,
    agentLabel: agent.label,
    groupId: failedCandidateId,
    memberCount,
    reason,
    ...capacityFields,
  };

  if (eventType === "approachTargetInvalidated") {
    const reasonText = APPROACH_FAILURE_REASON_TEXT[reason];
    const targetText =
      formationPolicy.id === "classroomPair" && failedCandidateId
        ? `ペア候補 ${failedCandidateId}`
        : "輪";
    pushLog(
      log,
      tick,
      agent.isObserverJoiner
        ? `observerJoinerが向かっていた${targetText}が${reasonText}、接近を中断した`
        : `${agent.label}さんが向かっていた${targetText}が${reasonText}、接近を中断した`,
      tags,
      "approachTargetInvalidated",
      failureMetadata,
    );
  } else {
    const targetText =
      formationPolicy.id === "classroomPair" && failedCandidateId
        ? `ペア候補 ${failedCandidateId}`
        : "輪";
    pushLog(
      log,
      tick,
      agent.isObserverJoiner
        ? `observerJoinerが${targetText}に到着したが、既に満員で参加できなかった`
        : `${agent.label}さんが${targetText}に到着したが、既に満員で参加できなかった`,
      tags,
      "joinFailedCapacity",
      failureMetadata,
    );
  }

  pushLog(
    log,
    tick,
    agent.isObserverJoiner ? `observerJoinerが別の相手を探し直した` : `${agent.label}さんが別の相手を探し直した`,
    tags,
    "searchRestarted",
    { agentId: agent.id, agentLabel: agent.label, groupId: failedCandidateId, reason },
  );
}

function stepAgentMotion(agent: Agent, target?: { x: number; y: number }, speed = APPROACH_SPEED): void {
  if (!target) return;
  const dx = target.x - agent.x;
  const dy = target.y - agent.y;
  const d = Math.hypot(dx, dy) || 1;
  agent.vx = (dx / d) * speed;
  agent.vy = (dy / d) * speed;
  agent.x = clamp(agent.x + agent.vx, 5, WORLD_WIDTH - 5);
  agent.y = clamp(agent.y + agent.vy, 5, WORLD_HEIGHT - 5);
}

/**
 * Issue #176 (責務9): 合流済み(state === "joined")のagentが会話クラスタから離脱し、undecidedへ戻る
 * 一連の更新を1箇所にまとめる(ADR 3.3節「join/leave時の原子的更新」)。
 * - candidate.memberIdsからの除去(`detachMemberFromCandidate`、二重削除にならない)
 * - agent側所属の解除・再探索クールダウン用フィールドの更新
 * - クラスタ中心から一定距離だけ離れる短い離脱移動(2節: 同じ場所に重なったまま即時再参加しない)。
 *   Canvas境界内に収まるよう既存の`clamp`を再利用する(3節: Canvas境界外へ出ない)。
 */
function departFromCluster(agent: Agent, candidate: GroupCandidate, tick: number, rng: SeededRandom): void {
  detachMemberFromCandidate(candidate, agent.id);

  let dx = agent.x - candidate.x;
  let dy = agent.y - candidate.y;
  if (Math.hypot(dx, dy) < 1e-6) {
    // 合流直後等、クラスタ中心と完全に同座標な場合のフォールバック方向
    dx = rng.range(-1, 1);
    dy = rng.range(-1, 1);
    if (Math.hypot(dx, dy) < 1e-6) dx = 1;
  }
  const len = Math.hypot(dx, dy) || 1;
  agent.x = clamp(agent.x + (dx / len) * CLUSTER_DEPARTURE_STEP_DISTANCE, 5, WORLD_WIDTH - 5);
  agent.y = clamp(agent.y + (dy / len) * CLUSTER_DEPARTURE_STEP_DISTANCE, 5, WORLD_HEIGHT - 5);
  agent.vx = 0;
  agent.vy = 0;

  agent.state = "undecided";
  agent.joinedGroupId = undefined;
  agent.clusterJoinedAtTick = undefined;
  agent.lastDepartedClusterId = candidate.id;
  agent.lastDepartedClusterAtTick = tick;
  agent.clusterDepartureCount = (agent.clusterDepartureCount ?? 0) + 1;
}

/**
 * Issue #176: 一度でもクラスタ離脱したことのある(`lastDepartedClusterId`を持つ)agentが、新たに
 * (同じクラスタ・別クラスタのいずれでも)合流したタイミングで`clusterRejoined`を記録する。
 * `lastDepartedClusterId`はstandingPartyの離脱経路以外では設定されないため、この呼び出し自体は
 * afterParty/classroomPairでは常にno-op(受入条件: 既存シナリオへの回帰がない)。
 */
function logClusterRejoinIfApplicable(agent: Agent, candidate: GroupCandidate, tick: number, log: LogEntry[]): void {
  if (agent.lastDepartedClusterId === undefined) return;

  const previousClusterId = agent.lastDepartedClusterId;
  const ticksSinceDeparture = tick - (agent.lastDepartedClusterAtTick ?? tick);
  pushLog(
    log,
    tick,
    agent.isObserverJoiner
      ? `observerJoinerが${previousClusterId === candidate.id ? "元の" : "別の"}会話の輪へ再び合流した`
      : `${agent.label}さんが${previousClusterId === candidate.id ? "元の" : "別の"}会話の輪へ再び合流した`,
    agent.isObserverJoiner ? ["observerJoiner", "clusterDeparture"] : ["clusterDeparture"],
    "clusterRejoined",
    {
      agentId: agent.id,
      agentLabel: agent.label,
      groupId: candidate.id,
      previousClusterId,
      ticksSinceDeparture,
    },
  );
}

export function stepSimulation(
  state: SimulationState,
  params: SimParams,
  rng: SeededRandom,
  intervention?: InterventionRuntimeOptions,
  speechEffects?: Partial<SpeechEffectsConfig>,
  socialExpression?: Partial<SocialExpressionConfig>,
  speechTrust?: Partial<SpeechTrustConfig>,
  relationshipTie?: Partial<RelationshipTieConfig>,
  formation?: FormationRuntimeOptions,
  /** Issue #175: `createInitialState`と同じ観測期間の上限tick。未指定時は直前のstateから引き継ぐ */
  observationHorizonTick?: number,
): SimulationState {
  if (state.finished) return state;

  // Issue #175: interventionId/formationScenarioIdと同じfall backパターンで、呼び出し側が
  // このtickで渡し忘れても直前のstateに記録済みの観測期間上限が消えないようにする。
  const resolvedObservationHorizonTick = observationHorizonTick ?? state.observationHorizonTick;

  // 呼び出し側がこのtickでinterventionを渡し忘れても、createInitialStateから続く
  // 介入設定が消えないよう、未指定時は直前のstateに記録済みのシナリオへfall backする。
  const resolvedIntervention: InterventionRuntimeOptions | undefined =
    intervention ?? (state.interventionId ? { interventionId: state.interventionId } : undefined);
  const effectiveParams = resolveEffectiveParams(params, resolvedIntervention);
  const interventionId = resolveInterventionScenario(resolvedIntervention).id;
  // Issue #130 (Phase 1): 形成ポリシーも同じfall backパターンで、呼び出し側の渡し忘れにより
  // 途中からafterPartyへ戻ってしまわない(=別ポリシーが消えない)ようにする。
  // Issue #132: classroomPair固有のformationDeadlineTickも同じfall backで引き継ぐ。
  const resolvedFormation: FormationRuntimeOptions | undefined =
    formation ??
    (state.formationScenarioId
      ? {
          scenarioId: state.formationScenarioId,
          formationDeadlineTick: state.formationDeadlineTick,
          classroomGroupSize: state.formationClassroomGroupSize,
        }
      : undefined);
  const formationPolicy = resolveFormationPolicy(resolvedFormation);
  // Phase 3効果も同様に、未指定時は直前のstateの設定を引き継ぐ(呼び出し側の渡し忘れで
  // 途中からOFFに戻ってしまわないようにする)。
  const speechEffectsConfig = resolveSpeechEffectsConfig(
    speechEffects ?? (state.speechEffectsEnabled !== undefined ? { enabled: state.speechEffectsEnabled } : undefined),
  );
  // Phase 4(Issue #115)の乖離反映発言も同じfall backパターンで引き継ぐ。
  const socialExpressionConfig = resolveSocialExpressionConfig(
    socialExpression ??
      (state.socialExpressionEnabled !== undefined ? { enabled: state.socialExpressionEnabled } : undefined),
  );
  // Phase 4(Issue #116)のtrust更新も同じfall backパターンで引き継ぐ。
  const speechTrustConfig = resolveSpeechTrustConfig(
    speechTrust ?? (state.speechTrustEnabled !== undefined ? { enabled: state.speechTrustEnabled } : undefined),
  );
  // Phase 4(Issue #117)の整合性履歴に基づく関係性補正も同じfall backパターンで引き継ぐ。
  const relationshipTieConfig = resolveRelationshipTieConfig(
    relationshipTie ??
      (state.relationshipTieEnabled !== undefined ? { enabled: state.relationshipTieEnabled } : undefined),
  );
  // Issue #117: step 2(接近判定)のattractivenessが参照する、前tickまでの整合性履歴由来のtie補正。
  // このtickで新たに観測される整合性は下のtail(deriveTieObservations)で履歴へ加わり、次tick以降に効く
  // (Phase 3のactiveEffectsと同じ「今回生成→次回参照」の時間関係)。tie無効時は常に空=補正0。
  const incomingTieCorrections = relationshipTieConfig.enabled ? deriveTieCorrections(state.tieHistory ?? {}) : {};

  const tick = state.tick + 1;
  const agents = state.agents.map((a) => ({ ...a }));
  let candidates = state.groupCandidates.map((c) => ({ ...c, memberIds: [...c.memberIds] }));
  const log: LogEntry[] = [];
  const speechEvents: SpeechEvent[] = [];

  // Issue #96: 前tickまでに登録済みのSpeechActiveEffectを、このtick時点の強度へ減衰させ、
  // 期限切れのものを破棄する(tick順序: 期限切れ効果の破棄 -> このtickの状態・行動判断への参照)。
  // speechEffectsConfig.enabled === falseの間は常に空配列(既存挙動に一切影響しない)。
  const activeEffects: SpeechActiveEffect[] = speechEffectsConfig.enabled
    ? advanceActiveSpeechEffects(state.activeSpeechEffects ?? [], tick)
    : [];

  // Issue #156: 学校向け介入(教師介入)の実行契約の結線。登録済み介入が存在しない間は
  // `resolveSchoolIntervention`が常に`undefined`を返すため、以下の各hook呼び出しは実質no-op
  // (受入条件: 本体の行動乱数系列・状態・イベントを変えない)。
  const runSeed = state.seed ?? 0;
  const interventionRunId = createRunId(formationPolicy.id, interventionId, runSeed);
  const schoolIntervention = resolveSchoolIntervention(interventionId);
  const deadlineTick =
    formationPolicy.id === "classroomPair"
      ? (resolvedFormation?.formationDeadlineTick ?? DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK)
      : undefined;
  let interventionRuntimeState = state.interventionRuntimeState ?? createInitialInterventionRuntimeState();
  const activeInterventionEffects = advanceInterventionEffects(state.activeInterventionEffects ?? [], tick);
  const newInterventionEffects: InterventionEffect[] = [];
  const fireIntervention = (hook: SchoolInterventionHook): void => {
    interventionRuntimeState = fireSchoolInterventionHook(
      schoolIntervention,
      buildSchoolInterventionContext(
        hook,
        tick,
        agents,
        candidates,
        formationPolicy,
        effectiveParams,
        deadlineTick,
        state.log,
        log,
        runSeed,
        interventionRunId,
        interventionRuntimeState,
      ),
      agents,
      candidates,
      formationPolicy,
      effectiveParams,
      log,
      newInterventionEffects,
    );
  };

  fireIntervention("beforeTick");

  // 1. 核形成: undecidedな人が forming になるかどうか
  // 核を作れるのは主導性が十分高い人、または既存の仲良しグループが
  // 近くに揃っている人だけ(主導者0人・既存関係性も弱い場なら誰も場を作らない)
  for (const agent of agents) {
    if (agent.state !== "undecided") continue;

    const initiation = formationPolicy.evaluateCandidateInitiation(agent, { agents, params: effectiveParams });
    if (!initiation.eligible) continue;

    // `anonymous-low-pressure-intent`: 匿名の合図で「参加したい人が一定数いる」ことが伝わり、
    // 主導者/既存グループが核を作り始めやすくなる(声かけの代わりに核形成側を後押しする)
    const formingProbability =
      interventionId === "anonymous-low-pressure-intent"
        ? initiation.probability * ANONYMOUS_INTENT_FORMING_PROBABILITY_MULTIPLIER
        : initiation.probability;

    if (rng.chance(formingProbability)) {
      agent.state = "forming";
      const nearbyCandidate = candidates.find(
        (c) => c.status === "forming" && distance(agent.x, agent.y, c.x, c.y) < formationPolicy.candidateMergeRadius,
      );
      // Issue #131: 併合先が既に満員なら合流を諦め、新規候補の作成にフォールバックする
      // (候補マージで`maxGroupSize`を超えないようにするため)
      const mergedIntoNearby =
        nearbyCandidate !== undefined &&
        addMemberToCandidate(nearbyCandidate, agent.id, formationPolicy.resolveGroupCapacity(nearbyCandidate, effectiveParams)) ===
          "added";
      if (mergedIntoNearby) {
        // 併合成功。新規候補の作成・核形成ログは不要(既存挙動どおり)
      } else {
        const candidate: GroupCandidate = {
          id: `group-${tick}-${agent.id}`,
          x: agent.x,
          y: agent.y,
          memberIds: [],
          status: "forming",
          age: 0,
        };
        addMemberToCandidate(candidate, agent.id, formationPolicy.resolveGroupCapacity(candidate, effectiveParams));
        candidates.push(candidate);
        // Issue #132: 教室ペア形成シナリオでは「もう一軒行く?」ではなく、ペア相手探しの声かけとして表現する
        // Issue #174: 立食パーティーでは会話の輪への声かけとして表現する
        const nucleusMessage =
          formationPolicy.id === "classroomPair"
            ? `${agent.label}さんが「一緒にペアになろう」と声をかけ、ペア探しを始めた`
            : formationPolicy.id === "standingParty"
              ? `${agent.label}さんが「ちょっと話さない?」と声をかけ、会話の輪を作り始めた`
              : `${agent.label}さんが「もう一軒行く?」と発言し、核を作り始めた`;
        pushLog(log, tick, nucleusMessage, ["nucleus"], "nucleusCreated", {
          agentId: agent.id,
          agentLabel: agent.label,
          groupId: candidate.id,
        });
        speechEvents.push(
          createSpeechEvent({
            tick,
            speakerId: agent.id,
            intent: "invite",
            reason: initiation.hasInitiative ? "initiativeFormedCore" : "cliqueFormedCore",
            audience: "nearby",
            originX: agent.x,
            originY: agent.y,
          }),
        );
      }
    }
  }

  // 1b. `light-observer-invitation`: observerJoinerがまだundecidedのうちに、
  // 誰か1人が軽く声をかける(1エージェントにつき1回限り)
  if (interventionId === "light-observer-invitation") {
    for (const agent of agents) {
      if (!shouldTriggerLightObserverInvitation(agent, tick)) continue;

      const inviter = selectInvitationAgent(agent, agents, rng);
      if (!inviter) continue;

      applyLightInvitationEffect(agent, tick);
      pushLog(
        log,
        tick,
        `${inviter.label}さんがobserverJoinerに「よかったら一緒に行く?」と軽く声をかけた`,
        ["observerJoiner", "intervention"],
        "observerInvited",
        {
          agentId: agent.id,
          agentLabel: agent.label,
          inviterAgentId: inviter.id,
          inviterAgentLabel: inviter.label,
        },
      );
      speechEvents.push(
        createSpeechEvent({
          tick,
          speakerId: inviter.id,
          intent: "invite",
          reason: "lightObserverInvitation",
          target: agent.id,
          originX: inviter.x,
          originY: inviter.y,
        }),
      );
    }
  }

  fireIntervention("beforeApproachDecision");

  // 2. 接近: undecidedな人が近くの forming / confirmed group を観察して動く
  for (const agent of agents) {
    if (agent.state !== "undecided") continue;

    // Issue #133: 直前に参加失敗した候補は、クールダウン期間中は再探索の選択肢から除外する
    // (「直前の失敗候補を即座に再選択しない」制御。容量が変わらない限り実質恒久的な除外と等価だが、
    // 明示的なフィールドとして持たせることで再探索の系列がログ・テストから追跡できるようにする)
    // Issue #176: クラスタ離脱直後も同じ考え方で、離脱元クラスタをクールダウン期間中は除外する
    // (「意味が衝突しない」よう、参加失敗クールダウンとは別のフィールド・別の除外条件として扱う)
    const cooldownExcludeIds = new Set<string>();
    if (
      agent.lastFailedCandidateId !== undefined &&
      agent.lastFailedCandidateAtTick !== undefined &&
      tick - agent.lastFailedCandidateAtTick < REAPPROACH_COOLDOWN_TICKS
    ) {
      cooldownExcludeIds.add(agent.lastFailedCandidateId);
    }
    if (
      agent.lastDepartedClusterId !== undefined &&
      agent.lastDepartedClusterAtTick !== undefined &&
      tick - agent.lastDepartedClusterAtTick < CLUSTER_REJOIN_COOLDOWN_TICKS
    ) {
      cooldownExcludeIds.add(agent.lastDepartedClusterId);
    }
    // Issue #131: 既に満員の候補へは新たに接近を始めさせない(容量込みのjoinable判定)
    const candidate = nearestCandidate(
      agent,
      candidates,
      (c) => formationPolicy.resolveGroupCapacity(c, effectiveParams),
      cooldownExcludeIds.size > 0 ? cooldownExcludeIds : undefined,
    );
    if (!candidate) continue;

    // Issue #117: この観測者が輪の構成員に対して積み上げた整合性履歴由来の集約tie補正
    // (tie無効時は空マップ=常に0で、attractivenessは従来式のまま)
    const tieCorrection = aggregateGroupTieCorrection(agent.id, candidate.memberIds, incomingTieCorrections);
    const score = attractiveness(
      agent,
      candidate,
      agents,
      effectiveParams,
      interventionId,
      tick,
      activeEffects,
      tieCorrection,
      activeInterventionEffects,
    );
    // `anonymous-low-pressure-intent`: 参加意向を直接発言しなくてよいため、未確定の輪(forming)
    // へ近づくこと自体の抵抗が少し下がる。成立済みグループへの接近は対象外(late-join-ok側の役割)
    const anonymousIntentApproachMultiplier =
      interventionId === "anonymous-low-pressure-intent" && candidate.status !== "confirmed"
        ? ANONYMOUS_INTENT_APPROACH_MULTIPLIER
        : 1;
    // `light-observer-invitation`: 声をかけられた直後の一定期間は、近くの輪(forming/confirmed
    // 問わず)への接近確率が一時的に上がる
    const lightInvitationApproachMultiplier =
      interventionId === "light-observer-invitation" && isUnderLightInvitationBoost(agent, tick)
        ? LIGHT_INVITATION_APPROACH_MULTIPLIER
        : 1;
    // Issue #96: "invite"由来のSpeechActiveEffect(周囲の未定な人への後押し)を加算する
    const speechApproachBonus = sumActiveEffectValue(activeEffects, agent.id, "approachProbability", tick);
    // Issue #157: 学校向け介入由来の一時的なapproachProbability補正。介入未登録/無効時は
    // 常に空配列で+0(既存挙動に影響しない)。`nearby-peer-prompt`が声かけ対象へこれを与える。
    const interventionApproachBonus = sumInterventionEffectValue(
      activeInterventionEffects,
      agent.id,
      "approachProbability",
      tick,
    );
    const approachProbability = clamp(
      score * formationPolicy.approachRateMultiplier * anonymousIntentApproachMultiplier * lightInvitationApproachMultiplier +
        speechApproachBonus +
        interventionApproachBonus,
      0,
      0.9,
    );

    if (rng.chance(approachProbability)) {
      agent.state = "approaching";
      agent.joinedGroupId = candidate.id;
      if (agent.isObserverJoiner) {
        pushLog(
          log,
          tick,
          formationPolicy.id === "classroomPair"
            ? `observerJoinerがペア候補 ${candidate.id} に近づき始めた`
            : `observerJoinerが${candidate.status === "confirmed" ? "成立済みグループ" : "できかけの輪"}に近づき始めた`,
          ["observerJoiner"],
          "observerApproached",
          { agentId: agent.id, agentLabel: agent.label, groupId: candidate.id, groupStatus: candidate.status },
        );
      } else {
        pushLog(
          log,
          tick,
          formationPolicy.id === "classroomPair"
            ? `${agent.label}さんがペア候補 ${candidate.id} に近づき始めた`
            : `${agent.label}さんが輪の近くに移動`,
          [],
          "agentApproached",
          { agentId: agent.id, agentLabel: agent.label, groupId: candidate.id, groupStatus: candidate.status },
        );
      }
    } else if (agent.isObserverJoiner && rng.chance(0.1)) {
      pushLog(log, tick, `observerJoinerは様子見を継続`, ["observerJoiner"]);
    }
  }

  // 3. approaching な人を候補地点へ移動、到着したら参加
  for (const agent of agents) {
    if (agent.state !== "approaching") continue;
    const candidate = candidates.find((c) => c.id === agent.joinedGroupId);

    // Issue #133: 接近先の輪が消滅/解散/期限切れになっていたら、到着見込みに関わらず
    // 即座に接近を中断する(既存挙動の状態ベース判定を踏襲しつつ、理由を構造化イベントとして残す)
    if (!candidate) {
      recordApproachFailure(agent, candidate, undefined, "groupMissing", "approachTargetInvalidated", tick, log, formationPolicy);
      continue;
    }
    if (!isJoinable(candidate)) {
      const reason: ApproachFailureReason = candidate.status === "expired" ? "groupExpired" : "groupDissolved";
      recordApproachFailure(agent, candidate, undefined, reason, "approachTargetInvalidated", tick, log, formationPolicy);
      continue;
    }

    const capacity = formationPolicy.resolveGroupCapacity(candidate, effectiveParams);
    const alreadyArrivable = distance(agent.x, agent.y, candidate.x, candidate.y) < JOIN_DISTANCE;
    // Issue #133: まだ到着圏外で、かつ現時点で既に満員と判明している場合は、無駄な接近を
    // 続けさせずここで見切りをつけて再探索させる(各tickでの有効性再検証)。到着圏内(このtickで
    // 到着を試みる)場合は中断せず、下の到着処理で同一tick内の競合を"到着したら満員だった"
    // (joinFailedCapacity)として解決する
    if (!alreadyArrivable && isCandidateFull(candidate, capacity) && !candidate.memberIds.includes(agent.id)) {
      recordApproachFailure(agent, candidate, capacity, "capacityFull", "approachTargetInvalidated", tick, log, formationPolicy);
      continue;
    }

    stepAgentMotion(agent, candidate);
    const d = distance(agent.x, agent.y, candidate.x, candidate.y);
    if (d < JOIN_DISTANCE) {
      const outcome = addMemberToCandidate(candidate, agent.id, capacity);
      if (outcome === "full") {
        // Issue #133: 到着した瞬間、同一tick内で先に処理された別agentが最後の1枠を取っていた
        // (agents配列順=seedで決定的な競合)場合はここに来る。joinFailedCapacityとして記録し、
        // 満員グループへ留まり続けさせずundecidedへ戻して再探索させる
        recordApproachFailure(agent, candidate, capacity, "capacityFull", "joinFailedCapacity", tick, log, formationPolicy);
        continue;
      }
      agent.state = "joined";
      agent.clusterJoinedAtTick = tick;
      if (agent.isObserverJoiner) {
        pushLog(
          log,
          tick,
          candidate.status === "confirmed"
            ? formationPolicy.id === "classroomPair"
              ? `observerJoinerがペア候補 ${candidate.id} に参加`
              : `observerJoinerが成立済みグループに参加`
            : formationPolicy.id === "classroomPair"
              ? `observerJoinerがペア候補 ${candidate.id} に合流`
              : `observerJoinerが未確定の輪に合流`,
          ["observerJoiner"],
          candidate.status === "confirmed" ? "observerJoinedConfirmed" : "observerJoinedForming",
          {
            agentId: agent.id,
            agentLabel: agent.label,
            groupId: candidate.id,
            joinedGroupStatus: candidate.status,
            ...capacityMetadataFields(capacity, candidate.memberIds.length),
          },
        );
      } else {
        pushLog(
          log,
          tick,
          candidate.status === "confirmed"
            ? formationPolicy.id === "classroomPair"
              ? `${agent.label}さんがペア候補 ${candidate.id} に参加`
              : `${agent.label}さんが成立済みグループに参加`
            : formationPolicy.id === "classroomPair"
              ? `${agent.label}さんがペア候補 ${candidate.id} に合流`
              : `${agent.label}さんが輪に合流`,
        );
      }
      // Issue #176: 過去に離脱経験があるagentのみ対象(standingParty以外では常にno-op)
      logClusterRejoinIfApplicable(agent, candidate, tick, log);
    }
  }

  // 4. forming な人も自分の候補地点に留まりつつ位置を微調整
  for (const agent of agents) {
    if (agent.state !== "forming") continue;
    const candidate = candidates.find((c) => c.status === "forming" && c.memberIds.includes(agent.id));
    if (candidate) {
      candidate.x = clamp(candidate.x + rng.range(-2, 2), 20, WORLD_WIDTH - 20);
      candidate.y = clamp(candidate.y + rng.range(-2, 2), 20, WORLD_HEIGHT - 20);
    }
  }

  // 5. joined な人は候補地点近くをふらつく
  for (const agent of agents) {
    if (agent.state !== "joined") continue;
    const candidate = candidates.find((c) => c.id === agent.joinedGroupId);
    if (candidate) {
      const target = {
        x: candidate.x + rng.range(-18, 18),
        y: candidate.y + rng.range(-18, 18),
      };
      stepAgentMotion(agent, target, WANDER_SPEED);
    }
  }

  // 5b. クラスタ離脱判定(責務9, Issue #176): 合流済みのagentが会話クラスタを離れ、再探索状態へ戻るか
  // afterParty/classroomPairは常に{ eligible: false }を返すため、この処理はstandingParty以外では
  // rngを一切消費しないno-op(受入条件: 既存シナリオへの回帰がない)。
  for (const agent of agents) {
    if (agent.state !== "joined") continue;
    const candidate = candidates.find((c) => c.id === agent.joinedGroupId);
    // 所属先が既に見当たらない場合は、直後(9)の整合性チェックがundecidedへ戻す。ここでは何もしない
    // (受入条件: 消滅済みclusterからの離脱処理でも例外にならない)。
    if (!candidate) continue;

    const ticksInCluster = agent.clusterJoinedAtTick !== undefined ? tick - agent.clusterJoinedAtTick : 0;
    const departure = formationPolicy.evaluateClusterDeparture(agent, candidate, {
      ticksInCluster,
      memberCount: candidate.memberIds.length,
      tick,
    });
    if (!departure.eligible || !rng.chance(departure.probability)) continue;

    const clusterId = candidate.id;
    const departureTags: LogTag[] = agent.isObserverJoiner ? ["observerJoiner", "clusterDeparture"] : ["clusterDeparture"];
    const departureMetadataBase: SimulationEventMetadata = {
      agentId: agent.id,
      agentLabel: agent.label,
      groupId: clusterId,
      ticksInCluster,
      departureReason: "provisionalStayDuration",
    };
    pushLog(
      log,
      tick,
      agent.isObserverJoiner
        ? `observerJoinerが会話の輪を離れ始めた`
        : `${agent.label}さんが会話の輪を離れ始めた`,
      departureTags,
      "clusterDepartureStarted",
      { ...departureMetadataBase, memberCount: candidate.memberIds.length },
    );

    departFromCluster(agent, candidate, tick, rng);

    pushLog(
      log,
      tick,
      agent.isObserverJoiner ? `observerJoinerが会話の輪から離れた` : `${agent.label}さんが会話の輪から離れた`,
      departureTags,
      "clusterDepartureCompleted",
      { ...departureMetadataBase, memberCount: candidate.memberIds.length },
    );
    pushLog(
      log,
      tick,
      agent.isObserverJoiner
        ? `observerJoinerが新しい会話の輪を探し始めた`
        : `${agent.label}さんが新しい会話の輪を探し始めた`,
      departureTags,
      "clusterResearchStarted",
      { agentId: agent.id, agentLabel: agent.label, groupId: clusterId },
    );
  }

  // 6. undecided な人はゆるく漂う (何もしていないわけではないことを示す)
  for (const agent of agents) {
    if (agent.state !== "undecided") continue;
    agent.x = clamp(agent.x + rng.range(-WANDER_SPEED, WANDER_SPEED), 5, WORLD_WIDTH - 5);
    agent.y = clamp(agent.y + rng.range(-WANDER_SPEED, WANDER_SPEED), 5, WORLD_HEIGHT - 5);
  }

  // 7. ストレス蓄積とleave判定
  // 「未定状態が続くほどstressが上がる」ため、対象はundecidedのみ。
  // 一度approaching/formingとして動き出した人は、既に意思決定を終えているため
  // 曖昧さによるstressはそれ以上蓄積しない(移動が遅くても離脱扱いにならない)。
  for (const agent of agents) {
    if (agent.state !== "undecided") continue;

    // 既にできあがっている輪が、既存の仲良しグループに占められていて
    // 自分には実質入りにくい場合は「行き場がない」ことに変わりないため考慮しない。
    // `late-join-ok`: 明示的な許可がある分、ある程度clique優勢な成立済みグループでも
    // 「歓迎されていない」とはみなしにくくする(しきい値を引き上げる)
    const welcomingDominanceThreshold =
      interventionId === "late-join-ok" ? LATE_JOIN_OK_WELCOMING_DOMINANCE_THRESHOLD : 0.5;
    const hasWelcomingConfirmedGroup = candidates.some((c) => {
      if (c.status !== "confirmed") return false;
      const dominant = dominantClique(c, agents);
      return !(dominant && dominant.ratio > welcomingDominanceThreshold && dominant.cliqueId !== agent.cliqueId);
    });
    // `predecided-venue`/`short-ambiguity-window`はどちらも「行き場・見通しの不確実性」を
    // 先に取り除く介入のため、行き場がないこと自体に起因する追加ストレスの蓄積率を下げる
    // (predecided-venueは行き先そのものが決まっている分、より強く効く)。
    // `light-observer-invitation`: 声をかけられた直後の一定期間だけ、この人自身の
    // 追加ストレス蓄積が軽減される(他の介入と異なり、全員一律ではなく本人限定)
    const noDestinationStressMultiplier =
      interventionId === "predecided-venue"
        ? PREDECIDED_VENUE_STRESS_MULTIPLIER
        : interventionId === "short-ambiguity-window"
          ? SHORT_AMBIGUITY_WINDOW_STRESS_MULTIPLIER
          : interventionId === "anonymous-low-pressure-intent"
            ? ANONYMOUS_INTENT_STRESS_MULTIPLIER
            : interventionId === "light-observer-invitation" && isUnderLightInvitationBoost(agent, tick)
              ? LIGHT_INVITATION_STRESS_MULTIPLIER
              : 1;
    let increment = formationPolicy.computeStressIncrement(agent, {
      hasWelcomingConfirmedGroup,
      ambiguityDuration: effectiveParams.ambiguityDuration,
      noDestinationStressMultiplier,
    });

    // Issue #96: "greet"由来のSpeechActiveEffect(周囲の合流を見て感じる安心感)を蓄積率へ加算する
    // (負の値になり、増分を打ち消す方向に働く。最終的なstressそのものは下の`clamp(...,0,1)`が保証する)
    increment += sumActiveEffectValue(activeEffects, agent.id, "stress", tick);
    // Issue #157: 学校向け介入由来の一時的なstress蓄積率補正(負値で軽減方向にも使える)。
    // 介入未登録/無効時は常に空配列で+0(既存挙動に影響しない)
    increment += sumInterventionEffectValue(activeInterventionEffects, agent.id, "stressRate", tick);

    agent.stress = clamp(agent.stress + increment, 0, 1);
    agent.maxStress = Math.max(agent.maxStress ?? agent.stress, agent.stress);

    // Issue #96: "decline"由来のSpeechActiveEffect(周囲の離脱を見て感じる踏ん切りの伝染)を
    // 実効しきい値へ加算する。`agent.leaveThreshold`本体(personality値)は変更しない
    // Issue #157: 学校向け介入由来の一時的なleaveThreshold補正も同じ加算方式で反映する
    // (classroomPair系のcanLeaveは常にfalseのため実質未使用だが、他ポリシーでも安全に消費できるよう
    // 汎用的に配線しておく。介入未登録/無効時は常に空配列で+0)
    const effectiveLeaveThreshold =
      agent.leaveThreshold +
      sumActiveEffectValue(activeEffects, agent.id, "leaveThreshold", tick) +
      sumInterventionEffectValue(activeInterventionEffects, agent.id, "leaveThreshold", tick);

    if (formationPolicy.canLeave(agent, agent.stress, effectiveLeaveThreshold)) {
      agent.state = "leaving";
      if (agent.isObserverJoiner) {
        pushLog(
          log,
          tick,
          `observerJoinerは曖昧な時間に耐えられず帰宅方向へ`,
          ["observerJoiner", "leave"],
          "observerLeaveStarted",
          { agentId: agent.id, agentLabel: agent.label },
        );
      } else {
        pushLog(log, tick, `${agent.label}さんが帰宅方向へ移動`, ["leave"]);
      }
    }
  }

  // 8. leaving な人を画面端(下方向)へ移動、到達したら left
  for (const agent of agents) {
    if (agent.state !== "leaving") continue;
    const target = { x: agent.x, y: WORLD_HEIGHT + 40 };
    stepAgentMotion(agent, target, APPROACH_SPEED * 1.2);
    if (agent.y >= WORLD_HEIGHT - 6) {
      agent.state = "left";
      if (agent.isObserverJoiner) {
        pushLog(log, tick, `observerJoinerが画面外へ退出した`, ["observerJoiner", "leave"], "observerLeft", {
          agentId: agent.id,
          agentLabel: agent.label,
        });
      }
    }
  }

  // 9. グループ成立判定 / 未成立候補の解散・期限切れ判定
  // `short-ambiguity-window`: 行き詰まった輪の解散/期限切れ判断を早め、
  // 帰宅判断(stress蓄積)より先に「合流できない輪への固執」自体を終わらせる
  const candidateWeakResponseAge =
    interventionId === "short-ambiguity-window"
      ? Math.round(formationPolicy.defaultWeakResponseAge * SHORT_AMBIGUITY_WINDOW_AGE_FACTOR)
      : formationPolicy.defaultWeakResponseAge;
  const candidateMaxAge =
    interventionId === "short-ambiguity-window"
      ? Math.round(formationPolicy.defaultMaxAge * SHORT_AMBIGUITY_WINDOW_AGE_FACTOR)
      : formationPolicy.defaultMaxAge;

  for (const candidate of candidates) {
    if (candidate.status === "confirmed") continue;

    // dissolving/dissolved/expiredは既に決着済み。フェードアウト表現用にageだけ進める
    if (candidate.status === "dissolving") {
      candidate.status = "dissolved";
      candidate.age += 1;
      continue;
    }
    if (candidate.status === "dissolved" || candidate.status === "expired") {
      candidate.age += 1;
      continue;
    }

    // status === "forming"
    // Issue #132(責務7): "集まった人数"の数え方自体をpolicyへ委ねる(afterPartyは近接ヒューリスティック、
    // classroomPairは実際のmemberIds.lengthのみを数える)
    const nearbyCount = formationPolicy.computeConfirmationCount(candidate, agents);

    if (formationPolicy.shouldConfirmCandidate(nearbyCount, effectiveParams)) {
      candidate.status = "confirmed";
      const capacity = formationPolicy.resolveGroupCapacity(candidate, effectiveParams);
      const confirmedMessage =
        formationPolicy.id === "classroomPair"
          ? `ペア候補 ${candidate.id} が${nearbyCount}人で成立した`
          : formationPolicy.id === "standingParty"
            ? `${nearbyCount}人が集まり会話の輪が成立`
            : `${nearbyCount}人が集まり二次会グループが成立`;
      pushLog(log, tick, confirmedMessage, ["groupConfirmed"], "groupConfirmed", {
        groupId: candidate.id,
        memberCount: nearbyCount,
        ...capacityMetadataFields(capacity, candidate.memberIds.length),
      });
      for (const agent of agents) {
        if (candidate.memberIds.includes(agent.id) && agent.state === "forming") {
          agent.state = "joined";
          agent.joinedGroupId = candidate.id;
          agent.clusterJoinedAtTick = tick;
          // Issue #176: 過去に離脱経験があるagentのみ対象(standingParty以外では常にno-op)
          logClusterRejoinIfApplicable(agent, candidate, tick, log);
        }
      }
      continue;
    }

    candidate.age += 1;

    const lifecycleOutcome = formationPolicy.evaluateUnconfirmedCandidateLifecycle(candidate, {
      weakResponseAge: candidateWeakResponseAge,
      maxAge: candidateMaxAge,
    });

    if (lifecycleOutcome === "dissolve") {
      candidate.status = "dissolving";
      candidate.age = 0;
      pushLog(
        log,
        tick,
        `できかけの輪への反応が薄く、そのまま自然消滅した`,
        ["groupLifecycle"],
        "groupDissolved",
        { groupId: candidate.id, memberCount: candidate.memberIds.length },
      );
    } else if (lifecycleOutcome === "expire") {
      candidate.status = "expired";
      candidate.age = 0;
      // Issue #174: 立食パーティーでは「二次会成立」ではなく「会話の輪の成立」として表現する
      const expiredMessage =
        formationPolicy.id === "standingParty"
          ? `輪(${candidate.memberIds.length}人)は会話の輪として成立しないまま時間切れになった`
          : `輪(${candidate.memberIds.length}人)は二次会成立に至らないまま時間切れになった`;
      pushLog(
        log,
        tick,
        expiredMessage,
        ["groupLifecycle"],
        "groupExpired",
        { groupId: candidate.id, memberCount: candidate.memberIds.length },
      );
    }
  }

  // 所属していた輪が解散/期限切れ/消滅したエージェントはundecidedに戻す
  // (輪自体が消えたので、意思決定をやり直す)。
  // - forming: 自分がまだforming候補に属しているかで判定する。
  // - joined: 未確定(forming)の輪に合流したあとその輪が成立せず消えた場合、
  //   joinedのまま孤立して「参加済み」に数え続けられてしまうため、所属先が
  //   まだjoinable(forming/confirmed)で自分を含んでいるかで判定して戻す。
  for (const agent of agents) {
    if (agent.state === "forming") {
      const stillForming = candidates.some((c) => c.status === "forming" && c.memberIds.includes(agent.id));
      if (!stillForming) {
        agent.state = "undecided";
      }
    } else if (agent.state === "joined") {
      const candidate = candidates.find((c) => c.id === agent.joinedGroupId);
      if (!candidate || !isJoinable(candidate) || !candidate.memberIds.includes(agent.id)) {
        agent.state = "undecided";
        agent.joinedGroupId = undefined;
        agent.clusterJoinedAtTick = undefined;
      }
    }
  }

  fireIntervention("afterStateTransition");

  // 解散/期限切れ候補は、フェードアウト表現用の猶予tickを過ぎたら配列から取り除く
  candidates = candidates.filter((c) => {
    if (c.status === "dissolved" || c.status === "expired") {
      return c.age < CANDIDATE_LINGER_TICKS;
    }
    return true;
  });

  // Issue #156: 締切概念を持つシナリオ(classroomPair系)でのみ、締切判定の直前に
  // "beforeDeadline"フックを発火する(「直前」とみなす残りtick数の判断は個々の介入実装に委ねる)。
  if (deadlineTick !== undefined) {
    fireIntervention("beforeDeadline");
  }

  // Issue #134: boolだけでなく終了理由も同じpolicy境界から受け取り、終了イベントへ構造化して残す。
  // `allAssigned`はdeadlineと同一tickに成立した場合も優先される(classroomPairPolicy側の判定順)。
  const semanticFinishReason = formationPolicy.finishReason(agents, tick);
  // Issue #175: FormationPolicyが意味論的な自然終了(semantic finish)を一度も返さないまま
  // observation horizonに達した場合だけ、独立した理由("observationHorizonReached")として扱う。
  // semantic finishが既に成立していれば、こちらは一切参照しない(常にsemantic finishを優先する)。
  const observationHorizonReached =
    resolvedObservationHorizonTick !== undefined && tick >= resolvedObservationHorizonTick;
  const finishReason: SimulationFinishReason | undefined =
    semanticFinishReason ?? (observationHorizonReached ? "observationHorizonReached" : undefined);
  const finished = finishReason !== undefined;

  if (finished && !state.finished) {
    // Issue #134: 学校シナリオがdeadlineで終了した場合、探索途中の状態をイベントmetadataへ
    // スナップショットしてから、未参加agentを専用の終端状態へ確定する。joinedGroupIdは探索先を
    // 表す一時値なので、イベントのgroupIdへ退避したうえでagent本体からは除去する。
    if (formationPolicy.id === "classroomPair" && finishReason === "deadlineReached") {
      // Issue #156: "atDeadline"フック。締切時強制割当のような介入は、ここで返す`assignToGroup`
      // actionが下の未割当確定ループより先に適用されることで、実際に割り当てる余地を持てる。
      fireIntervention("atDeadline");

      for (const agent of agents) {
        if (agent.state === "joined") continue;

        const previousAgentState = agent.state;
        const targetGroupId =
          agent.joinedGroupId ?? candidates.find((candidate) => candidate.memberIds.includes(agent.id))?.id;
        pushLog(
          log,
          tick,
          `${agent.label}さんは締切時点でペアが成立せず、未割当となった`,
          ["unassigned"],
          "agentUnassigned",
          {
            agentId: agent.id,
            agentLabel: agent.label,
            groupId: targetGroupId,
            previousAgentState,
            searchRestartCount: agent.searchRestartCount ?? 0,
            capacityFailureCount: agent.capacityFailureCount ?? 0,
            lastFailedCandidateId: agent.lastFailedCandidateId,
            stress: agent.stress,
          },
        );
        agent.state = "unassigned";
        agent.joinedGroupId = undefined;
        agent.vx = 0;
        agent.vy = 0;
      }
    }

    const assignedCount = agents.filter((a) => a.state === "joined").length;
    const unassignedCount = agents.filter((a) => a.state === "unassigned").length;
    // Issue #175: observation horizon到達は「社会過程が終わった」ことを意味しないため、
    // 「グループ形成が完了した」「全員の行動が確定した」等と誤解されない文言にする
    // (受入条件: horizon到達と既存シナリオの自然終了を表示から区別できる)。
    const finishedMessage =
      finishReason === "observationHorizonReached"
        ? `観測期間の上限(tick ${tick})に達したため記録を打ち切った: 現在所属${assignedCount}人 / 帰宅${agents.filter((a) => a.state === "left").length}人 (会場の交流はここで終わったわけではない)`
        : formationPolicy.id === "classroomPair"
          ? `シミュレーション終了: ペア成立${assignedCount}人 / 未割当${unassignedCount}人 / 終了理由: ${finishReason}`
          : `シミュレーション終了: 参加${assignedCount}人 / 帰宅${agents.filter((a) => a.state === "left").length}人`;
    pushLog(log, tick, finishedMessage, ["simulation"], "simulationFinished", {
      assignedCount,
      unassignedCount,
      finishReason,
    });
  }

  const nextState: SimulationState = {
    tick,
    agents,
    groupCandidates: candidates,
    log: [...state.log, ...log],
    width: state.width,
    height: state.height,
    finished,
    seed: runSeed,
    interventionId,
    formationScenarioId: formationPolicy.id,
    formationDeadlineTick: resolvedFormation?.formationDeadlineTick,
    formationClassroomGroupSize: resolvedFormation?.classroomGroupSize,
    observationHorizonTick: resolvedObservationHorizonTick,
    interventionRuntimeState,
    activeInterventionEffects: [...activeInterventionEffects, ...newInterventionEffects],
    speechLog: [],
  };

  // formingGroupRecruitment/approachWelcome/joinGreeting/leaveDeclarationは、
  // 発言主体がstate遷移そのものから一意に決まる(rngで選ばれない)ため、
  // 個別のロジック内で都度createSpeechEventを呼ぶ代わりにここでまとめて導出する。
  const derivedSpeechEvents = deriveSpeechEvents(state, nextState);
  const baseSpeechEvents = [...speechEvents, ...derivedSpeechEvents];

  // Phase 4(Issue #115): 発言選択の入力を本心(状態遷移そのもの)から対外表現(乖離適用後)へ
  // 切り替える。tick内の順序は「基礎生成(上のcreateSpeechEvent直接呼び出し+deriveSpeechEvents)
  // -> 乖離調整(intent置換/抑制/乖離リンク付与) -> Phase 3認知パイプライン」で固定。
  // 発話時点の対外表現は、このtickの判断に使ったのと同じ入力(遷移後のagents・実効化済みの
  // activeEffects)から導出する。導出・調整ともrngを一切消費しないため、ON/OFFやここでの
  // SpeechEvent列の変化によってPRNG消費列自体は変わらない(socialExpressionConfig.enabled === false
  // では全関数が入力をそのまま返し/空配列を返し、既存挙動に一切影響しない)。
  // Issue #117: derivePrivateEvaluationsの観察スナップショットも、step 2の判断が使ったのと同じ入力
  // (前tickまでの整合性履歴由来のtie補正=incomingTieCorrectionsの由来元)を参照するよう、
  // 前tickの`tieHistory`をそのまま渡す(このtickの新規観測を反映した履歴ではない)。
  const expressionState: SimulationState = {
    ...nextState,
    speechEffectsEnabled: speechEffectsConfig.enabled,
    activeSpeechEffects: activeEffects,
    relationshipTieEnabled: relationshipTieConfig.enabled,
    tieHistory: state.tieHistory ?? {},
  };
  const tickPrivateEvaluations = derivePrivateEvaluations(expressionState, params, socialExpressionConfig);
  const tickPublicExpressions = derivePublicExpressions(
    tickPrivateEvaluations,
    expressionState,
    params,
    socialExpressionConfig,
  );
  const tickSpeechEvents = applyPublicExpressionsToSpeech(
    baseSpeechEvents,
    tickPublicExpressions,
    socialExpressionConfig,
  );

  // Phase 4(Issue #116) trust観測: 前tickまでの未観測コミットメント(過去の発言intentに対する
  // 話者のその後の行動)を、このtickの状態遷移(state.agents -> agents)と突き合わせてtrustを更新する。
  // tick内の順序は「trust更新(過去の発言の観測) -> このtickの発言の解釈(更新後trustを参照) ->
  // このtickの発言のコミットメント登録(下)」で固定。発言とその発言自体を生んだ遷移
  // (例: leaving遷移とdecline発言)が同一tickで自己解決しないのは、登録が観測より後だから。
  // rngは一切使わない(有効/無効・更新の有無でPRNG消費列は変わらない)。
  const trustStep = deriveSpeechTrustUpdates(
    state.speechTrustCommitments ?? [],
    state.agents,
    agents,
    state.speechTrust ?? {},
    effectiveParams.existingTieStrength,
    tick,
    speechTrustConfig,
  );
  // 話者側の真実性記録: 乖離スナップショット(Issue #115)を持つ発言のみが評価対象。
  // trust更新とは独立した純粋な記録であり、受け手の解釈・trust更新の入力にはならない。
  const tickTruthfulness = deriveSpeechTruthfulness(tickSpeechEvents, speechTrustConfig);

  // Phase 4(Issue #117) 整合性観測: 前tickまでの未観測コミットメント(過去の発言intentに対する
  // 話者のその後の行動)を、このtickの状態遷移(state.agents -> agents)と突き合わせて整合性履歴を
  // 更新する。trust更新と同じtick順序(観測 -> このtickの解釈が更新後の補正を参照 -> このtickの発言の
  // コミットメント登録)。窓(N tick)を過ぎた未観測コミットメントはここで失効する。rngは使わない。
  const tieStep = deriveTieObservations(
    state.tieCommitments ?? [],
    state.tieHistory ?? {},
    state.agents,
    agents,
    tick,
    relationshipTieConfig,
  );
  const updatedTieCorrections = relationshipTieConfig.enabled ? deriveTieCorrections(tieStep.history) : {};

  // Phase 3: 認知 -> 解釈 -> 効果登録/更新の一方向パイプライン。各段の結果を次の段へ明示的に渡す。
  // このtickで生成される`SpeechActiveEffect`(下の`tickActiveEffects`)は`nextState.activeSpeechEffects`
  // に登録されるだけで、このtick自体の状態・行動判断(既に上のstep 1-9で完了済み)には使われない。
  // 次tick以降の`stepSimulation`呼び出しが冒頭で`advanceActiveSpeechEffects`によりこれを読み出し、
  // 減衰させながら参照する(受入条件のtick順序: 生成 -> 認知 -> 解釈 -> 効果登録/更新 -> [次tickで]
  // 状態・行動判断への参照 -> 期限切れ効果の破棄。speechEffectsConfig.enabled === falseの間は
  // 全関数が空配列を返し、既存挙動に一切影響しない)。
  const tickReceptions = deriveSpeechReceptions(tickSpeechEvents, nextState.agents, speechEffectsConfig);
  // Issue #116: trust有効時のみ、解釈のtrust係数を動的trust(このtickの観測適用後)から解決する。
  // 無効時はundefined(従来の静的relationshipTrust式)で、解釈結果はIssue #116以前と完全一致する。
  const trustResolver = speechTrustConfig.enabled
    ? createSpeechTrustResolver(trustStep.trust, effectiveParams.existingTieStrength)
    : undefined;
  // Issue #117: tie有効時のみ、解釈の関係性係数relFactorへ整合性履歴由来の補正(このtickの観測適用後)を
  // 加算する。無効時はundefined(従来のrelationFactor値)で、解釈結果はIssue #117以前と完全一致する。
  const tieResolver = relationshipTieConfig.enabled ? createTieCorrectionResolver(updatedTieCorrections) : undefined;
  const tickInterpretations = deriveSpeechInterpretations(
    tickReceptions,
    tickSpeechEvents,
    nextState.agents,
    effectiveParams.existingTieStrength,
    speechEffectsConfig,
    trustResolver,
    tieResolver,
  );
  const tickEffects = deriveSpeechEffects(tickInterpretations, tickSpeechEvents, speechEffectsConfig);
  const tickActiveEffects = deriveSpeechActiveEffects(tickEffects, nextState.agents, speechEffectsConfig);

  return {
    ...nextState,
    // Issue #115: 記録・Phase 3入力とも乖離調整後のSpeechEvent列を使う(調整前の基礎列は残さない)
    speechLog: [...(state.speechLog ?? []), ...tickSpeechEvents],
    speechReceptionLog: [...(state.speechReceptionLog ?? []), ...tickReceptions],
    speechInterpretationLog: [...(state.speechInterpretationLog ?? []), ...tickInterpretations],
    speechEffectLog: [...(state.speechEffectLog ?? []), ...tickEffects],
    speechEffectsEnabled: speechEffectsConfig.enabled,
    socialExpressionEnabled: socialExpressionConfig.enabled,
    // Issue #97: 単純な配列結合ではなく、同一話者・同一intentの再発言を置換(更新)として扱う
    // 決定的な合成規則を通す(詳細はspeechEffects.tsの`registerActiveSpeechEffects`参照)。
    activeSpeechEffects: registerActiveSpeechEffects(activeEffects, tickActiveEffects),
    speechTrustEnabled: speechTrustConfig.enabled,
    speechTrust: trustStep.trust,
    speechTrustUpdateLog: [...(state.speechTrustUpdateLog ?? []), ...trustStep.updates],
    speechTruthfulnessLog: [...(state.speechTruthfulnessLog ?? []), ...tickTruthfulness],
    // このtickの発言のコミットメント登録は観測(deriveSpeechTrustUpdates)より後に行う(上記の順序固定)。
    // hearer(観測資格)は発話時点の認知結果(heard: true)のスナップショット。
    speechTrustCommitments: registerSpeechTrustCommitments(
      trustStep.commitments,
      tickSpeechEvents,
      tickReceptions,
      speechTrustConfig,
    ),
    relationshipTieEnabled: relationshipTieConfig.enabled,
    tieHistory: tieStep.history,
    relationshipTieUpdateLog: [...(state.relationshipTieUpdateLog ?? []), ...tieStep.updates],
    // trustと同じく、このtickの発言のコミットメント登録は観測(deriveTieObservations)より後に行う。
    tieCommitments: registerTieCommitments(tieStep.commitments, tickSpeechEvents, tickReceptions, relationshipTieConfig),
  };
}
