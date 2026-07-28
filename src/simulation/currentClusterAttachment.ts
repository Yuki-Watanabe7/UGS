/**
 * Issue #199 (Phase 3, ステップP3-B): `docs/cluster-transition-phase3-model.md`(Issue #197 ADR)の
 * 1.2節・1.3節・4節・6.2節で確定した型・パラメータ契約に基づく、現在クラスタへの愛着
 * (`CurrentClusterAttachmentState`)と離脱配慮(`DepartureInhibition`)の純粋関数群。
 *
 * 「今の会話エピソードからどれだけ離れにくいか」(愛着)を会話満足度(`conversationSatisfaction.ts`)
 * とは独立な状態として初期化・更新し(1.2節)、自分の離脱がクラスタ解散・残存member releaseへ与える
 * 構造的影響(`evaluateClusterDissolutionImpact`)と`influenceAvoidance`(安定trait)を合成した
 * 抑制(`computeDepartureInhibition`)を導出する。会話満足度は低いほど離脱**圧力**(駆動側)を生むが、
 * 愛着は高いほど離脱を**抑制**する(抑制側) ―― 向きが逆であり、同一視しない(ADR 1.2節)。
 *
 * 対象外(ADR 9節P3-Bの区切り・issue「対象外」節): stay/depart/switchの最終action decision(#200)、
 * target clusterへの接近・参加(#201)、長期的な人物間愛着・接触記憶、cluster全体の満足度評価、
 * Canvas・Inspector表示。`engine.ts`は本モジュールが返す値を`ConversationEpisode.attachment`へ
 * 記録するのみで、`evaluateClusterDeparture`(責務9の離脱確率)へはまだ一切入力しない
 * (ADR 9節、#200が引き継ぐ)。
 *
 * 決定性・非干渉: すべて純粋関数。rngを一切消費せず、引数をmutationしない。
 * `isObserverJoiner`はいかなる式にも入力しない(ADR 1.4節)。
 */
import type { GroupCandidateStatus } from "./types";

/**
 * Issue #199: 現在の会話エピソードへの愛着state。`ConversationEpisode.attachment`にネストし、
 * episode終了の3経路(voluntaryDeparture/memberReleased/membershipLost)すべてで
 * `agent.currentEpisode = undefined`により一括クリアされる(新しいクリア処理を追加しない、ADR 1.2節)。
 */
export type CurrentClusterAttachmentState = {
  /** [0,1] */
  value: number;
  initializedAtTick: number;
  lastUpdatedAtTick: number;
  /** 前tick終了時点で観測した同席人数(3.2節のスナップショット) */
  lastObservedMemberCount: number;
  /** join時から継続している同席memberのID集合(構成の安定を測るため) */
  foundingMemberIds: string[];
  /**
   * 直近更新時点でのfoundingMemberIds残存数(内部bookkeeping)。turnover由来の損失を
   * 「このtickで新たに何人減ったか」というedge-triggeredな量として計算するために持つ ――
   * 構成が変化しないtickでは常に寄与0になることを、この値との比較だけで保証する
   * (要件3節: 滞在時間が長いほど愛着が下がらない単調な更新)。
   */
  lastFoundingPresentCount: number;
  /**
   * 直近で同席member数が増加した(または episode 自体が開始した)tick。
   * `recentMemberJoinedConcern`の判定窓(要件4節「新しいmemberが直前に参加した」
   * 「clusterが成立した直後である」)をこの1値だけで表現する ―― join直後はepisode開始tickそのものが
   * 「直近の参加」を兼ねる(自分自身の合流も、この輪にとって直近の参加である)。
   */
  lastMemberArrivalAtTick: number;
};

