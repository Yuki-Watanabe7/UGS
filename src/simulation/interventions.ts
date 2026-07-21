import type { Agent, SimParams } from "./types";
import { clamp, distance } from "./model";
import type { SeededRandom } from "./random";
import type { FormationScenarioId } from "./formationPolicy";

/**
 * 介入シナリオのカテゴリ。
 * - publicCoordination: 場全体に向けた集合・調整の明示化
 * - socialPermission: 「〜してよい」という社会的許可の明示化
 * - targetedSupport: 特定の個人(observerJoiner等)への直接的な働きかけ
 * - timeDesign: 曖昧な時間そのものの長さ・構造の設計
 * - none: 介入なし(通常プリセットそのままの挙動)
 */
export type InterventionCategory =
  | "none"
  | "publicCoordination"
  | "socialPermission"
  | "targetedSupport"
  | "timeDesign";

export type InterventionScenarioId =
  | "none"
  | "explicit-meeting-point"
  | "late-join-ok"
  | "light-observer-invitation"
  | "short-ambiguity-window"
  | "predecided-venue"
  | "anonymous-low-pressure-intent";

/**
 * Issue #156 (Phase 4): 介入の対象者層。「none」はどちらのシナリオでも常に選択可能なベースライン。
 * 二次会向け6介入は全て"afterParty"、学校向け介入(未実装)は"school"を持つ想定。
 */
export type InterventionAudience = "none" | "afterParty" | "school";

/**
 * Issue #156: 学校向け介入(教師介入)が実行され得るタイミング。二次会向け介入はengine.ts内の
 * 既存の`interventionId`分岐で完結しており、このフック契約を経由しない(`hooks: []`)。
 * - initialState: `createInitialState`で初期状態を組み立てた直後
 * - beforeTick: `stepSimulation`でこのtickの通常の意思決定(核形成)を行う前
 * - beforeApproachDecision: undecidedな人が接近判定を行う直前
 * - afterStateTransition: このtickの通常の状態遷移(核形成〜stress/退出判定〜候補ライフサイクル)が
 *   すべて完了した後
 * - beforeDeadline: `formationPolicy`に締切(`deadlineTick`)が存在する各tickで、締切判定そのものの直前
 *   (「直前」とみなす残りtick数の判断は個々の介入実装に委ねる)
 * - atDeadline: 締切到達(`finishReason === "deadlineReached"`)が確定したtick
 */
export type SchoolInterventionHook =
  | "initialState"
  | "beforeTick"
  | "beforeApproachDecision"
  | "afterStateTransition"
  | "beforeDeadline"
  | "atDeadline";

/** `SchoolInterventionHook`の固定実行順序(Issue #156受入条件: 各実行フックの順序が固定される) */
export const SCHOOL_INTERVENTION_HOOK_ORDER: readonly SchoolInterventionHook[] = [
  "initialState",
  "beforeTick",
  "beforeApproachDecision",
  "afterStateTransition",
  "beforeDeadline",
  "atDeadline",
];

/**
 * Issue #156: 介入1件の適用可能範囲・presentation許可の判定に必要なメタ情報。
 * `scenarios`/`implemented`の組み合わせで`resolveAvailableInterventionIds`が
 * presentation側の`availableInterventionIds`を導出する(受入条件: 適用可能シナリオとpresentation
 * 許可リストが常に整合する)。
 */
export type InterventionApplicability = {
  /** この介入を選択可能な`FormationScenarioId`一覧 */
  scenarios: readonly FormationScenarioId[];
  audience: InterventionAudience;
  /** この介入が実際に使用する学校向け実行フック(afterParty向け介入は常に空配列) */
  hooks: readonly SchoolInterventionHook[];
  /** この介入が参照する設定キー(`SimParams`のキー、または`schoolInterventionRuntime.ts`側の設定名) */
  configKeys: readonly string[];
  /** engine側の実装が既に存在し実行可能か。falseならpresentationへは出さない */
  implemented: boolean;
};

/**
 * `SimParams`の一部フィールドに対する単純な加算補正。
 * 既存プリセットの`params`に重ねて適用することを想定した差分値であり、絶対値の上書きではない。
 */
export type InterventionParamAdjustments = Partial<SimParams>;

