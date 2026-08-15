import type { SimParams } from "./types";
import { DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK, DEFAULT_CLASSROOM_PAIR_GROUP_SIZE } from "./formationPolicy";
import type { FormationScenarioId, GroupSizeRule } from "./formationPolicy";
import {
  NETWORKING_STANDING_PARTY_CONFIG,
  INTIMATE_STANDING_PARTY_CONFIG,
  OUTWARD_INTEREST_STANDING_PARTY_CONFIG,
  CURRENT_CIRCLE_ATTACHMENT_STANDING_PARTY_CONFIG,
  INFO_RICH_STANDING_PARTY_CONFIG,
  TOPIC_SEGMENTED_STANDING_PARTY_CONFIG,
  RUMOR_MUTATION_STANDING_PARTY_CONFIG,
  INFO_SEEKING_STANDING_PARTY_CONFIG,
} from "./standingPartyScenarioConfig";
import type { StandingPartyScenarioConfig } from "./standingPartyScenarioConfig";

export const DEFAULT_PARAMS: SimParams = {
  populationSize: 14,
  groupConfirmSize: 3,
  numLeaders: 1,
  overallWillingness: 0.55,
  ambiguityDuration: 1.0,
  lateJoinEase: 0.5,
  existingTieStrength: 0.3,
  observerAmbiguityTolerance: 0.25,
  observerInfluenceAvoidance: 0.9,
  observerLeaveEase: 0.6,
};

export type ScenarioPreset = {
  id: string;
  name: string;
  description: string;
  params: SimParams;
  /**
   * Issue #132 (Phase 2): このプリセットが使うグループ形成ポリシー。省略時は既存プリセットとの
   * 後方互換として`afterParty`(engine.ts/formationPolicy.tsのfall back既定値と同じ)。
   */
  formationScenarioId?: FormationScenarioId;
  /** `formationScenarioId: "classroomPair"`のプリセットでのみ参照される終了deadline tick */
  formationDeadlineTick?: number;
  /**
   * Issue #155 (Phase 4): `formationScenarioId: "classroomPair"`のプリセットでのみ参照される
   * 成立最小人数・収容最大人数。省略時は`DEFAULT_CLASSROOM_PAIR_GROUP_SIZE`(2人固定、既存の
   * `classroom-pair`との後方互換)。#154で一般化した`GroupSizeRule`をそのままプリセット側に
   * 露出させることで、3人班・4人班(固定、min===max)・3〜4人班(可変定員、min<max)を
   * 単に人数違いのプリセットとして追加できる。
   */
  formationClassroomGroupSize?: GroupSizeRule;
  /**
   * Issue #189 (Phase 2): `formationScenarioId: "standingParty"`のプリセットでのみ参照される、
   * 会話満足度・クラスタ離脱判定・社交的回遊傾向分布の上書き。省略時は
   * `DEFAULT_STANDING_PARTY_SCENARIO_CONFIG`(既存の`standing-party`との後方互換)。
   */
  formationStandingPartyConfig?: StandingPartyScenarioConfig;
};