export type CurrentClusterAttachmentConfig = {
  /** join時の初期値 [0,1] */
  initialAttachment: number;
  /** 1tickあたりの増加量(>= 0) */
  attachmentGrowthPerTick: number;
  /** 飽和値 [0,1](`initialAttachment <= maxAttachment`をvalidateする) */
  maxAttachment: number;
  /** 継続founding member比率が1ポイント下がるごとの損失量(>= 0) */
  memberTurnoverAttachmentLoss: number;
  /** 新規member1人あたりの希釈量(>= 0) */
  newMemberDilution: number;
  /** 愛着から抑制への変換係数 [0,1] */
  attachmentInhibitionWeight: number;
  /** 自分の離脱で解散する場合の配慮 [0,1] */
  clusterWouldDissolveConcern: number;
  /** 直前に誰かが参加した場合の配慮 [0,1] */
  recentMemberJoinedConcern: number;
  /** 上記の判定ウィンドウ(非負整数) */
  recentMemberJoinedWindowTicks: number;
  /** 構造的影響factorへの乗算係数(1.3.1節) [0,4] */
  influenceAvoidanceGain: number;
  /** 実際に離脱確率へ掛かる総抑制の上限。1を含めない(完全ブロック禁止、ADR 4.1節) [0,1) */
  maxInhibition: number;
};

/**
 * 実データ較正前の仮説的な調整値であり、心理学的妥当性を主張しない(`conversationSatisfaction.ts`/
 * `clusterDepartureDecision.ts`と同じ立場、CLAUDE.mdのtuning方針)。
 * - `initialAttachment = 0.2`: 満足度の中庸初期値(0.6)とは対照的に、愛着はゼロに近い低い値から
 *   積み上がっていくものとしてスタートする(ADR 1.2節の対比表: 愛着は「滞在とともに単調に増える」)。
 * - `attachmentGrowthPerTick = 0.01`: `satisfactionDecayPerTick`と同じ桁の小さな値とし、
 *   1tickで極端に変化しない。
 * - `maxAttachment = 0.85`: 1を含まない中庸な飽和値(要件: 一定tick以降は飽和し無制限に増えない)。
 * - `memberTurnoverAttachmentLoss = 0.15`: founding memberが1人残らず入れ替わった極端なケースで
 *   飽和値超の増加分を打ち消せる程度の値。edge-triggeredなため通常は入れ替わり人数比に応じた
 *   小さな一回分だけが働く。
 * - `newMemberDilution = 0.03`: 満足度側の`newMemberFreshnessBoost`(0.05)よりやや小さい値とし、
 *   「同じ新規参加が満足度には正、愛着には負に効く」非対称性を極端にしすぎない。
 * - `attachmentInhibitionWeight = 0.5`: 愛着の半分程度が抑制へそのまま乗る中庸値。
 * - `clusterWouldDissolveConcern = 0.2` / `recentMemberJoinedConcern = 0.08`:
 *   「自分が抜けると解散する」ことへの配慮を、「直前に人が増えた」ことへの配慮よりはっきり大きくする
 *   (前者は不可逆な構造変化、後者は一時的な状況)。
 * - `recentMemberJoinedWindowTicks = 5`: 短い判定窓とし、「ついさっき」という直近性を保つ。
 * - `influenceAvoidanceGain = 1`: 構造的影響が最大の場面でも寄与が2倍を超えない中庸値([0,4]の範囲内)。
 * - `maxInhibition = 0.6`: 1未満を強制(完全ブロック禁止)。愛着・配慮をどれだけ積み上げても
 *   離脱確率が0に張り付かない。
 */
export const DEFAULT_CURRENT_CLUSTER_ATTACHMENT_CONFIG: CurrentClusterAttachmentConfig = {
  initialAttachment: 0.2,
  attachmentGrowthPerTick: 0.01,
  maxAttachment: 0.85,
  memberTurnoverAttachmentLoss: 0.15,
  newMemberDilution: 0.03,
  attachmentInhibitionWeight: 0.5,
  clusterWouldDissolveConcern: 0.2,
  recentMemberJoinedConcern: 0.08,
  recentMemberJoinedWindowTicks: 5,
  influenceAvoidanceGain: 1,
  maxInhibition: 0.6,
};

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`currentClusterAttachment config: ${name} must be a finite number (got ${value})`);
  }
}