export type InterventionScenario = {
  id: InterventionScenarioId;
  name: string;
  description: string;
  category: InterventionCategory;
  /** この介入が期待する効果の説明(人間向けの文章。数値的な保証ではない) */
  expectedEffect: string;
  /** `SimParams`への単純な加算補正で近似できる部分。`none`や近似不能な場合は省略 */
  paramAdjustments?: InterventionParamAdjustments;
  /**
   * 単純なパラメータ補正だけでは表現しきれず、engine.ts側に追加ロジックが必要な効果の説明。
   * Phase Cの対応範囲外(型・カタログの整備のみ)のため、ここでは説明のみを持たせ実装はしない。
   */
  engineLogicNotes?: string;
  /** Issue #156: 適用可能シナリオ・対象者層・使用フック・presentation許可の判定に使うメタ情報 */
  applicability: InterventionApplicability;
};

/** `runSimulationToEnd`/`runMonteCarlo`等に介入シナリオを渡す際の実行時オプション */
export type InterventionRuntimeOptions = {
  interventionId: InterventionScenarioId;
};

/** 0-1に正規化されているフィールドのうち、加算補正後にクランプすべきもの */
const UNIT_RANGE_KEYS: readonly (keyof SimParams)[] = [
  "overallWillingness",
  "lateJoinEase",
  "existingTieStrength",
  "observerAmbiguityTolerance",
  "observerInfluenceAvoidance",
  "observerLeaveEase",
];

export const NONE_INTERVENTION: InterventionScenario = {
  id: "none",
  name: "介入なし",
  description: "場の設計に対する介入を何も行わない。通常のプリセットのみで進行する。",
  category: "none",
  expectedEffect: "既存プリセットの挙動をそのまま観察するための基準点(ベースライン)。",
  applicability: {
    scenarios: ["afterParty", "classroomPair"],
    audience: "none",
    hooks: [],
    configKeys: [],
    implemented: true,
  },
};

