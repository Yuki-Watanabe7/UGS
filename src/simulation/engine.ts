import type { Agent, GroupCandidate, LogEntry, SimParams, SimulationState } from "./types";
import { SeededRandom } from "./random";
import { WORLD_WIDTH, WORLD_HEIGHT, clamp, distance, createInitialAgents } from "./model";

const APPROACH_SPEED = 14;
const WANDER_SPEED = 0.5;
const JOIN_DISTANCE = 26;
const GROUP_GATHER_RADIUS = 60;
const CANDIDATE_MERGE_RADIUS = 40;
// 未定状態が続く間に蓄積するstressの基礎割合。移動速度と釣り合うよう調整済み
// (速すぎると誰も離脱せず、遅すぎると誰も輪にたどり着く前に離脱してしまう)。
const BASE_STRESS_RATE = 0.007;
const OBSERVER_EXTRA_STRESS_RATE = 0.0035;

export function createInitialState(seed: number, params: SimParams): SimulationState {
  const agents = createInitialAgents(seed, params);
  return {
    tick: 0,
    agents,
    groupCandidates: [],
    log: [{ tick: 0, message: "参加者が集まり始めた。まだ誰も二次会に行くかは決めていない。" }],
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    finished: false,
  };
}

function fmtTick(tick: number): string {
  const totalSeconds = tick * 3;
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function pushLog(log: LogEntry[], tick: number, message: string): void {
  log.push({ tick, message: `${fmtTick(tick)} ${message}` });
}

/** candidate.memberIdsへの追加は必ずこの関数を通し、同一agentの重複登録を防ぐ */
function addMemberToCandidate(candidate: GroupCandidate, agentId: string): void {
  if (!candidate.memberIds.includes(agentId)) {
    candidate.memberIds.push(agentId);
  }
}

function nearestCandidate(
  agent: Agent,
  candidates: GroupCandidate[],
): GroupCandidate | undefined {
  let best: GroupCandidate | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = distance(agent.x, agent.y, c.x, c.y);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** そのグループ候補で最も多いcliqueIdとその占有率を返す(既存関係性がない/バラバラな場合はundefined) */
function dominantClique(
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

function attractiveness(
  agent: Agent,
  candidate: GroupCandidate,
  agents: Agent[],
  params: SimParams,
): number {
  const dominant = dominantClique(candidate, agents);
  const isDominantMember = dominant !== undefined && agent.cliqueId === dominant.cliqueId;
  // 仲間内なら後押しされる。既に一つの仲良しグループにほぼ占められた輪ほど、
  // 部外者(observerJoiner含む)には既存関係性の強さに応じて入りにくくなる
  // (占有率50%で影響なし、100%かつ既存関係性MAXでほぼ門前払いになるまで滑らかに強まる)
  const dominanceBeyondHalf = dominant ? clamp((dominant.ratio - 0.5) * 2, 0, 1) : 0;
  const cliqueTieBonus = isDominantMember ? params.existingTieStrength * 0.5 : 0;
  const outsiderPenalty = isDominantMember ? 0 : params.existingTieStrength * dominanceBeyondHalf * 0.75;

  if (candidate.confirmed) {
    const base = agent.willingness * (0.5 + 0.5 * agent.conformity);
    const lateJoinBonus = params.lateJoinEase * 0.4;
    return clamp(base + lateJoinBonus + cliqueTieBonus - outsiderPenalty, 0, 1.5);
  }

  const base = agent.willingness * agent.conformity * (1 - agent.influenceAvoidance);
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
): SimulationState {
  if (state.finished) return state;

  const tick = state.tick + 1;
  const agents = state.agents.map((a) => ({ ...a }));
  let candidates = state.groupCandidates.map((c) => ({ ...c, memberIds: [...c.memberIds] }));
  const log: LogEntry[] = [];

  // 1. 核形成: undecidedな人が forming になるかどうか
  // 核を作れるのは主導性が十分高い人、または既存の仲良しグループが
  // 近くに揃っている人だけ(主導者0人・既存関係性も弱い場なら誰も場を作らない)
  for (const agent of agents) {
    if (agent.state !== "undecided") continue;
    if (agent.isObserverJoiner) continue; // observerJoinerは自ら場を作らない

    const hasInitiative = agent.initiative >= 0.5;
    const cliqueReady =
      agent.cliqueId !== undefined &&
      params.existingTieStrength > 0.5 &&
      agents.filter(
        (other) =>
          other.id !== agent.id &&
          other.cliqueId === agent.cliqueId &&
          other.state === "undecided" &&
          distance(agent.x, agent.y, other.x, other.y) < CANDIDATE_MERGE_RADIUS,
      ).length >= 2;

    if (!hasInitiative && !cliqueReady) continue;

    const formingProbability = hasInitiative
      ? agent.willingness * agent.initiative * 0.08 * (1 + params.numLeaders * 0.15)
      : params.existingTieStrength * 0.1;

    if (rng.chance(formingProbability)) {
      agent.state = "forming";
      const nearbyCandidate = candidates.find(
        (c) => distance(agent.x, agent.y, c.x, c.y) < CANDIDATE_MERGE_RADIUS,
      );
      if (nearbyCandidate) {
        addMemberToCandidate(nearbyCandidate, agent.id);
      } else {
        const candidate: GroupCandidate = {
          id: `group-${tick}-${agent.id}`,
          x: agent.x,
          y: agent.y,
          memberIds: [],
          confirmed: false,
          age: 0,
        };
        addMemberToCandidate(candidate, agent.id);
        candidates.push(candidate);
        pushLog(log, tick, `${agent.label}さんが「もう一軒行く?」と発言し、核を作り始めた`);
      }
    }
  }

  // 2. 接近: undecidedな人が近くの forming / confirmed group を観察して動く
  for (const agent of agents) {
    if (agent.state !== "undecided") continue;

    const candidate = nearestCandidate(agent, candidates);
    if (!candidate) continue;

    const score = attractiveness(agent, candidate, agents, params);
    const approachProbability = clamp(score * 0.35, 0, 0.9);

    if (rng.chance(approachProbability)) {
      agent.state = "approaching";
      agent.joinedGroupId = candidate.id;
      if (agent.isObserverJoiner) {
        pushLog(
          log,
          tick,
          `observerJoinerが${candidate.confirmed ? "成立済みグループ" : "できかけの輪"}に近づき始めた`,
        );
      } else {
        pushLog(log, tick, `${agent.label}さんが輪の近くに移動`);
      }
    } else if (agent.isObserverJoiner && rng.chance(0.1)) {
      pushLog(log, tick, `observerJoinerは様子見を継続`);
    }
  }

  // 3. approaching な人を候補地点へ移動、到着したら参加
  for (const agent of agents) {
    if (agent.state !== "approaching") continue;
    const candidate = candidates.find((c) => c.id === agent.joinedGroupId);
    if (!candidate) {
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
          candidate.confirmed
            ? `observerJoinerが成立済みグループに参加`
            : `observerJoinerが未確定の輪に合流`,
        );
      } else {
        pushLog(
          log,
          tick,
          candidate.confirmed
            ? `${agent.label}さんが成立済みグループに参加`
            : `${agent.label}さんが輪に合流`,
        );
      }
    }
  }

  // 4. forming な人も自分の候補地点に留まりつつ位置を微調整
  for (const agent of agents) {
    if (agent.state !== "forming") continue;
    const candidate = candidates.find((c) => c.memberIds.includes(agent.id));
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
    // 自分には実質入りにくい場合は「行き場がない」ことに変わりないため考慮しない
    const hasWelcomingConfirmedGroup = candidates.some((c) => {
      if (!c.confirmed) return false;
      const dominant = dominantClique(c, agents);
      return !(dominant && dominant.ratio > 0.5 && dominant.cliqueId !== agent.cliqueId);
    });
    let increment =
      (agent.willingness * (1 - agent.ambiguityTolerance) * BASE_STRESS_RATE) /
      Math.max(0.2, params.ambiguityDuration);

    if (agent.isObserverJoiner && !hasWelcomingConfirmedGroup) {
      increment +=
        (agent.willingness * agent.influenceAvoidance * OBSERVER_EXTRA_STRESS_RATE) /
        Math.max(0.2, params.ambiguityDuration);
    }

    agent.stress = clamp(agent.stress + increment, 0, 1);

    if (agent.stress > agent.leaveThreshold) {
      agent.state = "leaving";
      if (agent.isObserverJoiner) {
        pushLog(log, tick, `observerJoinerは曖昧な時間に耐えられず帰宅方向へ`);
      } else {
        pushLog(log, tick, `${agent.label}さんが帰宅方向へ移動`);
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
    }
  }

  // 9. グループ成立判定
  for (const candidate of candidates) {
    if (candidate.confirmed) continue;
    const nearbyCount = agents.filter(
      (a) =>
        (a.state === "forming" || a.state === "joined" || a.state === "approaching") &&
        (candidate.memberIds.includes(a.id) || distance(a.x, a.y, candidate.x, candidate.y) < GROUP_GATHER_RADIUS),
    ).length;
    if (nearbyCount >= params.groupConfirmSize) {
      candidate.confirmed = true;
      pushLog(log, tick, `${nearbyCount}人が集まり二次会グループが成立`);
      for (const agent of agents) {
        if (candidate.memberIds.includes(agent.id) && agent.state === "forming") {
          agent.state = "joined";
          agent.joinedGroupId = candidate.id;
        }
      }
    }
    candidate.age += 1;
  }

  // 期限切れの未確定候補は掃除する(誰も残っていない場合)
  candidates = candidates.filter((c) => c.confirmed || c.memberIds.length > 0 || c.age < 40);

  const allSettled = agents.every((a) => a.state === "joined" || a.state === "left");
  const finished = allSettled || tick >= 400;

  if (finished && !state.finished) {
    const joinedCount = agents.filter((a) => a.state === "joined").length;
    const leftCount = agents.filter((a) => a.state === "left").length;
    pushLog(log, tick, `シミュレーション終了: 参加${joinedCount}人 / 帰宅${leftCount}人`);
  }

  return {
    tick,
    agents,
    groupCandidates: candidates,
    log: [...state.log, ...log],
    width: state.width,
    height: state.height,
    finished,
  };
}
