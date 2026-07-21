import type { ExpressionReason } from "../simulation/expression";
import { DEFAULT_CLASSROOM_PAIR_GROUP_SIZE } from "../simulation/formationPolicy";
import type { FormationScenarioId, GroupSizeRule } from "../simulation/formationPolicy";
import type { InterventionScenarioId } from "../simulation/interventions";
import { resolveAvailableInterventionIds } from "../simulation/interventions";
import type { DivergenceScene } from "../simulation/socialExpression";
import type { SpeechEffectDimension } from "../simulation/speechEffects";
import type { SpeechReason } from "../simulation/speech";
import type { AgentState, LogEntry, SimParams } from "../simulation/types";
import { formatTick } from "../simulation/time";

export type ParameterPresentation = {
  label: string;
  description: string;
  visible: boolean;
  editable: boolean;
  fixedValueLabel?: string;
};

export type ExpressionTemplateVariants = {
  general: readonly string[];
  observerJoiner?: readonly string[];
};

export type DivergencePresentationPair = {
  thought: string;
  speech: string;
};

export type DivergenceArchetypePresentation = {
  general: readonly DivergencePresentationPair[];
  designatedLeader?: readonly DivergencePresentationPair[];
  observerJoiner?: readonly DivergencePresentationPair[];
  cliqueMember?: readonly DivergencePresentationPair[];
};

/**
 * Issue #155 (Phase 4): 学校シナリオで選択中の成立最小人数・収容最大人数(`GroupSizeRule`)から
 * 導出した、表示語彙用の「形成表示コンテキスト」。コンポーネント側で`presetId`分岐を散在させず、
 * ここへ集約した`unitWord`(ペア/班)・`capacityLabel`・`isVariableCapacity`だけを参照させる。
 * `afterParty`シナリオでは常にundefined。
 */
export type GroupUnitPresentation = {
  minGroupSize: number;
  maxGroupSize: number;
  /** 固定2人定員なら"ペア"、それ以外(固定3人以上/可変定員)は"班" */
  unitWord: string;
  /** `minGroupSize !== maxGroupSize` */
  isVariableCapacity: boolean;
  /** 例: "2人固定" / "3人固定" / "3〜4人" */
  capacityLabel: string;
};

export type ScenarioPresentation = {
  id: FormationScenarioId;
  parameters: Record<keyof SimParams, ParameterPresentation>;
  /** Issue #155: 学校シナリオでのみ設定される、選択中の班人数設定の表示コンテキスト */
  groupUnit?: GroupUnitPresentation;
  availableInterventionIds: readonly InterventionScenarioId[];
  showInterventionControls: boolean;
  speechTemplates: Record<SpeechReason, string>;
  expressionTemplates: Record<ExpressionReason, ExpressionTemplateVariants>;
  divergenceTemplates?: Partial<Record<DivergenceScene, DivergenceArchetypePresentation>>;
  agentStateLabels: Record<AgentState, string>;
  canvas: {
    ariaLabel: string;
    confirmedCandidate: string;
    formingCandidate: string;
    dissolvedCandidate: string;
    expiredCandidate: string;
  };
  legend: {
    items: readonly { color: string; label: string }[];
    note: string;
  };
  summary: {
    joinedCount: string;
    leftCount: string;
    unassignedCount: string;
    observerSection: string;
    firstNucleusTick: string;
    firstConfirmedTick: string;
    confirmedCount: string;
    failure: string;
  };
  monteCarlo: {
    observerJoinRate: string;
    observerLeaveRate: string;
    groupFailureRate: string;
    averageFirstConfirmedTick: string;
    lateJoinSuccessRate: string;
    averageJoinedCount: string;
    averageLeftCount: string;
    confirmedUnit: string;
    showLeaveMetrics: boolean;
    showLateJoinMetric: boolean;
  };
  speechEffects: Record<SpeechEffectDimension, string>;
  eventLog: {
    nucleusFilter: string;
    confirmedFilter: string;
    joinFailureFilter: string;
    leaveFilter: string;
    showLeaveFilter: boolean;
  };
};