export const INTERVENTION_SCENARIOS: InterventionScenario[] = [
  NONE_INTERVENTION,
  {
    id: "explicit-meeting-point",
    name: "集合場所の明示",
    description: "幹事が「行く人は店の前に集まりましょう」と、集合場所を明示的にアナウンスする。",
    category: "publicCoordination",
    expectedEffect:
      "どこに向かえばよいかが明確になり、輪を見つけられず様子見のまま留まる時間が減る。後乗りもしやすくなる。",
    paramAdjustments: {
      ambiguityDuration: 0.2,
      lateJoinEase: 0.1,
    },
    engineLogicNotes:
      "engine.tsのcreateInitialStateで、founder不在の低圧なGroupCandidate(isPublicMeetingPoint)を" +
      "初期状態に1つ配置する。通常のforming候補と同じ経路で合流・成立できるが、反応の薄さによる" +
      "早期解散の対象からは除外され、attractivenessでも影響回避の壁を下げて評価される。",
    applicability: {
      scenarios: ["afterParty"],
      audience: "afterParty",
      hooks: [],
      configKeys: ["ambiguityDuration", "lateJoinEase"],
      implemented: true,
    },
  },
  {
    id: "late-join-ok",
    name: "途中参加OKの明示",
    description: "「途中参加OK」「後から合流もOK」と誰かが明示的に宣言する。",
    category: "socialPermission",
    expectedEffect: "後から合流することへの心理的ハードルが下がり、成立済みグループへの参加確率が上がる。",
    paramAdjustments: {
      lateJoinEase: 0.3,
    },
    engineLogicNotes:
      "engine.tsのattractivenessで、成立済みグループへのスコアに固定ボーナス(LATE_JOIN_OK_CONFIRMED_BONUS)を" +
      "加える(未確定の輪へは影響しない)。あわせてhasWelcomingConfirmedGroup判定の" +
      "「歓迎されていない」とみなすclique占有率のしきい値を引き上げ(0.5→0.85)、" +
      "ある程度clique優勢な成立済みグループでもobserverJoinerの「行き場がない」ことに起因する" +
      "追加ストレスが発生しにくくする。介入なしとの差分はcreateInitialStateの" +
      "lateJoinPermissionAnnouncedログでも確認できる。",
    applicability: {
      scenarios: ["afterParty"],
      audience: "afterParty",
      hooks: [],
      configKeys: ["lateJoinEase"],
      implemented: true,
    },
  },
  {
    id: "light-observer-invitation",
    name: "observerJoinerへの軽い声かけ",
    description: "参加者のうち1人が、observerJoinerに「一緒行く?」と軽く声をかける。",
    category: "targetedSupport",
    expectedEffect:
      "observerJoiner自身が場を動かさなくても接近のきっかけが生まれ、影響回避の壁がある人でも輪に近づきやすくなる。",
    paramAdjustments: {
      observerInfluenceAvoidance: -0.2,
      observerLeaveEase: -0.1,
    },
    engineLogicNotes:
      "engine.tsのstepSimulationで、observerJoinerが`undecided`のまま一定tick経過し、" +
      "stressがleaveThresholdの一定割合以上・leaveThreshold未満のときに1回だけ" +
      "shouldTriggerLightObserverInvitationが成立する。selectInvitationAgentが近傍の" +
      "joined/forming/approachingなエージェント(いなければ最寄りの非observerJoiner)をrng経由で選び、" +
      "observerInvitedイベントとしてログに残す(声をかけた側の情報も含む)。声かけ後は" +
      "LIGHT_INVITATION_BOOST_WINDOWの間だけ、接近確率の倍率補正・influenceAvoidanceの壁の緩和" +
      "(完全に消さず残す)・「行き場がない」ことに起因する追加ストレスの軽減、という一時的な" +
      "後押しが働く。強制的にapproaching状態へ移行させることはせず、あくまで確率を動かすだけに" +
      "留めることで、声かけがobserverJoinerの参加を保証しないようにしている。",
    applicability: {
      scenarios: ["afterParty"],
      audience: "afterParty",
      hooks: [],
      configKeys: ["observerInfluenceAvoidance", "observerLeaveEase"],
      implemented: true,
    },
  },
  {
    id: "short-ambiguity-window",
    name: "曖昧時間の短縮",
    description: "店外で全員が様子見になる曖昧な時間そのものを短くする(例: 早めに意思確認の声をかける)。",
    category: "timeDesign",
    expectedEffect: "曖昧フェーズが長引く負担が減り、ストレスが閾値を超えて離脱する前に決着がつきやすくなる。",
    paramAdjustments: {
      ambiguityDuration: 0.2,
    },
    engineLogicNotes:
      "engine.tsのstepSimulationで、未成立候補の弱反応解散/期限切れの判定tick数(CANDIDATE_WEAK_RESPONSE_AGE/" +
      "CANDIDATE_MAX_AGE)を短縮し、行き詰まった輪の解散/期限切れ判断を早める。あわせて" +
      "observerJoinerの「行き場がない」ことに起因する追加ストレスの蓄積率も下げ、" +
      "単純にambiguityDurationを下げた場合に起きる「短いほどストレスが増える」逆効果を避ける。",
    applicability: {
      scenarios: ["afterParty"],
      audience: "afterParty",
      hooks: [],
      configKeys: ["ambiguityDuration"],
      implemented: true,
    },
  },
  {
    id: "predecided-venue",
    name: "二次会会場の事前決定",
    description: "二次会に行くかどうかは曖昧なままでも、場所だけは先に決めておく。",
    category: "publicCoordination",
    expectedEffect:
      "「どこに行くか」の不確実性だけを先に取り除くことで、行くかどうかの判断に集中しやすくなり、輪への接近もしやすくなる。",
    paramAdjustments: {
      lateJoinEase: 0.15,
    },
    engineLogicNotes:
      "engine.tsのattractivenessで、成立済みグループへのスコアに直接ボーナスを加え、成立後の接近確率を上げる。" +
      "あわせてobserverJoinerの「行き場がない」ことに起因する追加ストレスの蓄積率も下げ、" +
      "行き先の不確実性だけを先に取り除く効果を表現する。",
    applicability: {
      scenarios: ["afterParty"],
      audience: "afterParty",
      hooks: [],
      configKeys: ["lateJoinEase"],
      implemented: true,
    },
  },
  {
    id: "anonymous-low-pressure-intent",
    name: "匿名・低圧の意思表明",
    description:
      "参加表明を匿名・低圧な方法にする(例: 挙手ではなく紙に丸をつける、こっそりスタンプを押す等)。",
    category: "socialPermission",
    expectedEffect:
      "influenceAvoidanceが高い人でも、目立たない形でなら「行きたい」という意思を表明しやすくなる。",
    paramAdjustments: {
      observerInfluenceAvoidance: -0.3,
    },
    engineLogicNotes:
      "engine.tsのstepSimulationで3点補正する: (1) 未確定の輪(forming)への接近確率に" +
      "ANONYMOUS_INTENT_APPROACH_MULTIPLIERをかけて少し上げる(成立済みグループへの接近はlate-join-ok側の役割のため対象外)、" +
      "(2) 核形成確率にANONYMOUS_INTENT_FORMING_PROBABILITY_MULTIPLIERをかけ、" +
      "「参加したい人が一定数いる」匿名シグナルが主導者/既存グループの核形成を後押しする様子を" +
      "控えめな倍率で近似する(強い主導者を追加したような挙動にはしない)、" +
      "(3) observerJoinerの「行き場がない」ことに起因する追加ストレスにANONYMOUS_INTENT_STRESS_MULTIPLIERをかけて下げる。",
    applicability: {
      scenarios: ["afterParty"],
      audience: "afterParty",
      hooks: [],
      configKeys: ["observerInfluenceAvoidance"],
      implemented: true,
    },
  },
];

