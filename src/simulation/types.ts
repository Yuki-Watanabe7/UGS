export type AgentState =
  | "undecided"
  | "forming"
  | "approaching"
  /**
   * 輪(GroupCandidate)に合流済み。未確定の「形成中の輪」への合流と、
   * 成立済み二次会グループへの参加の両方を指す。
   * どちらかは joinedGroupId が指す GroupCandidate.status を見て判別する
   * (ログ文言はこの区別に基づいて分けている。engine.ts参照)。
   */
  | "joined"
  | "leaving"
  | "left";

export type Agent = {
  id: string;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;

  /** 二次会に行きたい気持ち */
  willingness: number;
  /** 自分から場を作る力 */
  initiative: number;
  /** 曖昧な時間への耐性 */
  ambiguityTolerance: number;
  /** 自分の意思で場を動かしたくない度合い */
  influenceAvoidance: number;
  /** 周囲の動きに乗る傾向 */
  conformity: number;
  /** 帰宅判断の早さ(しきい値) */
  leaveThreshold: number;

  isObserverJoiner: boolean;
  state: AgentState;
  stress: number;
  joinedGroupId?: string;
  /** 既存の仲良しグループID (既存関係性の強さパラメータに応じて割り当てられる) */
  cliqueId?: number;
};

/**
 * GroupCandidateのライフサイクル状態。
 * forming: 未確定の輪として形成中。
 * confirmed: 成立済み二次会グループ(終端状態)。
 * dissolving: 反応が薄い/時間切れ等の理由で解散が決まり、視覚的にフェードアウトしている途中(終端手前)。
 * dissolved: 反応が薄いまま消えた(終端状態)。
 * expired: 成立に至らないまま期限切れになった(終端状態)。
 */
export type GroupCandidateStatus = "forming" | "confirmed" | "dissolving" | "dissolved" | "expired";

export type GroupCandidate = {
  id: string;
  x: number;
  y: number;
  memberIds: string[];
  status: GroupCandidateStatus;
  /**
   * 何tick存在しているか(演出・ログ用)。
   * dissolving/dissolved/expiredに遷移した時点でリセットされ、
   * そこからは終端状態での経過tick(掃除タイミング制御用)として使う。
   */
  age: number;
};

export type LogEntry = {
  tick: number;
  message: string;
};

export type SimParams = {
  /** 人数 */
  populationSize: number;
  /** 二次会成立に必要な人数 */
  groupConfirmSize: number;
  /** 主導者の人数 */
  numLeaders: number;
  /** 全体の二次会意欲 (0-1, willingnessの平均に影響) */
  overallWillingness: number;
  /** 曖昧な時間の長さ (stressの蓄積速度の逆数的パラメータ) */
  ambiguityDuration: number;
  /** 後乗り参加のしやすさ (confirmed groupへの参加コスト低減) */
  lateJoinEase: number;
  /** 既存関係性の強さ (クラスタ同士がまとまりやすく、混ざりにくい) */
  existingTieStrength: number;
  /** observerJoinerの曖昧さ耐性 */
  observerAmbiguityTolerance: number;
  /** observerJoinerの影響回避度 */
  observerInfluenceAvoidance: number;
  /** observerJoinerの帰宅しやすさ (leaveThresholdの逆) */
  observerLeaveEase: number;
};

export type SimulationConfig = {
  seed: number;
  params: SimParams;
  presetId: string;
};

export type SimulationState = {
  tick: number;
  agents: Agent[];
  groupCandidates: GroupCandidate[];
  log: LogEntry[];
  width: number;
  height: number;
  finished: boolean;
};
