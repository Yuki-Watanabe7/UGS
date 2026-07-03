import type {
  Agent,
  AgentState,
  LogEntry,
  ObserverJoinerRunSummary,
  SimulationEventType,
  SimulationState,
  SimulationSummary,
} from "./types";

function ticksFor(log: LogEntry[], eventType: SimulationEventType, agentId?: string): number[] {
  return log
    .filter((entry) => entry.eventType === eventType && (agentId === undefined || entry.metadata?.agentId === agentId))
    .map((entry) => entry.tick);
}

function minTick(ticks: number[]): number | undefined {
  return ticks.length === 0 ? undefined : Math.min(...ticks);
}

function lastTick(ticks: number[]): number | undefined {
  return ticks.length === 0 ? undefined : ticks[ticks.length - 1];
}

function buildObserverJoinerRunSummary(
  agent: Agent,
  log: LogEntry[],
  firstGroupConfirmedTick: number | undefined,
): ObserverJoinerRunSummary {
  const approachedTick = lastTick(ticksFor(log, "observerApproached", agent.id));

  const joinedEntries = log.filter(
    (entry) =>
      (entry.eventType === "observerJoinedForming" || entry.eventType === "observerJoinedConfirmed") &&
      entry.metadata?.agentId === agent.id,
  );
  const joinedEntry = joinedEntries.at(-1);
  const joinedTick = joinedEntry?.tick;
  const joinedGroupStatus = joinedEntry?.metadata?.joinedGroupStatus;

  const leaveStartedTick = lastTick(ticksFor(log, "observerLeaveStarted", agent.id));
  const leftTick = lastTick(ticksFor(log, "observerLeft", agent.id));

  const lateJoinSucceeded =
    agent.state === "joined" &&
    (joinedGroupStatus === "confirmed" ||
      (firstGroupConfirmedTick !== undefined && joinedTick !== undefined && joinedTick > firstGroupConfirmedTick));

  return {
    agentId: agent.id,
    label: agent.label,
    finalState: agent.state,
    joinedGroupId: agent.joinedGroupId,
    approachedTick,
    joinedTick,
    joinedGroupStatus,
    leaveStartedTick,
    leftTick,
    lateJoinSucceeded,
  };
}

/**
 * SimulationStateから終了(または途中経過の暫定)サマリーを導出する。
 * `state.log`の構造化イベント(`eventType`/`metadata`)と`state.agents`のみを読み取り、
 * 表示用の`message`文言は一切参照しない。SimulationStateはmutationしない。
 */
export function buildSimulationSummary(state: SimulationState): SimulationSummary {
  const stateCounts: Record<AgentState, number> = {
    undecided: 0,
    forming: 0,
    approaching: 0,
    joined: 0,
    leaving: 0,
    left: 0,
  };
  for (const agent of state.agents) {
    stateCounts[agent.state] += 1;
  }

  const groupConfirmedTicks = ticksFor(state.log, "groupConfirmed");
  const firstGroupConfirmedTick = minTick(groupConfirmedTicks);

  const observerJoiners = state.agents
    .filter((agent) => agent.isObserverJoiner)
    .map((agent) => buildObserverJoinerRunSummary(agent, state.log, firstGroupConfirmedTick));

  const finishedTick = state.finished
    ? (state.log.find((entry) => entry.eventType === "simulationFinished")?.tick ?? state.tick)
    : undefined;

  return {
    finished: state.finished,
    finishedTick,
    joinedCount: stateCounts.joined,
    leftCount: stateCounts.left,
    stateCounts,
    observerJoiners,
    firstNucleusTick: minTick(ticksFor(state.log, "nucleusCreated")),
    firstGroupConfirmedTick,
    confirmedGroupCount: groupConfirmedTicks.length,
    groupFailure: groupConfirmedTicks.length === 0,
  };
}