export function getInterventionById(id: InterventionScenarioId): InterventionScenario {
  return INTERVENTION_SCENARIOS.find((scenario) => scenario.id === id) ?? NONE_INTERVENTION;
}

/**
 * Issue #156: `scenarioId`(選択中の`FormationScenarioId`)へ適用可能、かつ実装済みの介入IDを
 * `INTERVENTION_SCENARIOS`の定義順のまま返す。`presentation/scenarioPresentation.ts`の
 * `ScenarioPresentation.availableInterventionIds`はこれをそのまま使うことで、適用可能シナリオと
 * presentation許可リストが常に整合する(受入条件)。二次会画面には学校向け介入(`audience: "school"`)
 * を、学校画面には二次会向け介入(`audience: "afterParty"`)をそれぞれ表示しない。
 */
export function resolveAvailableInterventionIds(scenarioId: FormationScenarioId): InterventionScenarioId[] {
  return INTERVENTION_SCENARIOS.filter(
    (scenario) => scenario.applicability.implemented && scenario.applicability.scenarios.includes(scenarioId),
  ).map((scenario) => scenario.id);
}

/** `intervention`(未指定なら介入なし)に対応する`InterventionScenario`を解決する */
export function resolveInterventionScenario(intervention?: InterventionRuntimeOptions): InterventionScenario {
  return getInterventionById(intervention?.interventionId ?? "none");
}

/**
 * `intervention`のシナリオをparamsへ適用した実効paramsを返す。`params`はmutationしない。
 * `createInitialState`/`stepSimulation`/Monte Carlo層のいずれもここを通すことで、
 * 介入の適用点(paramAdjustmentsの反映)を一箇所に集約する。個別介入のengine側ロジックが
 * 増えた場合も、まずここに反映点を追加できるようにする置き場所として想定している。
 */
export function resolveEffectiveParams(params: SimParams, intervention?: InterventionRuntimeOptions): SimParams {
  return applyInterventionParamAdjustments(params, resolveInterventionScenario(intervention));
}

/**
 * `intervention.paramAdjustments`を`params`に加算した新しい`SimParams`を返す。`params`はmutationしない。
 * 0-1に正規化されたフィールドは加算後に[0, 1]へクランプする。
 */
export function applyInterventionParamAdjustments(
  params: SimParams,
  intervention: InterventionScenario,
): SimParams {
  const adjustments = intervention.paramAdjustments;
  if (!adjustments) return { ...params };

  const result: SimParams = { ...params };

  for (const key of Object.keys(adjustments) as (keyof SimParams)[]) {
    const delta = adjustments[key];
    if (delta === undefined) continue;
    const nextValue = (result[key] as number) + delta;
    result[key] = (UNIT_RANGE_KEYS.includes(key) ? clamp(nextValue, 0, 1) : nextValue) as never;
  }

  return result;
}