const AFTER_PARTY_PARAMETERS: Record<keyof SimParams, ParameterPresentation> = {
  populationSize: {
    label: "人数",
    description: "場にいる参加者の総数です。",
    visible: true,
    editable: true,
  },
  groupConfirmSize: {
    label: "二次会成立に必要な人数",
    description: "形成中の輪が正式な二次会グループとして成立する人数です。",
    visible: true,
    editable: true,
  },
  numLeaders: {
    label: "主導者の人数",
    description: "自分から声を上げ、輪を作り始めやすい人の人数です。",
    visible: true,
    editable: true,
  },
  overallWillingness: {
    label: "全体の二次会意欲",
    description: "参加者全体が二次会へ行きたいと思う度合いです。",
    visible: true,
    editable: true,
  },
  ambiguityDuration: {
    label: "曖昧な時間の長さ(耐えられる長さ)",
    description: "行き先が決まらない時間に耐えられる度合いです。",
    visible: true,
    editable: true,
  },
  lateJoinEase: {
    label: "後乗り参加のしやすさ",
    description: "成立済みのグループへ後から合流する心理的な容易さです。",
    visible: true,
    editable: true,
  },
  existingTieStrength: {
    label: "既存関係性の強さ",
    description: "もともとの仲良し関係がまとまりやすさへ与える強さです。",
    visible: true,
    editable: true,
  },
  observerAmbiguityTolerance: {
    label: "observerJoinerの曖昧さ耐性",
    description: "様子を見やすい人が、決まらない時間に耐えられる度合いです。",
    visible: true,
    editable: true,
  },
  observerInfluenceAvoidance: {
    label: "observerJoinerの影響回避度",
    description: "自分の意思で場を動かすことを避ける度合いです。",
    visible: true,
    editable: true,
  },
  observerLeaveEase: {
    label: "observerJoinerの帰宅しやすさ",
    description: "様子を見やすい人が、決まらない状況から離れやすい度合いです。",
    visible: true,
    editable: true,
  },
};

const CLASSROOM_PARAMETERS: Record<keyof SimParams, ParameterPresentation> = {
  populationSize: {
    label: "生徒数",
    description: "教室でペアを作る生徒の総数です。奇数の場合は未割当が1人残り得ます。",
    visible: true,
    editable: true,
  },
  groupConfirmSize: {
    label: "ペアの人数",
    description: "このシナリオではペアを2人固定で作ります。内部値は保持したまま編集を無効にしています。",
    visible: true,
    editable: false,
    fixedValueLabel: "2人固定",
  },
  numLeaders: {
    label: "自分から声をかけ始める生徒数",
    description: "先生の指示後、自分から相手探しを始めやすい生徒の人数です。",
    visible: true,
    editable: true,
  },
  overallWillingness: {
    label: "自発的に相手を探す意欲",
    description: "生徒全体が自分からペア相手を探そうとする度合いです。",
    visible: true,
    editable: true,
  },
  ambiguityDuration: {
    label: "相手が決まらない時間への耐性",
    description: "ペア相手が決まらない状態で、落ち着いて探索を続けられる度合いです。",
    visible: true,
    editable: true,
  },
  lateJoinEase: {
    label: "成立済みペアへの参加しやすさ",
    description: "2人で満員になるペア形成では意味を持たないため表示しません。",
    visible: false,
    editable: false,
  },
  existingTieStrength: {
    label: "既存の友人関係の強さ",
    description: "もともとの友人関係が、相手選びへ与える影響の強さです。",
    visible: true,
    editable: true,
  },
  observerAmbiguityTolerance: {
    label: "待ちやすい生徒の曖昧さ耐性",
    description: "自分から誘わず待ちやすい生徒が、相手未決定の時間に耐えられる度合いです。",
    visible: true,
    editable: true,
  },
  observerInfluenceAvoidance: {
    label: "待ちやすい生徒の働きかけ回避度",
    description: "自分から誘ったり、組み合わせへ影響したりすることを避ける度合いです。",
    visible: true,
    editable: true,
  },
  observerLeaveEase: {
    label: "待ちやすい生徒の退出しやすさ",
    description: "学校シナリオでは退出できないため表示しません。",
    visible: false,
    editable: false,
  },
};

const AFTER_PARTY_SPEECH: Record<SpeechReason, string> = {
  initiativeFormedCore: "もう一軒行く?",
  cliqueFormedCore: "もう一軒行く?",
  formingGroupRecruitment: "こっちも一緒にどう?",
  approachWelcome: "おいでおいで、こっちだよ",
  joinGreeting: "合流できた、よろしく!",
  leaveDeclaration: "今日はここで帰るね、また今度!",
  lightObserverInvitation: "よかったら一緒に行く?",
};

