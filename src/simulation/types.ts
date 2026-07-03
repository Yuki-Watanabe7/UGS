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

/**
 * ログの分類タグ。1エントリに複数付与できる(単一カテゴリではなくタグ方式)。
 * observerJoinerの離脱は observerJoiner と leave の両方を持つ、といった重複を許容する。
 */
export type LogTag =
  | "observerJoiner"
  | "nucleus"
  | "groupConfirmed"
  | "leave"
  | "groupLifecycle"
  | "simulation";

/**
 * 集計(終了サマリー/Monte Carlo)向けのイベント種別。
 * 表示用の`message`文言を文字列解析せずに、主要イベントの発生をtickとひも付けて判定できるようにする。
 */
export type SimulationEventType =
  | "simulationStarted"
  | "nucleusCreated"
  | "observerApproached"
  | "observerJoinedForming"
  | "observerJoinedConfirmed"
  | "observerLeaveStarted"
  | "observerLeft"
  | "groupConfirmed"
  | "groupDissolved"
  | "groupExpired"
  | "simulationFinished";

/** `eventType`ごとに必要な範囲で付与される集計用の補助情報。全フィールド任意 */
export type SimulationEventMetadata = {
  agentId?: string;
  agentLabel?: string;
  groupId?: string;
  groupStatus?: GroupCandidateStatus;
  memberCount?: number;
  /** 合流/参加時点でのGroupCandidateStatus (forming = 未確定の輪への合流, confirmed = 成立済みグループへの参加) */
  joinedGroupStatus?: GroupCandidateStatus;
};

export type LogEntry = {
  tick: number;
  message: string;
  tags: LogTag[];
  /** 集計用の構造化イベント種別。既存の表示・フィルタリングには影響しない任意フィールド */
  eventType?: SimulationEventType;
  /** eventTypeに応じた集計用の補助情報。任意フィールド */
  metadata?: SimulationEventMetadata;
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

/**
 * observerJoiner一人分の観察用データ。UI(inspector表示)から安全に参照できるよう、
 * engine.ts内部のロジック結果を読み取り専用の形にまとめたもの。
 * 最寄りの合流可能な輪(joinableなGroupCandidate)が存在しない場合、
 * nearestGroup*系とattractivenessScoreはundefinedになる。
 */
export type ObserverJoinerInspection = {
  agentId: string;
  label: string;
  state: AgentState;
  stress: number;
  willingness: number;
  ambiguityTolerance: number;
  influenceAvoidance: number;
  leaveThreshold: number;
  /** leaveThreshold - stress。0以下ならleaving判定まであとわずか(またはleaving済み) */
  leaveMargin: number;
  nearestGroupId?: string;
  nearestGroupStatus?: GroupCandidateStatus;
  nearestGroupMemberCount?: number;
  nearestGroupDistance?: number;
  attractivenessScore?: number;
};

/**
 * observerJoiner一人分の、シミュレーション終了(または途中経過)サマリー。
 * `state.log`の構造化イベント(`eventType`/`metadata`)から抽出した、tickに紐づく意思決定の推移。
 */
export type ObserverJoinerRunSummary = {
  agentId: string;
  label: string;
  /** サマリー導出時点でのstate.agentsの状態(finished: falseの場合は暫定値) */
  finalState: AgentState;
  joinedGroupId?: string;
  /** 輪/成立済みグループへの接近を開始したtick("observerApproached"、複数回接近し直した場合は直近のもの) */
  approachedTick?: number;
  /** 輪への合流、または成立済みグループへの参加が完了したtick */
  joinedTick?: number;
  /** 参加時点でのGroupCandidateStatus (forming = 未確定の輪への合流, confirmed = 成立済みグループへの参加) */
  joinedGroupStatus?: GroupCandidateStatus;
  leaveStartedTick?: number;
  leftTick?: number;
  /**
   * 後乗り参加が成立したとみなす条件(いずれかを満たせばtrue、finalStateが"joined"でなければ常にfalse):
   * (a) 参加した輪が参加時点で既に"confirmed"だった(joinedGroupStatus === "confirmed")、または
   * (b) シミュレーション全体で最初にグループが成立したtick(firstGroupConfirmedTick)より後に参加した
   *     (自分の輪が後から成立したケースも含め、既に何らかのグループが成立済みの状況下での参加は後乗りとみなす)
   */
  lateJoinSucceeded: boolean;
};

/**
 * シミュレーションの終了(または途中経過)サマリー。表示文言の文字列解析に依存せず、
 * `state.log`の構造化イベントと`state.agents`から導出する。`SimulationState`をmutationしない。
 * `finished: false`の状態でも呼び出し可能で、その時点までの暫定値を返す
 * (UI側で「終了前の暫定サマリー」として表示することを想定)。
 */
export type SimulationSummary = {
  finished: boolean;
  /** 終了tick。finished: falseの場合はundefined */
  finishedTick?: number;
  joinedCount: number;
  leftCount: number;
  stateCounts: Record<AgentState, number>;
  observerJoiners: ObserverJoinerRunSummary[];
  /** 最初に核(forming候補)が形成されたtick。一度も形成されていなければundefined */
  firstNucleusTick?: number;
  /** 最初にグループが成立したtick。一度も成立していなければundefined */
  firstGroupConfirmedTick?: number;
  /** 成立した(confirmedになった)グループの総数 */
  confirmedGroupCount: number;
  /** グループ成立イベントが一度もない場合にtrue */
  groupFailure: boolean;
};