function assertRange(name: string, value: number, min: number, max: number): void {
  assertFinite(name, value);
  if (value < min || value > max) {
    throw new Error(`currentClusterAttachment config: ${name} must be within [${min}, ${max}] (got ${value})`);
  }
}

function assertNonNegative(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0) {
    throw new Error(`currentClusterAttachment config: ${name} must be >= 0 (got ${value})`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  assertFinite(name, value);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`currentClusterAttachment config: ${name} must be a non-negative integer (got ${value})`);
  }
}

/**
 * NaN/Infinity・範囲外・不正な整数を明示的に拒否する(既存モジュールと同じ方針。domain layerを
 * 最終防衛線とする)。相互制約として`initialAttachment <= maxAttachment`と
 * `maxInhibition < 1`も検証する(issue要件8節)。
 */
export function validateCurrentClusterAttachmentConfig(config: CurrentClusterAttachmentConfig): void {
  assertRange("initialAttachment", config.initialAttachment, 0, 1);
  assertNonNegative("attachmentGrowthPerTick", config.attachmentGrowthPerTick);
  assertRange("maxAttachment", config.maxAttachment, 0, 1);
  if (config.initialAttachment > config.maxAttachment) {
    throw new Error(
      `currentClusterAttachment config: initialAttachment (${config.initialAttachment}) must be <= maxAttachment (${config.maxAttachment})`,
    );
  }
  assertNonNegative("memberTurnoverAttachmentLoss", config.memberTurnoverAttachmentLoss);
  assertNonNegative("newMemberDilution", config.newMemberDilution);
  assertRange("attachmentInhibitionWeight", config.attachmentInhibitionWeight, 0, 1);
  assertRange("clusterWouldDissolveConcern", config.clusterWouldDissolveConcern, 0, 1);
  assertRange("recentMemberJoinedConcern", config.recentMemberJoinedConcern, 0, 1);
  assertNonNegativeInteger("recentMemberJoinedWindowTicks", config.recentMemberJoinedWindowTicks);
  assertRange("influenceAvoidanceGain", config.influenceAvoidanceGain, 0, 4);
  assertFinite("maxInhibition", config.maxInhibition);
  if (config.maxInhibition < 0 || config.maxInhibition >= 1) {
    throw new Error(`currentClusterAttachment config: maxInhibition must be within [0, 1) (got ${config.maxInhibition})`);
  }
}

validateCurrentClusterAttachmentConfig(DEFAULT_CURRENT_CLUSTER_ATTACHMENT_CONFIG);

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export type CurrentClusterAttachmentInitContext = {
  config: CurrentClusterAttachmentConfig;
  tick: number;
  /** join成立時点の同席memberId列(自分自身を含む、`candidate.memberIds`と同じ値) */
  memberIds: string[];
};

/**
 * 会話エピソード開始時、愛着stateを決定的に初期化する(要件2節: 全join経路で同じ初期化関数を使う、
 * 同一clusterへ再参加しても新しいepisodeとして初期化し前episodeの愛着を継承しない ――
 * `ConversationEpisode.attachment`にネストすることで後者は呼び出し側の構造だけで自動的に満たされる)。
 * rngを消費せず、`ctx`をmutationしない。
 */
export function initializeAttachment(ctx: CurrentClusterAttachmentInitContext): CurrentClusterAttachmentState {
  const foundingMemberIds = [...ctx.memberIds];
  return {
    value: ctx.config.initialAttachment,
    initializedAtTick: ctx.tick,
    lastUpdatedAtTick: ctx.tick,
    lastObservedMemberCount: foundingMemberIds.length,
    foundingMemberIds,
    lastFoundingPresentCount: foundingMemberIds.length,
    lastMemberArrivalAtTick: ctx.tick,
  };
}