const CLASSROOM_SPEECH: Record<SpeechReason, string> = {
  initiativeFormedCore: "一緒にペアを作らない?",
  cliqueFormedCore: "一緒にペアを作らない?",
  formingGroupRecruitment: "まだ決まってなければ一緒にどう?",
  approachWelcome: "うん、一緒に組もう",
  joinGreeting: "ペア決まったね、よろしく",
  leaveDeclaration: "今は少し考えさせて",
  lightObserverInvitation: "まだなら一緒に組まない?",
};

const AFTER_PARTY_EXPRESSIONS: Record<ExpressionReason, ExpressionTemplateVariants> = {
  initiativeFormedCore: { general: ["よし、声をかけてみよう", "もう一軒、誘ってみるか"] },
  cliqueFormedCore: { general: ["いつものメンバーで集まろうか", "この面子ならもう一軒行けそうだ"] },
  approachedFormingGroup: { general: ["輪が見えてきた。近づいてみようかな", "あそこの輪、行ってみよう"] },
  approachedConfirmedGroup: { general: ["もう決まってるグループに合流しよう", "あそこなら入れそうだ"] },
  arrivedAtFormingGroup: {
    general: ["よし、輪に加われた", "無事に合流できた"],
    observerJoiner: ["よかった、自然に入れた", "思ったより自然に加われた"],
  },
  arrivedAtConfirmedGroup: {
    general: ["グループに参加できた", "間に合ってよかった"],
    observerJoiner: ["よかった、自然に入れた", "後からでも入れてよかった"],
  },
  ambiguityStressExceeded: {
    general: ["今日はもう帰ろう", "これ以上待つのはやめておこう"],
    observerJoiner: ["今日はもう帰ろう", "やっぱり今日はやめておこう"],
  },
  reachedScreenEdge: { general: ["帰り道につく", "そのまま会場を後にした"] },
  receivedLightInvitation: {
    general: ["声をかけてもらえた", "誘ってもらえて少しほっとした"],
    observerJoiner: ["声をかけてもらえた", "誘ってもらえて少し気が楽になった"],
  },
  stressCrossedRisingThreshold: {
    general: ["まだ決まらないのか…少し疲れてきた", "そろそろ長いな、と感じ始めた"],
    observerJoiner: ["まだ決まらないのか…少し疲れてきた", "この空気、少し疲れるな"],
  },
  stressNearLeaveThreshold: {
    general: ["そろそろ帰った方がよさそうだ", "潮時かもしれない"],
    observerJoiner: ["そろそろ帰った方がよさそうだ", "そろそろ潮時かもしれない"],
  },
  nearbyGroupUnapproached: {
    general: ["行きたいけど、今入るのは少し気まずいな…", "声をかけるタイミングが難しい"],
    observerJoiner: ["行きたいけど、今入るのは少し気まずいな…", "輪はあるけど、自分から入るのは気が引ける"],
  },
  noJoinableGroupNearby: {
    general: ["近くに輪が見当たらないな", "もう少し様子を見てみよう"],
    observerJoiner: ["近くに輪が見当たらないな", "行けそうな輪がまだないから、様子を見よう"],
  },
};

