import type { Agent } from "../types";
import { distance } from "../model";
import { stableSortById } from "../schoolInterventionRuntime";
import type {
  InterventionEffect,
  InterventionEvent,
  SchoolIntervention,
  SchoolInterventionContext,
  SchoolInterventionHookOutput,
} from "../schoolInterventionRuntime";

/**
 * Issue #157: 「近くの人への声かけ促進」介入(`nearby-peer-prompt`)。
 *
 * 教師が組み合わせを決定するのではなく、近接する未決定者(再探索中を含む、`state === "undecided"`)
 * 同士へ「近くのまだ決まっていない人同士で声をかけてみて」と低圧に促す。対象2人を直接同じ
 * `GroupCandidate`へ所属させることはせず、接近確率・attractivenessへの一時的な加算補正
 * (`InterventionEffect`)だけを与える(#156の契約どおり、`engine.ts`の通常判定はそのまま残る)。
 *
 * 対象選択は距離・安定ID順による完全に決定的な選択で、rngは一切使わない(#156の
 * `createInterventionRandom`すら不要)。同一seed・同一設定なら対象agent・発火tickは常に一致する。
 */

/** 停滞判定の下限tick数(曖昧フェーズが始まってすぐの介入を避ける) */
export const NEARBY_PEER_PROMPT_MIN_TICK = 8;
/** 声かけ対象を探す近接半径 */
export const NEARBY_PEER_PROMPT_SEARCH_RADIUS = 150;
/** 一時効果が続く(=同じagentへ再介入しない)tick数 */
export const NEARBY_PEER_PROMPT_BOOST_WINDOW = 20;
/** 接近確率へ加える一時的な加算値 */
export const NEARBY_PEER_PROMPT_APPROACH_BOOST = 0.18;
/**
 * 輪へのattractivenessへ加える一時的な加算値。influenceAvoidanceの壁を完全に消さず、
 * 一時的に緩和したのと同様の後押しを、既存の`InterventionEffect`加算補正の枠組みで近似する。
 */
export const NEARBY_PEER_PROMPT_ATTRACTIVENESS_BOOST = 0.12;

function isEligible(agent: Agent, ctx: SchoolInterventionContext): boolean {
  if (agent.state !== "undecided") return false;
  const expiry = ctx.runtimeState.temporaryEffectExpiryByAgentId[agent.id];
  // 直近で介入済み(効果がまだ有効/クールダウン中)なら、同じagentへ短時間に繰り返し介入しない
  return expiry === undefined || expiry <= ctx.tick;
}

/**
 * 未決定/再探索中のagent同士で、探索半径内かつ距離が最小のペアを1組だけ決定的に選ぶ。
 * `stableSortById`で安定化した走査順(id昇順)で総当たりするため、同距離ならid順で先に見つかった
 * ペアが選ばれる(rng不使用、完全に決定的)。
 */
function findClosestEligiblePair(ctx: SchoolInterventionContext): [Agent, Agent] | undefined {
  const eligible = stableSortById(ctx.agents.filter((agent) => isEligible(agent, ctx)));
  let best: [Agent, Agent] | undefined;
  let bestDistance = NEARBY_PEER_PROMPT_SEARCH_RADIUS;

  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i];
      const b = eligible[j];
      const d = distance(a.x, a.y, b.x, b.y);
      if (d <= bestDistance) {
        bestDistance = d;
        best = [a, b];
      }
    }
  }
  return best;
}

function buildEffectsFor(agentId: string, tick: number): InterventionEffect[] {
  const expiresAtTick = tick + NEARBY_PEER_PROMPT_BOOST_WINDOW;
  return [
    {
      dimension: "approachProbability",
      agentId,
      value: NEARBY_PEER_PROMPT_APPROACH_BOOST,
      startedAtTick: tick,
      expiresAtTick,
    },
    {
      dimension: "attractiveness",
      agentId,
      value: NEARBY_PEER_PROMPT_ATTRACTIVENESS_BOOST,
      startedAtTick: tick,
      expiresAtTick,
    },
  ];
}

function onBeforeApproachDecision(ctx: SchoolInterventionContext): SchoolInterventionHookOutput {
  // この介入はclassroomPair系(学校シナリオ)専用。afterPartyへ誤って適用されても既存挙動を
  // 変えないよう明示的にno-opにする(受入条件: 介入なしと二次会シナリオの既存挙動が変化しない)。
  if (ctx.formationPolicy.id !== "classroomPair") return {};
  // 停滞が観察されたとみなせるtickに達するまでは発火しない
  if (ctx.tick < NEARBY_PEER_PROMPT_MIN_TICK) return {};

  const pair = findClosestEligiblePair(ctx);
  if (!pair) return {};
  const [a, b] = pair;

  const expiresAtTick = ctx.tick + NEARBY_PEER_PROMPT_BOOST_WINDOW;
  const event: InterventionEvent = {
    message: `教師が${a.label}さんと${b.label}さんへ「近くのまだ決まっていない人同士で声をかけてみて」と促した`,
    tags: ["intervention"],
    eventType: "schoolInterventionTriggered",
    metadata: {
      schoolInterventionId: "nearby-peer-prompt",
      agentId: a.id,
      agentLabel: a.label,
      secondAgentId: b.id,
      secondAgentLabel: b.label,
      isTeacherSource: true,
      triggerReason: "stagnantNearbyPair",
      effectStartedAtTick: ctx.tick,
      effectExpiresAtTick: expiresAtTick,
      outcome: "presented",
    },
  };

  return {
    effects: [...buildEffectsFor(a.id, ctx.tick), ...buildEffectsFor(b.id, ctx.tick)],
    events: [event],
    runtimeState: {
      ...ctx.runtimeState,
      intervenedAgentIds: Array.from(new Set([...ctx.runtimeState.intervenedAgentIds, a.id, b.id])),
      temporaryEffectExpiryByAgentId: {
        ...ctx.runtimeState.temporaryEffectExpiryByAgentId,
        [a.id]: expiresAtTick,
        [b.id]: expiresAtTick,
      },
    },
  };
}

export const nearbyPeerPromptIntervention: SchoolIntervention = {
  id: "nearby-peer-prompt",
  onBeforeApproachDecision,
};