export type CurrentClusterAttachmentUpdateContext = {
  config: CurrentClusterAttachmentConfig;
  previous: CurrentClusterAttachmentState;
  tick: number;
  /**
   * このtick開始時点(=前tick終了時点)で観測された同席memberのID列(ADR 3.2節のスナップショット)。
   * 呼び出し側は`state.groupCandidates`(このtickの合流/離脱処理より前)から渡すこと ――
   * 満足度更新(`updateConversationSatisfaction`)と同じ順序ルールに従う。
   */
  observedMemberIds: string[];
};

/** 各寄与要因を含む更新結果(issue要件7節と同型の分解を返す) */
export type CurrentClusterAttachmentUpdateResult = {
  previousValue: number;
  nextValue: number;
  /** 滞在による単調増加分(>= 0)。実際の変化はmaxAttachmentによる飽和でこれより小さいことがある */
  growthContribution: number;
  /** 直前の観測以降に新たに欠けたfounding memberの比率による損失分(<= 0、edge-triggered) */
  turnoverContribution: number;
  /** 直前の観測以降に新たに増えたmember数による希釈分(<= 0、edge-triggered) */
  dilutionContribution: number;
  /** 次tickの`ConversationEpisode.attachment`へそのまま代入する更新後state */
  next: CurrentClusterAttachmentState;
};

/**
 * 1tick分の愛着更新(ADR 3.2節 step 5a2)。呼び出し側は`joined`かつ有効なclusterに所属している間、
 * 合流したその場のtick(滞在0tick)を除き、毎tick一度だけ呼び出す想定
 * (`updateConversationSatisfaction`と同じ呼び出し契約 ―― 同一tickで複数回更新しない、要件3節)。
 *
 * turnover(founding member流出)・dilution(新規member参加)のいずれも、直前の観測からの**差分**
 * (edge-triggered)としてのみ寄与する ―― 構成が変化しないtickではどちらも常に0になるため、
 * 「滞在時間を増やした同一条件で愛着が不意に低下しない」(要件3節・受入条件)が式の形だけで保証される。
 * rngを一切参照しない。
 */
export function updateAttachment(ctx: CurrentClusterAttachmentUpdateContext): CurrentClusterAttachmentUpdateResult {
  const { config, previous } = ctx;
  const observedMemberCount = ctx.observedMemberIds.length;
  const foundingPresentCount = previous.foundingMemberIds.filter((id) => ctx.observedMemberIds.includes(id)).length;

  const growthContribution = config.attachmentGrowthPerTick;

  const newlyDepartedFounders = Math.max(0, previous.lastFoundingPresentCount - foundingPresentCount);
  const turnoverContribution =
    newlyDepartedFounders === 0 || previous.foundingMemberIds.length === 0
      ? 0
      : -config.memberTurnoverAttachmentLoss * (newlyDepartedFounders / previous.foundingMemberIds.length);

  const arrived = Math.max(0, observedMemberCount - previous.lastObservedMemberCount);
  const dilutionContribution = arrived === 0 ? 0 : -(arrived * config.newMemberDilution);

  const nextValue = Math.min(
    config.maxAttachment,
    Math.max(0, previous.value + growthContribution + turnoverContribution + dilutionContribution),
  );

  const next: CurrentClusterAttachmentState = {
    value: nextValue,
    initializedAtTick: previous.initializedAtTick,
    lastUpdatedAtTick: ctx.tick,
    lastObservedMemberCount: observedMemberCount,
    foundingMemberIds: previous.foundingMemberIds,
    lastFoundingPresentCount: foundingPresentCount,
    lastMemberArrivalAtTick: arrived > 0 ? ctx.tick : previous.lastMemberArrivalAtTick,
  };

  return {
    previousValue: previous.value,
    nextValue,
    growthContribution,
    turnoverContribution,
    dilutionContribution,
    next,
  };
}