const CLASSROOM_EXPRESSIONS: Record<ExpressionReason, ExpressionTemplateVariants> = {
  initiativeFormedCore: { general: ["声をかけてみよう", "一緒に組めるか聞いてみよう"] },
  cliqueFormedCore: { general: ["あの友達に声をかけよう", "一緒にペアを作れそうだ"] },
  approachedFormingGroup: { general: ["あのペア候補に近づいてみよう", "一緒に組めるか聞いてみよう"] },
  approachedConfirmedGroup: { general: ["別の相手も探してみよう", "組める相手がいないか聞いてみよう"] },
  arrivedAtFormingGroup: {
    general: ["ペア候補に加われた", "一緒に組めそうだ"],
    observerJoiner: ["声をかけてもらえてよかった", "自然に相手が見つかった"],
  },
  arrivedAtConfirmedGroup: {
    general: ["一緒に組めることになった", "ペアが決まってよかった"],
    observerJoiner: ["相手が決まってほっとした", "一緒に組める人が見つかった"],
  },
  ambiguityStressExceeded: {
    general: ["相手が決まらないまま時間が過ぎてきた", "いったん落ち着いて待とう"],
    observerJoiner: ["まだ相手が決まらない", "自分から声をかけるのは難しいな"],
  },
  reachedScreenEdge: { general: ["教室の端で少し待とう", "次の指示を待とう"] },
  receivedLightInvitation: {
    general: ["声をかけてもらえた", "誘ってもらえて少しほっとした"],
    observerJoiner: ["声をかけてもらえた", "一緒に組めそうで安心した"],
  },
  stressCrossedRisingThreshold: {
    general: ["まだ相手が決まらず少し焦ってきた", "そろそろ決めたいな"],
    observerJoiner: ["まだ相手が決まらず少し焦る", "待っているだけで大丈夫かな"],
  },
  stressNearLeaveThreshold: {
    general: ["締切が近づいてきた", "早く相手を見つけたい"],
    observerJoiner: ["締切までに決まるかな", "誰か声をかけてくれないかな"],
  },
  nearbyGroupUnapproached: {
    general: ["本当は一緒に組みたいけど、声をかけにくい", "誘うタイミングが難しいな"],
    observerJoiner: ["一緒に組みたいけど、自分から言うのは気が引ける", "近くに人はいるけど声をかけにくい"],
  },
  noJoinableGroupNearby: {
    general: ["組めそうな相手が近くにいないな", "もう少し周りを見てみよう"],
    observerJoiner: ["声をかけてくれそうな人がいないな", "少し待ちながら周りを見よう"],
  },
};

const CLASSROOM_DIVERGENCE: Partial<Record<DivergenceScene, DivergenceArchetypePresentation>> = {
  reservedSoftening: {
    general: [
      { thought: "本当は一緒に組みたいけど、強く誘うのは気が引ける", speech: "まだ決まっていなければ、一緒にどう?" },
      { thought: "声をかけたい。でも困らせたくないな", speech: "もしよかったら、一緒に組まない?" },
    ],
    designatedLeader: [
      { thought: "皆が相手を見つけられるよう声をかけたい", speech: "まだの人がいたら、一緒に探そう" },
    ],
    observerJoiner: [
      { thought: "本当は一緒に組みたいけど、自分から言うのは気が引ける", speech: "もしまだなら、一緒でも大丈夫?" },
    ],
    cliqueMember: [
      { thought: "仲のよい友達と組みたいけど、決めつけたくない", speech: "まだ決まってなければ、どうかな?" },
    ],
  },
  obligatoryWelcome: {
    general: [
      { thought: "別の相手を考えていたけど、断りにくいな", speech: "うん、一緒に組もう" },
      { thought: "少し迷うけど、ここでは受け入れよう", speech: "もちろん、一緒で大丈夫だよ" },
    ],
    designatedLeader: [
      { thought: "組み合わせを考え直したいけど、まず応えよう", speech: "いいよ、一緒にやろう" },
    ],
    observerJoiner: [
      { thought: "少し戸惑うけど、断るのも難しい", speech: "あ、うん。一緒に組もう" },
    ],
    cliqueMember: [
      { thought: "友達と組むつもりだったけど…", speech: "いいよ、一緒に組もう" },
    ],
  },
  politeDecline: {
    general: [
      { thought: "本当は一緒に組みたいのに、うまく言えない", speech: "今は少し考えさせて" },
      { thought: "誘いに応えたいけど、迷ってしまう", speech: "ほかの人にも聞いてみて" },
    ],
    designatedLeader: [
      { thought: "本当は応えたいが、全体の様子も見たい", speech: "少し待ってから決めよう" },
    ],
    observerJoiner: [
      { thought: "本当は一緒に組みたいけど、返事をするのが怖い", speech: "先にほかの人を探してみて" },
    ],
    cliqueMember: [
      { thought: "一緒に組みたい気持ちはあるけど、友達も気になる", speech: "少しだけ考えさせて" },
    ],
  },
};