export const PRESETS: ScenarioPreset[] = [
  {
    id: "natural",
    name: "自然に二次会が成立する場",
    description:
      "主導者がいて、二次会意欲の高い人も複数いる。observerJoinerも参加しやすい標準的なケース。",
    params: {
      ...DEFAULT_PARAMS,
      numLeaders: 2,
      overallWillingness: 0.7,
      lateJoinEase: 0.6,
      existingTieStrength: 0.2,
    },
  },
  {
    id: "ambiguous-dissolve",
    name: "曖昧なまま解散する場",
    description:
      "主導者がおらず、皆が様子見のまま時間切れになる。observerJoinerは帰宅しやすい。",
    params: {
      ...DEFAULT_PARAMS,
      numLeaders: 0,
      overallWillingness: 0.35,
      ambiguityDuration: 0.6,
      lateJoinEase: 0.3,
      existingTieStrength: 0.2,
    },
  },
  {
    id: "strong-leader",
    name: "強い主導者が場を作る場",
    description:
      "一人の強い主導者が早期に核を作り、多くの人がそこに引き寄せられる。",
    params: {
      ...DEFAULT_PARAMS,
      numLeaders: 1,
      overallWillingness: 0.6,
      lateJoinEase: 0.55,
      existingTieStrength: 0.15,
    },
  },
  {
    id: "late-join-culture",
    name: "後乗りしやすい文化",
    description:
      "すでに形成されたグループへの参加コストが低い。observerJoinerが参加しやすい。",
    params: {
      ...DEFAULT_PARAMS,
      numLeaders: 1,
      overallWillingness: 0.55,
      lateJoinEase: 0.85,
      existingTieStrength: 0.15,
    },
  },
  {
    id: "leftover-free-grouping",
    name: "自由グループ作りで余りやすい場",
    description:
      "全体をまとめる主導者はおらず、既存の仲良しグループだけが自然に固まっていく。既存の関係性が強く、後から混ざる余地が少ない。observerJoinerが孤立しやすい。",
    params: {
      ...DEFAULT_PARAMS,
      numLeaders: 0,
      overallWillingness: 0.5,
      lateJoinEase: 0.2,
      existingTieStrength: 0.85,
    },
  },
  {
    id: "standing-party",
    name: "立食パーティー",
    description:
      "会場のあちこちで複数の会話の輪が並行して形成される立食パーティー。既存の関係性は強すぎず、" +
      "自分から話しかけ始める人も複数いるため、いくつもの小さな輪が同時に生まれやすい。" +
      "参加者は輪を探し、時に離脱し、再び探し直す(離脱理由はPhase 1では暫定ルールのみ)。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 24,
      groupConfirmSize: 3,
      numLeaders: 4,
      overallWillingness: 0.65,
      lateJoinEase: 0.5,
      existingTieStrength: 0.25,
    },
    formationScenarioId: "standingParty",
  },
  {
    id: "standing-party-networking",
    name: "立食パーティー(幅広く交流するネットワーキング型)",
    description:
      "標準ケースと同じ会場規模・既存の関係性の強さのまま、社交的回遊傾向の高い参加者が多い場。" +
      "最低限の滞在時間を過ぎると、今の会話に満足していてもさらに多くの人と話すため次の輪へ移りやすく、" +
      "1つの会話への滞在は比較的短くなりやすい。回遊傾向・良し悪しを表すものではない(Phase 2は仮説段階)。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 24,
      groupConfirmSize: 3,
      numLeaders: 4,
      overallWillingness: 0.65,
      lateJoinEase: 0.5,
      existingTieStrength: 0.25,
    },
    formationScenarioId: "standingParty",
    formationStandingPartyConfig: NETWORKING_STANDING_PARTY_CONFIG,
  },
  {
    id: "standing-party-intimate",
    name: "立食パーティー(少人数でじっくり話す懇親型)",
    description:
      "標準ケースと同じ会場規模・既存の関係性の強さのまま、社交的回遊傾向の低い参加者が多い場。" +
      "会話への満足度が下がりにくく、最低限の滞在時間も標準ケースより長めのため、" +
      "同じ会話の輪が比較的長く維持されやすい。回遊傾向・良し悪しを表すものではない(Phase 2は仮説段階)。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 24,
      groupConfirmSize: 3,
      numLeaders: 4,
      overallWillingness: 0.65,
      lateJoinEase: 0.5,
      existingTieStrength: 0.25,
    },
    formationScenarioId: "standingParty",
    formationStandingPartyConfig: INTIMATE_STANDING_PARTY_CONFIG,
  },
  {
    id: "standing-party-outward-interest",
    name: "立食パーティー(交流先へ移りやすい場)",
    description:
      "標準ケースと同じ会場規模・既存の関係性の強さ・Phase 2パラメータのまま、他クラスタへの関心が" +
      "targetになりやすく、愛着・解散配慮による抑制も比較的弱い場(Phase 3)。他の会話の輪が気になった人は、" +
      "目的地を決めてそこへ向かう移動が観察しやすい。会場からの退出人数自体が増える設定ではない。" +
      "「良い/悪い」「社交的/非社交的」を意味する名称ではなく、集団ダイナミクス比較のための仮説的な設定。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 24,
      groupConfirmSize: 3,
      numLeaders: 4,
      overallWillingness: 0.65,
      lateJoinEase: 0.5,
      existingTieStrength: 0.25,
    },
    formationScenarioId: "standingParty",
    formationStandingPartyConfig: OUTWARD_INTEREST_STANDING_PARTY_CONFIG,
  },
  {
    id: "standing-party-current-circle",
    name: "立食パーティー(今の輪への配慮が強い場)",
    description:
      "標準ケースと同じ会場規模・既存の関係性の強さ・Phase 2パラメータのまま、今のクラスタへの愛着が" +
      "速く強く形成され、自分の離脱による解散見込みへの配慮も働きやすい場(Phase 3)。他クラスタへの関心自体は" +
      "普通に生じるが、留まる(stay)decisionが選ばれやすい。永久に移動しなくなるほどの極端な設定ではない。" +
      "「良い/悪い」「社交的/非社交的」を意味する名称ではなく、集団ダイナミクス比較のための仮説的な設定。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 24,
      groupConfirmSize: 3,
      numLeaders: 4,
      overallWillingness: 0.65,
      lateJoinEase: 0.5,
      existingTieStrength: 0.25,
    },
    formationScenarioId: "standingParty",
    formationStandingPartyConfig: CURRENT_CIRCLE_ATTACHMENT_STANDING_PARTY_CONFIG,
  },
  {
    id: "standing-party-info-rich",
    name: "立食パーティー(情報が広がりやすい交流会)",
    description:
      "標準ケースと同じ会場規模・既存の関係性の強さ・Phase 2/3パラメータのまま、topicの発話・採用・" +
      "再伝達(Phase 5)が活発に起こる場。話の内容(closing timeやおすすめの話等)が輪をまたいで" +
      "広がりやすく、話題への一致・新規性が会話満足度・輪の移動へも反映される。" +
      "「良い/悪い」を意味する名称ではなく、情報伝播の速さを比較するための仮説的な設定。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 24,
      groupConfirmSize: 3,
      numLeaders: 4,
      overallWillingness: 0.65,
      lateJoinEase: 0.5,
      existingTieStrength: 0.25,
    },
    formationScenarioId: "standingParty",
    formationStandingPartyConfig: INFO_RICH_STANDING_PARTY_CONFIG,
  },
  {
    id: "standing-party-topic-segmented",
    name: "立食パーティー(輪ごとに話題が分かれる場)",
    description:
      "標準ケースと同じ会場規模・既存の関係性の強さ・Phase 2/3パラメータのまま、各clusterのtopicが" +
      "長く維持され(topic persistence)、自分の関心と今の輪の話題が合っているかどうか(interest match)が" +
      "会話満足度へより強く反映される場(Phase 5)。「良い/悪い」を意味する名称ではなく、輪ごとの話題の" +
      "分化を比較するための仮説的な設定。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 24,
      groupConfirmSize: 3,
      numLeaders: 4,
      overallWillingness: 0.65,
      lateJoinEase: 0.5,
      existingTieStrength: 0.25,
    },
    formationScenarioId: "standingParty",
    formationStandingPartyConfig: TOPIC_SEGMENTED_STANDING_PARTY_CONFIG,
  },
  {
    id: "standing-party-rumor-mutation",
    name: "立食パーティー(口コミが変容しやすい場)",
    description:
      "標準ケースと同じ会場規模・既存の関係性の強さ・Phase 2/3パラメータのまま、再伝達のたびに話の内容が" +
      "変容しやすい場(Phase 5、mutation率が高い)。ただしvariant数・lineage深さ・意味距離の上限制御" +
      "(既存の暴走防止キャップ)は緩めていない。「良い/悪い」を意味する名称ではなく、口コミの変容を" +
      "比較するための仮説的な設定。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 24,
      groupConfirmSize: 3,
      numLeaders: 4,
      overallWillingness: 0.65,
      lateJoinEase: 0.5,
      existingTieStrength: 0.25,
    },
    formationScenarioId: "standingParty",
    formationStandingPartyConfig: RUMOR_MUTATION_STANDING_PARTY_CONFIG,
  },
  {
    id: "standing-party-info-seeking",
    name: "立食パーティー(情報探索型の参加者が多い場)",
    description:
      "標準ケースと同じ会場規模・既存の関係性の強さのまま、他クラスタで聞けそうな未知の情報(Phase 5)への" +
      "関心が、既存の社交的関心とは別枠で強く働く場。目的地付き移動(switchToTargetCluster)として、" +
      "情報を求めての輪の移動が観察しやすい。「良い/悪い」を意味する名称ではなく、情報探索行動の" +
      "強さを比較するための仮説的な設定。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 24,
      groupConfirmSize: 3,
      numLeaders: 4,
      overallWillingness: 0.65,
      lateJoinEase: 0.5,
      existingTieStrength: 0.25,
    },
    formationScenarioId: "standingParty",
    formationStandingPartyConfig: INFO_SEEKING_STANDING_PARTY_CONFIG,
  },
  {
    id: "classroom-pair",
    name: "教室で自由にペアを作る場",
    description:
      "先生が「自由にペアを作ってください」と指示する教室。2人定員の複数ペアが並行して形成され、" +
      "退出はできない。全員割当か締切tickの到達で終了し、人数が奇数なら1人は未割当のまま残り得る。" +
      "observerJoiner相当の人は自分からは誘わず、誘われるのを待ちやすい。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 20,
      groupConfirmSize: 2,
      numLeaders: 0,
      overallWillingness: 0.8,
      existingTieStrength: 0.3,
    },
    formationScenarioId: "classroomPair",
    formationDeadlineTick: DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK,
    formationClassroomGroupSize: DEFAULT_CLASSROOM_PAIR_GROUP_SIZE,
  },
  {
    id: "classroom-group-3",
    name: "教室で自由に3人班を作る場",
    description:
      "先生が「3人班を作ってください」と指示する教室。3人固定の複数班が並行して形成され、" +
      "退出はできない。全員割当か締切tickの到達で終了する。生徒数20人は3人で割り切れないため、" +
      "最大2人が班に入れないまま未割当で残り得る(構造的未割当)。" +
      "observerJoiner相当の人は自分からは誘わず、誘われるのを待ちやすい。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 20,
      groupConfirmSize: 3,
      numLeaders: 0,
      overallWillingness: 0.8,
      existingTieStrength: 0.3,
    },
    formationScenarioId: "classroomPair",
    formationDeadlineTick: DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK,
    formationClassroomGroupSize: { minGroupSize: 3, maxGroupSize: 3 },
  },
  {
    id: "classroom-group-4",
    name: "教室で自由に4人班を作る場",
    description:
      "先生が「4人班を作ってください」と指示する教室。4人固定の複数班が並行して形成され、" +
      "退出はできない。全員割当か締切tickの到達で終了する。生徒数22人は4人で割り切れないため、" +
      "最大3人が班に入れないまま未割当で残り得る(構造的未割当)。3人班より1人あたりの相手探しに" +
      "時間がかかりやすく、成立までのtickが延びる様子を観察できる。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 22,
      groupConfirmSize: 4,
      numLeaders: 0,
      overallWillingness: 0.8,
      existingTieStrength: 0.3,
    },
    formationScenarioId: "classroomPair",
    formationDeadlineTick: DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK,
    formationClassroomGroupSize: { minGroupSize: 4, maxGroupSize: 4 },
  },
  {
    id: "classroom-group-3-4",
    name: "教室で自由に3〜4人班を作る場",
    description:
      "先生が「3〜4人班を作ってください」と指示する教室。最小3人で成立し、4人まで受け入れる" +
      "可変定員の班が並行して形成される。3人固定・4人固定と異なり、生徒数23人でも構造的な" +
      "未割当は生じない(3人班と4人班を組み合わせて全員を吸収できるため)。3人で成立済み・" +
      "まだ4人目を受け入れられる「空きあり」の班と、4人で満員になった班の違いを観察できる。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 23,
      groupConfirmSize: 3,
      numLeaders: 0,
      overallWillingness: 0.8,
      existingTieStrength: 0.3,
    },
    formationScenarioId: "classroomPair",
    formationDeadlineTick: DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK,
    formationClassroomGroupSize: { minGroupSize: 3, maxGroupSize: 4 },
  },
];

export function getPresetById(id: string): ScenarioPreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