/** `attachment.lastMemberArrivalAtTick`から`recentMemberJoinedWindowTicks`以内かを判定する(要件4節) */
export function isRecentMemberJoin(
  attachment: CurrentClusterAttachmentState,
  tick: number,
  config: CurrentClusterAttachmentConfig,
): boolean {
  return tick - attachment.lastMemberArrivalAtTick <= config.recentMemberJoinedWindowTicks;
}

// --- 離脱配慮・構造的影響 (DepartureConcern, ADR 1.3節) ------------------------------------------

export type DepartureConcernFactorKind =
  | "episodeAttachment"
  | "clusterWouldDissolve"
  | "recentMemberJoined"
  | "influenceAvoidance";

export type DepartureConcernFactor = {
  kind: DepartureConcernFactorKind;
  /** 抑制へ寄与した分(0以上)。`influenceAvoidance`は乗算による増分を寄与として記録する(1.3.1節) */
  contribution: number;
};

export type DepartureInhibition = {
  /** 愛着そのものの値 [0,1](表示用) */
  attachment: number;
  /** 構造的配慮の合計 [0,1] */
  concern: number;
  /** 実際に離脱確率へ掛かる総抑制 [0, maxInhibition] */
  total: number;
  /** contribution降順 */
  factors: DepartureConcernFactor[];
};

/**
 * Issue #199 要件5節: agentが現在clusterから離脱したと仮定した場合の構造的影響。
 * 実際の`candidate`/membershipを一切mutationしない(呼び出し側は`candidate.memberIds`等を
 * そのまま読み取り専用で渡す)。
 */
export type ClusterDissolutionImpact = {
  /** 自分が今離脱したと仮定した場合の残存member数 */
  memberCountAfterDeparture: number;
  /** 残存member数が`resolveGroupCapacity()`の`minGroupSize`を下回るか */
  wouldFallBelowMinimum: boolean;
  /**
   * confirmed clusterがdissolving/dissolvedへ遷移する見込みか。責務10
   * (`FormationPolicy.evaluatePostConfirmationLifecycle`)が実際に解散判定の対象にする条件
   * (`confirmedClusterIsMutable`かつ`status === "confirmed"`かつ`everConfirmed`)をそのまま踏襲する
   * ―― `confirmedClusterIsMutable=false`の既存シナリオ(afterParty/classroomPair)や、
   * 近接ヒューリスティックによりまだ`everConfirmed`が立っていないconfirmed候補では常に`false`
   * (要件5節: 既存責務10の境界と矛盾しない)。
   */
  wouldDissolve: boolean;
  /** `wouldDissolve`の場合に強制releaseされる見込みの残存member数(自分を除く) */
  releasedMemberCount: number;
};

export type ClusterDissolutionImpactContext = {
  /** 現在のcluster candidateのmemberIds(自分自身を含む) */
  memberIds: string[];
  /** `FormationPolicy.resolveGroupCapacity`が返す`minGroupSize` */
  minGroupSize: number;
  /** `FormationPolicy.confirmedClusterIsMutable` */
  confirmedClusterIsMutable: boolean;
  /** candidateの`status`。`confirmed`以外(forming/dissolving/dissolved/expired)では常に`wouldDissolve: false` */
  candidateStatus: GroupCandidateStatus;
  /** `GroupCandidate.everConfirmed`(責務10がまだ解散判定の対象にしない、成立直後の猶予期間の判定) */
  everConfirmed: boolean;
};

/**
 * agentが現在clusterから離脱したと仮定した場合の構造的影響を、実際のmutationなしに評価する
 * (issue要件5節)。
 */