export const AFTER_PARTY_PRESENTATION: ScenarioPresentation = {
  id: "afterParty",
  parameters: AFTER_PARTY_PARAMETERS,
  // Issue #156: `interventions.ts`側の適用可能範囲メタデータ(`InterventionScenario.applicability`)
  // から導出する。二次会向けに実装済みの6介入 + "none"が定義順のまま返る(既存挙動と同じ配列)。
  availableInterventionIds: resolveAvailableInterventionIds("afterParty"),
  showInterventionControls: true,
  speechTemplates: AFTER_PARTY_SPEECH,
  expressionTemplates: AFTER_PARTY_EXPRESSIONS,
  agentStateLabels: {
    undecided: "未定",
    forming: "輪を形成中",
    approaching: "接近中",
    joined: "参加済み",
    leaving: "離脱中",
    left: "離脱済み",
    unassigned: "未割当",
  },
  canvas: {
    ariaLabel: "グループ形成シミュレーション領域",
    confirmedCandidate: "二次会グループ",
    formingCandidate: "形成中の輪",
    dissolvedCandidate: "解散した輪",
    expiredCandidate: "時間切れの輪",
  },
  legend: {
    items: [
      { color: "#9ca3af", label: "gray: 未定" },
      { color: "#3b82f6", label: "blue: 二次会に向かう意思が強まりつつある" },
      { color: "#22c55e", label: "green: 輪/グループに合流済み(形成中の輪 or 成立済みグループ)" },
      { color: "#ef4444", label: "red: 帰宅方向" },
      { color: "#a855f7", label: "purple: 主導者・核を作っている人" },
      { color: "#f97316", label: "orange: observerJoiner型(注目対象)" },
    ],
    note: "円が大きいほど主導性が高い人です。オレンジの太枠は observerJoiner 型(行きたいが自分の意思で場を動かしたくない人)を示します。",
  },
  summary: {
    joinedCount: "参加人数",
    leftCount: "帰宅人数",
    unassignedCount: "未割当人数",
    observerSection: "observerJoinerサマリー",
    firstNucleusTick: "最初の核形成tick",
    firstConfirmedTick: "最初のグループ成立tick",
    confirmedCount: "成立グループ数",
    failure: "グループ不成立",
  },
  monteCarlo: {
    observerJoinRate: "observerJoiner参加率",
    observerLeaveRate: "observerJoiner離脱率",
    groupFailureRate: "グループ不成立率",
    averageFirstConfirmedTick: "平均グループ成立tick",
    lateJoinSuccessRate: "後乗り成功率",
    averageJoinedCount: "平均参加人数",
    averageLeftCount: "平均帰宅人数",
    confirmedUnit: "グループ",
    showLeaveMetrics: true,
    showLateJoinMetric: true,
  },
  speechEffects: {
    stress: "ストレス蓄積率",
    attractiveness: "輪の魅力度",
    approachProbability: "接近確率",
    leaveThreshold: "離脱しきい値",
  },
  eventLog: {
    nucleusFilter: "核形成イベントのみ",
    confirmedFilter: "グループ成立イベントのみ",
    joinFailureFilter: "参加失敗・再探索のみ",
    leaveFilter: "離脱イベントのみ",
    showLeaveFilter: true,
  },
};

