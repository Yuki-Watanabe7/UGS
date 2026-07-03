import type { Agent, ObserverJoinerInspection, SimParams, SimulationState } from "./types";
import { distance } from "./model";
import { attractiveness, nearestCandidate } from "./engine";

function buildInspection(
  agent: Agent,
  state: SimulationState,
  params: SimParams,
): ObserverJoinerInspection {
  const candidate = nearestCandidate(agent, state.groupCandidates);

  return {
    agentId: agent.id,
    label: agent.label,
    state: agent.state,
    stress: agent.stress,
    willingness: agent.willingness,
    ambiguityTolerance: agent.ambiguityTolerance,
    influenceAvoidance: agent.influenceAvoidance,
    leaveThreshold: agent.leaveThreshold,
    leaveMargin: agent.leaveThreshold - agent.stress,
    nearestGroupId: candidate?.id,
    nearestGroupStatus: candidate?.status,
    nearestGroupMemberCount: candidate?.memberIds.length,
    nearestGroupDistance: candidate ? distance(agent.x, agent.y, candidate.x, candidate.y) : undefined,
    attractivenessScore: candidate ? attractiveness(agent, candidate, state.agents, params) : undefined,
  };
}

/**
 * observerJoinerの内部状態と意思決定要因(最寄りの輪・attractiveness・離脱余力)を
 * 読み取り専用データとして組み立てる。SimulationStateは変更しない。
 * observerJoinerが一人もいない場合は空配列を返す。
 */
export function buildObserverJoinerInspection(
  state: SimulationState,
  params: SimParams,
): ObserverJoinerInspection[] {
  return state.agents.filter((agent) => agent.isObserverJoiner).map((agent) => buildInspection(agent, state, params));
}