export function evaluateClusterDissolutionImpact(ctx: ClusterDissolutionImpactContext): ClusterDissolutionImpact {
  const memberCountAfterDeparture = Math.max(0, ctx.memberIds.length - 1);
  const wouldFallBelowMinimum = memberCountAfterDeparture < ctx.minGroupSize;
  const wouldDissolve =
    ctx.confirmedClusterIsMutable && ctx.candidateStatus === "confirmed" && ctx.everConfirmed && wouldFallBelowMinimum;
  return {
    memberCountAfterDeparture,
    wouldFallBelowMinimum,
    wouldDissolve,
    releasedMemberCount: wouldDissolve ? memberCountAfterDeparture : 0,
  };
}

export type DepartureInhibitionContext = {
  config: CurrentClusterAttachmentConfig;
  /** 現在の会話エピソードの愛着state。standingParty対象外・合流直後等でundefinedの場合は0として扱う */
  attachment: CurrentClusterAttachmentState | undefined;
  tick: number;
  dissolutionImpact: ClusterDissolutionImpact;
  /** `Agent.influenceAvoidance`(安定trait)。未設定は0として扱う(1.3.1節、issue要件6節) */
  influenceAvoidance: number | undefined;
};

/**
 * Issue #199 要件6節(ADR 1.3.1節)の合成式本体:
 *
 * ```
 * concern = (clusterWouldDissolveContribution + recentMemberJoinedContribution)
 *           * (1 + influenceAvoidance * influenceAvoidanceGain)
 * total   = min(clamp01(attachment * attachmentInhibitionWeight + concern), maxInhibition)
 * ```
 *
 * `influenceAvoidance`は構造的影響factorへの**乗算係数としてのみ**使う(単独では寄与0) ――
 * 構造的影響が存在しない場面(自分が抜けても誰も困らない大人数の輪)では一切作用しない
 * (`influenceAvoidance`が高いことを「消極性の診断」にしない)。`isObserverJoiner`はこの式の
 * いかなる入力にも現れない(ADR 1.4節)。`total`は`maxInhibition < 1`により1に張り付かない
 * (完全ブロック禁止)。rngを一切参照しない。
 */
export function computeDepartureInhibition(ctx: DepartureInhibitionContext): DepartureInhibition {
  const { config } = ctx;
  const attachmentValue = ctx.attachment ? clamp01(ctx.attachment.value) : 0;
  const influenceAvoidance = clamp01(ctx.influenceAvoidance ?? 0);
  const recentJoin = ctx.attachment ? isRecentMemberJoin(ctx.attachment, ctx.tick, config) : false;

  const structuralBase =
    (ctx.dissolutionImpact.wouldDissolve ? config.clusterWouldDissolveConcern : 0) +
    (recentJoin ? config.recentMemberJoinedConcern : 0);
  const influenceAvoidanceIncrement = structuralBase * influenceAvoidance * config.influenceAvoidanceGain;
  const concern = clamp01(structuralBase + influenceAvoidanceIncrement);
  const episodeAttachmentContribution = attachmentValue * config.attachmentInhibitionWeight;
  const total = Math.min(config.maxInhibition, clamp01(episodeAttachmentContribution + concern));

  const factors: DepartureConcernFactor[] = [];
  if (episodeAttachmentContribution > 0) {
    factors.push({ kind: "episodeAttachment", contribution: episodeAttachmentContribution });
  }
  if (ctx.dissolutionImpact.wouldDissolve && config.clusterWouldDissolveConcern > 0) {
    factors.push({ kind: "clusterWouldDissolve", contribution: config.clusterWouldDissolveConcern });
  }
  if (recentJoin && config.recentMemberJoinedConcern > 0) {
    factors.push({ kind: "recentMemberJoined", contribution: config.recentMemberJoinedConcern });
  }
  if (influenceAvoidanceIncrement > 0) {
    factors.push({ kind: "influenceAvoidance", contribution: influenceAvoidanceIncrement });
  }
  factors.sort((a, b) => b.contribution - a.contribution);

  return { attachment: attachmentValue, concern, total, factors };
}