export const CLASSROOM_PRESENTATION: ScenarioPresentation = {
  id: "classroomPair",
  parameters: CLASSROOM_PARAMETERS,
  groupUnit: {
    minGroupSize: DEFAULT_CLASSROOM_PAIR_GROUP_SIZE.minGroupSize,
    maxGroupSize: DEFAULT_CLASSROOM_PAIR_GROUP_SIZE.maxGroupSize,
    unitWord: "ペア",
    isVariableCapacity: false,
    capacityLabel: "2人固定",
  },
  // Issue #156: 学校向けに実装済みの介入は現時点で存在しないため、常に"none"のみ
  // (`resolveAvailableInterventionIds`が`applicability.implemented`で自動的にフィルタする)。
  availableInterventionIds: resolveAvailableInterventionIds("classroomPair"),
  showInterventionControls: false,
  speechTemplates: CLASSROOM_SPEECH,
  expressionTemplates: CLASSROOM_EXPRESSIONS,
  divergenceTemplates: CLASSROOM_DIVERGENCE,
  agentStateLabels: {
    undecided: "相手を探索中",
    forming: "ペア候補を作成中",
    approaching: "接近中",
    joined: "ペア成立済み",
    leaving: "待機場所へ移動中",
    left: "待機中",
    unassigned: "未割当",
  },
  canvas: {
    ariaLabel: "教室のペア形成シミュレーション領域",
    confirmedCandidate: "成立したペア",
    formingCandidate: "形成中のペア候補",
    dissolvedCandidate: "解消したペア候補",
    expiredCandidate: "締切になったペア候補",
  },
  legend: {
    items: [
      { color: "#9ca3af", label: "gray: 相手を探索中" },
      { color: "#3b82f6", label: "blue: ペア候補へ移動中" },
      { color: "#22c55e", label: "green: ペア成立済み" },
      { color: "#eab308", label: "yellow: 相手を再探索中" },
      { color: "#a855f7", label: "purple: 自分から声をかけ始めた生徒" },
      { color: "#db2777", label: "pink: 締切時点で未割当" },
      { color: "#f97316", label: "orange: 自分から誘わず待ちやすい生徒(注目対象)" },
    ],
    note: "円が大きいほど自分から働きかけやすい生徒です。オレンジの太枠は、自分から誘わず相手の声かけを待ちやすい生徒を示します。",
  },
  summary: {
    joinedCount: "ペア成立済みの生徒数",
    leftCount: "待機中の生徒数",
    unassignedCount: "未割当の生徒数",
    observerSection: "自分から誘わず待ちやすい生徒のサマリー",
    firstNucleusTick: "最初の声かけ開始tick",
    firstConfirmedTick: "最初のペア成立tick",
    confirmedCount: "成立ペア数",
    failure: "ペア不成立",
  },
  monteCarlo: {
    observerJoinRate: "待ちやすい生徒のペア成立率",
    observerLeaveRate: "待ちやすい生徒の未割当率",
    groupFailureRate: "ペア不成立率",
    averageFirstConfirmedTick: "平均初回ペア成立tick",
    lateJoinSuccessRate: "待ちやすい生徒のペア成立率",
    averageJoinedCount: "平均ペア成立済み生徒数",
    averageLeftCount: "平均未割当生徒数",
    confirmedUnit: "ペア",
    showLeaveMetrics: false,
    showLateJoinMetric: false,
  },
  speechEffects: {
    stress: "相手未決定時のストレス蓄積率",
    attractiveness: "ペア候補の魅力度",
    approachProbability: "ペア候補への接近確率",
    leaveThreshold: "探索継続しきい値",
  },
  eventLog: {
    nucleusFilter: "声かけ開始イベントのみ",
    confirmedFilter: "ペア成立イベントのみ",
    joinFailureFilter: "組み合わせ失敗・再探索のみ",
    leaveFilter: "待機移行イベントのみ",
    showLeaveFilter: false,
  },
};

function isSameGroupSize(a: GroupSizeRule, b: GroupSizeRule): boolean {
  return a.minGroupSize === b.minGroupSize && a.maxGroupSize === b.maxGroupSize;
}

function unitWordFor(groupSize: GroupSizeRule): string {
  return isSameGroupSize(groupSize, DEFAULT_CLASSROOM_PAIR_GROUP_SIZE) ? "ペア" : "班";
}

function capacityLabelFor(groupSize: GroupSizeRule): string {
  return groupSize.minGroupSize === groupSize.maxGroupSize
    ? `${groupSize.minGroupSize}人固定`
    : `${groupSize.minGroupSize}〜${groupSize.maxGroupSize}人`;
}

/**
 * `text`中の"ペア"を`unitWord`へ置き換える。`unitWord`が"ペア"のまま(既定の2人固定)なら
 * 恒等変換(既存の`CLASSROOM_PRESENTATION`由来の文言を一切変えない)。
 */
function withUnitWord(text: string, unitWord: string): string {
  return unitWord === "ペア" ? text : text.replaceAll("ペア", unitWord);
}

/**
 * Issue #155 (Phase 4): 選択中の学校向け班人数設定(`GroupSizeRule`、#154で一般化済み)から、
 * ペア(固定2人)/班(固定3人以上・可変定員)の表示語彙を動的に解決する。`CLASSROOM_PRESENTATION`
 * (既存の固定ペア文言、多数のテストがこの正確な文言を検証している)は一切変更せず、
 * 既定の2人固定が渡された場合はその同一オブジェクトをそのまま返す(受入条件: ペアプリセットの
 * 既存表示が維持される)。`speechTemplates.ts`/`expressionTemplates.ts`/`divergenceTemplates.ts`は
 * 既存どおり`FormationScenarioId`のみで解決される既存の境界を維持し、ここでは変更しない
 * (発言・心の声の文面自体は班人数に依存させない)。
 */