// --- light-observer-invitation ---------------------------------------------------------------
// `light-observer-invitation`: 声かけが発生できるようになるまでの最低経過tick数
// (曖昧フェーズが始まってすぐの声かけにならないようにする)
export const LIGHT_INVITATION_MIN_TICK = 5;
// `light-observer-invitation`: stressがleaveThresholdのこの割合以上でなければ声かけは発生しない
// (「まだ全然困っていない」うちには声はかからない、という下限)
export const LIGHT_INVITATION_STRESS_RATIO = 0.3;
// `light-observer-invitation`: 声かけ相手を探す探索半径
export const LIGHT_INVITATION_SEARCH_RADIUS = 160;
// `light-observer-invitation`: 声かけの効果(接近確率上昇/ストレス軽減/影響回避緩和)が続くtick数
export const LIGHT_INVITATION_BOOST_WINDOW = 25;
// `light-observer-invitation`: 声かけ後の接近確率にかける倍率
export const LIGHT_INVITATION_APPROACH_MULTIPLIER = 1.6;
// `light-observer-invitation`: 声かけ後の「行き場がない」追加ストレスにかける倍率
export const LIGHT_INVITATION_STRESS_MULTIPLIER = 0.35;
// `light-observer-invitation`: 声かけ後、未確定の輪へのattractivenessでinfluenceAvoidanceの
// 壁に残す割合(0にはしない=完全に影響を消さない、低圧な後押しとして表現する)
export const LIGHT_INVITATION_INFLUENCE_AVOIDANCE_RESIDUAL = 0.5;

/**
 * `light-observer-invitation`: このtickでagentに声をかけるべきかどうかを判定する。
 * observerJoinerが`undecided`のまま一定tick経過し、stressがleaveThresholdの一定割合以上
 * (かつleaveThreshold未満、既に離脱寸前なら手遅れとして声はかけない)で、まだ一度も
 * 声をかけられていない場合にのみtrueを返す(1エージェントにつき1回限り)。
 */
export function shouldTriggerLightObserverInvitation(agent: Agent, tick: number): boolean {
  if (!agent.isObserverJoiner) return false;
  if (agent.state !== "undecided") return false;
  if (agent.invitedAtTick !== undefined) return false;
  if (tick < LIGHT_INVITATION_MIN_TICK) return false;

  const stressFloor = agent.leaveThreshold * LIGHT_INVITATION_STRESS_RATIO;
  return agent.stress >= stressFloor && agent.stress < agent.leaveThreshold;
}

/**
 * `light-observer-invitation`: `observer`に声をかける一般エージェントを選ぶ。
 * 近く(`LIGHT_INVITATION_SEARCH_RADIUS`以内)にjoined/forming/approachingのエージェントがいれば
 * その中からrng経由で1人選ぶ。いなければ、状態を問わず最も近い非observerJoinerにフォールバックする
 * (`left`は既に画面外なので対象外)。声をかけられる相手が誰もいない場合はundefinedを返す。
 */
export function selectInvitationAgent(
  observer: Agent,
  agents: Agent[],
  rng: SeededRandom,
): Agent | undefined {
  const engaged = agents.filter(
    (a) =>
      a.id !== observer.id &&
      !a.isObserverJoiner &&
      (a.state === "joined" || a.state === "forming" || a.state === "approaching"),
  );
  const nearby = engaged.filter((a) => distance(observer.x, observer.y, a.x, a.y) <= LIGHT_INVITATION_SEARCH_RADIUS);
  if (nearby.length > 0) return rng.pick(nearby);

  const others = agents.filter((a) => a.id !== observer.id && !a.isObserverJoiner && a.state !== "left");
  if (others.length === 0) return undefined;

  return others.reduce((closest, candidate) =>
    distance(observer.x, observer.y, candidate.x, candidate.y) <
    distance(observer.x, observer.y, closest.x, closest.y)
      ? candidate
      : closest,
  );
}

/** `light-observer-invitation`: `agent`に対してtick時点で声かけが行われたことを記録する(mutation) */
export function applyLightInvitationEffect(agent: Agent, tick: number): void {
  agent.invitedAtTick = tick;
}

/** `light-observer-invitation`: `agent`が現在(`tick`時点で)声かけ後の一時的な後押し効果を受けているか */
export function isUnderLightInvitationBoost(agent: Agent, tick: number): boolean {
  return agent.invitedAtTick !== undefined && tick - agent.invitedAtTick < LIGHT_INVITATION_BOOST_WINDOW;
}
