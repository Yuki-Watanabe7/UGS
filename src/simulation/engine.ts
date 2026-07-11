import type {
  Agent,
  GroupCandidate,
  LogEntry,
  LogTag,
  SimParams,
  SimulationEventMetadata,
  SimulationEventType,
  SimulationState,
} from "./types";
import type { InterventionRuntimeOptions, InterventionScenarioId } from "./interventions";
import type { SpeechEvent } from "./speech";
import { createSpeechEvent, deriveSpeechEvents } from "./speech";
import type { SpeechEffectsConfig } from "./speechEffects";
import {
  deriveSpeechEffects,
  deriveSpeechInterpretations,
  deriveSpeechReceptions,
  resolveSpeechEffectsConfig,
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

const APPROACH_SPEED = 14;
const WANDER_SPEED = 0.5;
const JOIN_DISTANCE = 26;
const GROUP_GATHER_RADIUS = 60;
const CANDIDATE_MERGE_RADIUS = 40;
// 未定状態が続く間に蓄積するstressの基礎割合。移動速度と釣り合うよう調整済み
// (速すぎると誰も離脱せず、遅すぎると誰も輪にたどり着く前に離脱してしまう)。
const BASE_STRESS_RATE = 0.007;
const OBSERVER_EXTRA_STRESS_RATE = 0.0035;
// forming候補が成立しないまま存続できる最大tick数。これを超えたら期限切れ(expired)にする
const CANDIDATE_MAX_AGE = 40;
// このtick数までに founder 以外が誰も加わらない(反応が薄い)場合は解散(dissolving)にする
const CANDIDATE_WEAK_RESPONSE_AGE = 15;
// dissolving/dissolved/expired が画面上に留まる(フェードアウト表現用の)tick数。これを超えたら配列から除去する
const CANDIDATE_LINGER_TICKS = 4;

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
): SimulationState {
  const scenario = resolveInterventionScenario(intervention);
  const speechEffectsConfig = resolveSpeechEffectsConfig(speechEffects);
  const effectiveParams = resolveEffectiveParams(params, intervention);
  const agents = createInitialAgents(seed, effectiveParams);
  const log: LogEntry[] = [
    {
      tick: 0,
      message: "参加者が集まり始めた。まだ誰も二次会に行くかは決めていない。",
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

  return {
    tick: 0,
    agents,
    groupCandidates,
    log,
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    finished: false,
    interventionId: scenario.id,
    speechLog: [],
    speechReceptionLog: [],
    speechInterpretationLog: [],
    speechEffectLog: [],
    speechEffectsEnabled: speechEffectsConfig.enabled,
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

/** candidate.memberIdsへの追加は必ずこの関数を通し、同一agentの重複登録を防ぐ */
function addMemberToCandidate(candidate: GroupCandidate, agentId: string): void {
  if (!candidate.memberIds.includes(agentId)) {
    candidate.memberIds.push(agentId);
  }
}

/** 解散中・解散済み・期限切れの候補は接近/合流対象として扱わない */
export function isJoinable(candidate: GroupCandidate): boolean {
  return candidate.status === "forming" || candidate.status === "confirmed";
}

export function nearestCandidate(
  agent: Agent,
  candidates: GroupCandidate[],
): GroupCandidate | undefined {
  let best: GroupCandidate | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (!isJoinable(c)) continue;
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
): number {
  const dominant = dominantClique(candidate, agents);
  const isDominantMember = dominant !== undefined && agent.cliqueId === dominant.cliqueId;
  // 仲間内なら後押しされる。既に一つの仲良しグループにほぼ占められた輪ほど、
  // 部外者(observerJoiner含む)には既存関係性の強さに応じて入りにくくなる
  // (占有率50%で影響なし、100%かつ既存関係性MAXでほぼ門前払いになるまで滑らかに強まる)
  const dominanceBeyondHalf = dominant ? clamp((dominant.ratio - 0.5) * 2, 0, 1) : 0;
  const cliqueTieBonus = isDominantMember ? params.existingTieStrength * 0.5 : 0;
  const outsiderPenalty = isDominantMember ? 0 : params.existingTieStrength * dominanceBeyondHalf * 0.75;

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
      base + lateJoinBonus + predecidedVenueBonus + lateJoinOkBonus + cliqueTieBonus - outsiderPenalty,
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
  return clamp(base + cliqueTieBonus * 0.5 - outsiderPenalty * 0.5, 0, 1.5);
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

export function stepSimulation(
  state: SimulationState,
  params: SimParams,
  rng: SeededRandom,
  intervention?: InterventionRuntimeOptions,
  speechEffects?: Partial<SpeechEffectsConfig>,
): SimulationState {
  if (state.finished) return state;

  // 呼び出し側がこのtickでinterventionを渡し忘れても、createInitialStateから続く
  // 介入設定が消えないよう、未指定時は直前のstateに記録済みのシナリオへfall backする。
  const resolvedIntervention: InterventionRuntimeOptions | undefined =
    intervention ?? (state.interventionId ? { interventionId: state.interventionId } : undefined);
  const effectiveParams = resolveEffectiveParams(params, resolvedIntervention);
  const interventionId = resolveInterventionScenario(resolvedIntervention).id;
  // Phase 3効果も同様に、未指定時は直前のstateの設定を引き継ぐ(呼び出し側の渡し忘れで
  // 途中からOFFに戻ってしまわないようにする)。
  const speechEffectsConfig = resolveSpeechEffectsConfig(
    speechEffects ?? (state.speechEffectsEnabled !== undefined ? { enabled: state.speechEffectsEnabled } : undefined),
  );

  const tick = state.tick + 1;
  const agents = state.agents.map((a) => ({ ...a }));
  let candidates = state.groupCandidates.map((c) => ({ ...c, memberIds: [...c.memberIds] }));
  const log: LogEntry[] = [];
  const speechEvents: SpeechEvent[] = [];

  // 1. 核形成: undecidedな人が forming になるかどうか
  // 核を作れるのは主導性が十分高い人、または既存の仲良しグループが
  // 近くに揃っている人だけ(主導者0人・既存関係性も弱い場なら誰も場を作らない)
  for (const agent of agents) {
    if (agent.state !== "undecided") continue;
    if (agent.isObserverJoiner) continue; // observerJoinerは自ら場を作らない

    const hasInitiative = agent.initiative >= 0.5;
    const cliqueReady =
      agent.cliqueId !== undefined &&
      effectiveParams.existingTieStrength > 0.5 &&
      agents.filter(
        (other) =>
          other.id !== agent.id &&
          other.cliqueId === agent.cliqueId &&
          other.state === "undecided" &&
          distance(agent.x, agent.y, other.x, other.y) < CANDIDATE_MERGE_RADIUS,
      ).length >= 2;

    if (!hasInitiative && !cliqueReady) continue;

    const baseFormingProbability = hasInitiative
      ? agent.willingness * agent.initiative * 0.08 * (1 + effectiveParams.numLeaders * 0.15)
      : effectiveParams.existingTieStrength * 0.1;
    // `anonymous-low-pressure-intent`: 匿名の合図で「参加したい人が一定数いる」ことが伝わり、
    // 主導者/既存グループが核を作り始めやすくなる(声かけの代わりに核形成側を後押しする)
    const formingProbability =
      interventionId === "anonymous-low-pressure-intent"
        ? baseFormingProbability * ANONYMOUS_INTENT_FORMING_PROBABILITY_MULTIPLIER
        : baseFormingProbability;

    if (rng.chance(formingProbability)) {
      agent.state = "forming";
      const nearbyCandidate = candidates.find(
        (c) => c.status === "forming" && distance(agent.x, agent.y, c.x, c.y) < CANDIDATE_MERGE_RADIUS,
      );
      if (nearbyCandidate) {
        addMemberToCandidate(nearbyCandidate, agent.id);
      } else {
        const candidate: GroupCandidate = {
          id: `group-${tick}-${agent.id}`,
          x: agent.x,
          y: agent.y,
          memberIds: [],
          status: "forming",
          age: 0,
        };
        addMemberToCandidate(candidate, agent.id);
        candidates.push(candidate);
        pushLog(
          log,
          tick,
          `${agent.label}さんが「もう一軒行く?」と発言し、核を作り始めた`,
          ["nucleus"],
          "nucleusCreated",
          { agentId: agent.id, agentLabel: agent.label, groupId: candidate.id },
        );
        speechEvents.push(
          createSpeechEvent({
            tick,
            speakerId: agent.id,
            intent: "invite",
            reason: hasInitiative ? "initiativeFormedCore" : "cliqueFormedCore",
            audience: "nearby",
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
        }),
      );
    }
  }

  // 2. 接近: undecidedな人が近くの forming / confirmed group を観察して動く
  for (const agent of agents) {
    if (agent.state !== "undecided") continue;

    const candidate = nearestCandidate(agent, candidates);
    if (!candidate) continue;

    const score = attractiveness(agent, candidate, agents, effectiveParams, interventionId, tick);
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
    const approachProbability = clamp(
      score * 0.35 * anonymousIntentApproachMultiplier * lightInvitationApproachMultiplier,
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
          `observerJoinerが${candidate.status === "confirmed" ? "成立済みグループ" : "できかけの輪"}に近づき始めた`,
          ["observerJoiner"],
          "observerApproached",
          { agentId: agent.id, agentLabel: agent.label, groupId: candidate.id, groupStatus: candidate.status },
        );
      } else {
        pushLog(log, tick, `${agent.label}さんが輪の近くに移動`);
      }
    } else if (agent.isObserverJoiner && rng.chance(0.1)) {
      pushLog(log, tick, `observerJoinerは様子見を継続`, ["observerJoiner"]);
    }
  }

  // 3. approaching な人を候補地点へ移動、到着したら参加
  for (const agent of agents) {
    if (agent.state !== "approaching") continue;
    const candidate = candidates.find((c) => c.id === agent.joinedGroupId);
    // 接近先の輪が解散/期限切れになっていたら、目的地を失ったものとしてundecidedに戻す
    if (!candidate || !isJoinable(candidate)) {
      agent.state = "undecided";
      agent.joinedGroupId = undefined;
      continue;
    }
    stepAgentMotion(agent, candidate);
    const d = distance(agent.x, agent.y, candidate.x, candidate.y);
    if (d < JOIN_DISTANCE) {
      addMemberToCandidate(candidate, agent.id);
      agent.state = "joined";
      if (agent.isObserverJoiner) {
        pushLog(
          log,
          tick,
          candidate.status === "confirmed"
            ? `observerJoinerが成立済みグループに参加`
            : `observerJoinerが未確定の輪に合流`,
          ["observerJoiner"],
          candidate.status === "confirmed" ? "observerJoinedConfirmed" : "observerJoinedForming",
          { agentId: agent.id, agentLabel: agent.label, groupId: candidate.id, joinedGroupStatus: candidate.status },
        );
      } else {
        pushLog(
          log,
          tick,
          candidate.status === "confirmed"
            ? `${agent.label}さんが成立済みグループに参加`
            : `${agent.label}さんが輪に合流`,
        );
      }
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
    let increment =
      (agent.willingness * (1 - agent.ambiguityTolerance) * BASE_STRESS_RATE) /
      Math.max(0.2, effectiveParams.ambiguityDuration);

    if (agent.isObserverJoiner && !hasWelcomingConfirmedGroup) {
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
      increment +=
        (agent.willingness * agent.influenceAvoidance * OBSERVER_EXTRA_STRESS_RATE * noDestinationStressMultiplier) /
        Math.max(0.2, effectiveParams.ambiguityDuration);
    }

    agent.stress = clamp(agent.stress + increment, 0, 1);

    if (agent.stress > agent.leaveThreshold) {
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
      ? Math.round(CANDIDATE_WEAK_RESPONSE_AGE * SHORT_AMBIGUITY_WINDOW_AGE_FACTOR)
      : CANDIDATE_WEAK_RESPONSE_AGE;
  const candidateMaxAge =
    interventionId === "short-ambiguity-window"
      ? Math.round(CANDIDATE_MAX_AGE * SHORT_AMBIGUITY_WINDOW_AGE_FACTOR)
      : CANDIDATE_MAX_AGE;

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
    const nearbyCount = agents.filter(
      (a) =>
        (a.state === "forming" || a.state === "joined" || a.state === "approaching") &&
        (candidate.memberIds.includes(a.id) || distance(a.x, a.y, candidate.x, candidate.y) < GROUP_GATHER_RADIUS),
    ).length;

    if (nearbyCount >= effectiveParams.groupConfirmSize) {
      candidate.status = "confirmed";
      pushLog(log, tick, `${nearbyCount}人が集まり二次会グループが成立`, ["groupConfirmed"], "groupConfirmed", {
        groupId: candidate.id,
        memberCount: nearbyCount,
      });
      for (const agent of agents) {
        if (candidate.memberIds.includes(agent.id) && agent.state === "forming") {
          agent.state = "joined";
          agent.joinedGroupId = candidate.id;
        }
      }
      continue;
    }

    candidate.age += 1;

    // founder以外誰も加わらないまま反応が薄ければ、時間切れを待たずに解散する。
    // ただし公開の集合場所(isPublicMeetingPoint)はfounderがいないことに変わりないため、
    // 反応の薄さだけで早期解散の対象にはしない(期限切れ判定は引き続き適用する)
    if (
      !candidate.isPublicMeetingPoint &&
      candidate.memberIds.length < 2 &&
      candidate.age >= candidateWeakResponseAge
    ) {
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
    } else if (candidate.age >= candidateMaxAge) {
      candidate.status = "expired";
      candidate.age = 0;
      pushLog(
        log,
        tick,
        `輪(${candidate.memberIds.length}人)は二次会成立に至らないまま時間切れになった`,
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
      }
    }
  }

  // 解散/期限切れ候補は、フェードアウト表現用の猶予tickを過ぎたら配列から取り除く
  candidates = candidates.filter((c) => {
    if (c.status === "dissolved" || c.status === "expired") {
      return c.age < CANDIDATE_LINGER_TICKS;
    }
    return true;
  });

  const allSettled = agents.every((a) => a.state === "joined" || a.state === "left");
  const finished = allSettled || tick >= 400;

  if (finished && !state.finished) {
    const joinedCount = agents.filter((a) => a.state === "joined").length;
    const leftCount = agents.filter((a) => a.state === "left").length;
    pushLog(
      log,
      tick,
      `シミュレーション終了: 参加${joinedCount}人 / 帰宅${leftCount}人`,
      ["simulation"],
      "simulationFinished",
    );
  }

  const nextState: SimulationState = {
    tick,
    agents,
    groupCandidates: candidates,
    log: [...state.log, ...log],
    width: state.width,
    height: state.height,
    finished,
    interventionId,
    speechLog: [],
  };

  // formingGroupRecruitment/approachWelcome/joinGreeting/leaveDeclarationは、
  // 発言主体がstate遷移そのものから一意に決まる(rngで選ばれない)ため、
  // 個別のロジック内で都度createSpeechEventを呼ぶ代わりにここでまとめて導出する。
  const derivedSpeechEvents = deriveSpeechEvents(state, nextState);
  const tickSpeechEvents = [...speechEvents, ...derivedSpeechEvents];

  // Phase 3: 認知 -> 解釈 -> 効果の一方向パイプライン。各段の結果を次の段へ明示的に渡すだけで、
  // ここで生成される値がこのtick(またはそれ以降)の意思決定に使われることはない
  // (speechEffectsConfig.enabled === falseの間は3関数とも空配列を返す)。
  const tickReceptions = deriveSpeechReceptions(
    tickSpeechEvents,
    nextState.agents.map((a) => a.id),
    speechEffectsConfig,
  );
  const tickInterpretations = deriveSpeechInterpretations(tickReceptions, tickSpeechEvents, speechEffectsConfig);
  const tickEffects = deriveSpeechEffects(tickInterpretations, tickSpeechEvents, speechEffectsConfig);

  return {
    ...nextState,
    speechLog: [...(state.speechLog ?? []), ...speechEvents, ...derivedSpeechEvents],
    speechReceptionLog: [...(state.speechReceptionLog ?? []), ...tickReceptions],
    speechInterpretationLog: [...(state.speechInterpretationLog ?? []), ...tickInterpretations],
    speechEffectLog: [...(state.speechEffectLog ?? []), ...tickEffects],
    speechEffectsEnabled: speechEffectsConfig.enabled,
  };
}