export function resolveClassroomPresentation(groupSize: GroupSizeRule): ScenarioPresentation {
  if (isSameGroupSize(groupSize, DEFAULT_CLASSROOM_PAIR_GROUP_SIZE)) {
    return CLASSROOM_PRESENTATION;
  }

  const unitWord = unitWordFor(groupSize);
  const capacityLabel = capacityLabelFor(groupSize);
  const isVariableCapacity = groupSize.minGroupSize !== groupSize.maxGroupSize;
  const base = CLASSROOM_PRESENTATION;

  return {
    ...base,
    groupUnit: {
      minGroupSize: groupSize.minGroupSize,
      maxGroupSize: groupSize.maxGroupSize,
      unitWord,
      isVariableCapacity,
      capacityLabel,
    },
    parameters: {
      ...base.parameters,
      groupConfirmSize: {
        label: `${unitWord}の人数`,
        description: isVariableCapacity
          ? `このシナリオでは班を${groupSize.minGroupSize}人以上${groupSize.maxGroupSize}人までの可変定員で作ります。内部値は保持したまま編集を無効にしています。`
          : `このシナリオでは${unitWord}を${capacityLabel}で作ります。内部値は保持したまま編集を無効にしています。`,
        visible: true,
        editable: false,
        fixedValueLabel: capacityLabel,
      },
      lateJoinEase: isVariableCapacity
        ? {
            label: "成立済み・空きありの班への参加しやすさ",
            description: "最小人数で成立済みだが、まだ上限まで空きがある班へ後から加わる心理的な容易さです。",
            visible: true,
            editable: true,
          }
        : {
            label: "成立済みペアへの参加しやすさ",
            description: `${capacityLabel}で満員になる${unitWord}形成では意味を持たないため表示しません。`,
            visible: false,
            editable: false,
          },
    },
    agentStateLabels: {
      ...base.agentStateLabels,
      forming: withUnitWord(base.agentStateLabels.forming, unitWord),
      joined: withUnitWord(base.agentStateLabels.joined, unitWord),
    },
    canvas: {
      ariaLabel: `教室の${unitWord}形成シミュレーション領域`,
      confirmedCandidate: `成立した${unitWord}`,
      formingCandidate: `形成中の${unitWord}候補`,
      dissolvedCandidate: `解消した${unitWord}候補`,
      expiredCandidate: `締切になった${unitWord}候補`,
    },
    legend: {
      items: base.legend.items.map((item) => ({ ...item, label: withUnitWord(item.label, unitWord) })),
      note: withUnitWord(base.legend.note, unitWord),
    },
    summary: {
      joinedCount: withUnitWord(base.summary.joinedCount, unitWord),
      leftCount: base.summary.leftCount,
      unassignedCount: base.summary.unassignedCount,
      observerSection: base.summary.observerSection,
      firstNucleusTick: base.summary.firstNucleusTick,
      firstConfirmedTick: withUnitWord(base.summary.firstConfirmedTick, unitWord),
      confirmedCount: withUnitWord(base.summary.confirmedCount, unitWord),
      failure: withUnitWord(base.summary.failure, unitWord),
    },
    monteCarlo: {
      observerJoinRate: withUnitWord(base.monteCarlo.observerJoinRate, unitWord),
      observerLeaveRate: base.monteCarlo.observerLeaveRate,
      groupFailureRate: withUnitWord(base.monteCarlo.groupFailureRate, unitWord),
      averageFirstConfirmedTick: withUnitWord(base.monteCarlo.averageFirstConfirmedTick, unitWord),
      lateJoinSuccessRate: withUnitWord(base.monteCarlo.lateJoinSuccessRate, unitWord),
      averageJoinedCount: withUnitWord(base.monteCarlo.averageJoinedCount, unitWord),
      averageLeftCount: base.monteCarlo.averageLeftCount,
      confirmedUnit: unitWord,
      showLeaveMetrics: base.monteCarlo.showLeaveMetrics,
      showLateJoinMetric: isVariableCapacity,
    },
    eventLog: {
      nucleusFilter: base.eventLog.nucleusFilter,
      confirmedFilter: withUnitWord(base.eventLog.confirmedFilter, unitWord),
      joinFailureFilter: base.eventLog.joinFailureFilter,
      leaveFilter: base.eventLog.leaveFilter,
      showLeaveFilter: base.eventLog.showLeaveFilter,
    },
  };
}

