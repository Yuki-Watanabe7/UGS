import type {
  Agent,
  ObserverJoinerInspection,
  ObserverSpeechHistoryEntry,
  SimParams,
  SimulationState,
} from "./types";
import type { SpeechEvent } from "./speech";
import { distance } from "./model";
import { attractiveness, nearestCandidate } from "./engine";

/**
 * agentIdが関わる発言を、tick順のまま関わり方(speaker/target/audience)付きで抽出する。
 * "nearby" audienceの簡略化についてはtypes.tsの`ObserverSpeechHistoryEntry`参照。
 */
function buildSpeechHistory(agentId: string, speechLog: SpeechEvent[]): ObserverSpeechHistoryEntry[] {
  const history: ObserverSpeechHistoryEntry[] = [];
  for (const event of speechLog) {
    if (event.speakerId === agentId) {
      history.push({ event, relation: "speaker" });
    } else if (event.target === agentId) {
      history.push({ event, relation: "target" });
    } else if (event.audience === "nearby") {
      history.push({ event, relation: "audience" });
    }
  }
  return history;
}

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
    attractivenessScore: candidate
      ? attractiveness(
          agent,
          candidate,
          state.agents,
          params,
          state.interventionId,
          state.tick,
          state.activeSpeechEffects ?? [],
        )
      : undefined,
    speechHistory: buildSpeechHistory(agent.id, state.speechLog ?? []),
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