export function getScenarioPresentation(
  id: FormationScenarioId | undefined,
  classroomGroupSize?: GroupSizeRule,
): ScenarioPresentation {
  if (id !== "classroomPair") return AFTER_PARTY_PRESENTATION;
  return resolveClassroomPresentation(classroomGroupSize ?? DEFAULT_CLASSROOM_PAIR_GROUP_SIZE);
}

export function normalizeInterventionForPresentation(
  interventionId: InterventionScenarioId,
  presentation: ScenarioPresentation,
): InterventionScenarioId {
  return presentation.availableInterventionIds.includes(interventionId) ? interventionId : "none";
}

function classroomAgentLabel(entry: LogEntry): string {
  return entry.metadata?.agentLabel ? `${entry.metadata.agentLabel}さん` : "生徒";
}

/**
 * 構造化イベントをシナリオ別のユーザー向けログへ変換する。内部の`LogEntry.message`は
 * 後方互換の記録として保持し、表示時だけ語彙を差し替えるため状態系列には影響しない。
 */
export function resolveScenarioLogMessage(entry: LogEntry, presentation: ScenarioPresentation): string {
  if (presentation.id !== "classroomPair") return entry.message;

  const unitWord = presentation.groupUnit?.unitWord ?? "ペア";
  const message = buildClassroomLogMessage(entry);
  // Issue #155: 下の switch は既存のペア(2人固定)文言をそのまま組み立てる。既定の"ペア"のままなら
  // 恒等変換(既存のCLASSROOM_PRESENTATION向けテストの正確な文言を一切変えない)。
  return unitWord === "ペア" ? message : message.replaceAll("ペア", unitWord);
}

function buildClassroomLogMessage(entry: LogEntry): string {
  const time = formatTick(entry.tick);
  const agent = classroomAgentLabel(entry);
  const groupId = entry.metadata?.groupId;
  const pair = groupId ? `ペア候補 ${groupId}` : "ペア候補";
  const memberCount = entry.metadata?.memberCount ?? 0;

  switch (entry.eventType) {
    case "simulationStarted":
      return "先生が「自由にペアを作ってください」と指示した。まだ誰も相手を決めていない。";
    case "interventionApplied":
      return `${time} 学校シナリオでは利用できない介入設定を解除した`;
    case "publicMeetingPointEstablished":
    case "lateJoinPermissionAnnounced":
    case "anonymousIntentSignalAnnounced":
      return `${time} 学校シナリオでは利用できない介入イベントを表示対象から除外した`;
    case "observerInvited":
      return `${time} ${entry.metadata?.inviterAgentLabel ?? "生徒"}さんが、待っている生徒へ「まだなら一緒に組まない?」と声をかけた`;
    case "nucleusCreated":
      return `${time} ${agent}が「一緒にペアを作らない?」と声をかけ、相手探しを始めた`;
    case "observerApproached":
    case "agentApproached":
      return `${time} ${agent}が${pair}へ近づき始めた`;
    case "observerJoinedForming":
      return `${time} ${agent}が${pair}へ加わった`;
    case "observerJoinedConfirmed":
      return `${time} ${agent}のペアが決まった`;
    case "observerLeaveStarted":
      return `${time} ${agent}が教室内の待機場所へ移動した`;
    case "observerLeft":
      return `${time} ${agent}が待機に入った`;
    case "groupConfirmed":
      return `${time} ${pair}が${memberCount}人で成立した`;
    case "groupDissolved":
      return `${time} ${pair}は組み合わせが決まらず解消した`;
    case "groupExpired":
      return `${time} ${pair}は成立しないまま締切になった`;
    case "agentUnassigned":
      return `${time} ${agent}は締切時点でペアが成立せず、未割当となった`;
    case "simulationFinished":
      return `${time} シミュレーション終了: ペア成立${entry.metadata?.assignedCount ?? 0}人 / 未割当${entry.metadata?.unassignedCount ?? 0}人`;
    case "approachTargetInvalidated":
      return `${time} ${agent}が向かっていた${pair}を選べなくなり、接近を中断した`;
    case "joinFailedCapacity":
      return `${time} ${agent}が${pair}へ到着したが、既に定員に達していたため組めなかった`;
    case "searchRestarted":
      return `${time} ${agent}が別の相手を探し直した`;
    default:
      return entry.message;
  }
}
