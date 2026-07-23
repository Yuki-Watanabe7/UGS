import type { AssignmentOrigin, AssignmentOriginCounts, LogEntry, LowPressureInterventionFunnel, SimulationState } from "./types";

/**
 * Issue #170: agentの最終所属("joined")が確定した経路(`AssignmentOrigin`)を、最終stateだけから
 * 推測せず、`state.log`の構造化イベント(Issue #156-159で追加済み)から導出する。`engine.ts`は
 * 一切変更しない(`pairFormation.ts`/`groupFormation.ts`と同じ、既存stateからの非破壊的な導出)。
 *
 * 前提: 学校向け介入は1run中に同時に1つしか選択できない(`state.interventionId`)ため、複数介入が
 * 同一agentへ同時に候補となるケースは扱わない(Issue本文「対象外: 複数介入の同時適用」)。
 */

type LogFilterable = SimulationState["log"];

function isSchoolInterventionEvent(
  entry: LogEntry,
  schoolInterventionId: string,
): entry is LogEntry & { metadata: NonNullable<LogEntry["metadata"]> } {
  return entry.eventType === "schoolInterventionTriggered" && entry.metadata?.schoolInterventionId === schoolInterventionId;
}

/** `teacher-deadline-assignment`により割り当て/再配分されたagentIdの集合(`assignToGroup`/再配分の対象) */
function teacherAssignedAgentIds(log: LogFilterable): Set<string> {
  const ids = new Set<string>();
  for (const entry of log) {
    if (
      (entry.eventType === "teacherAssignedAgent" || entry.eventType === "teacherRebalancedGroup") &&
      entry.metadata?.agentId !== undefined
    ) {
      ids.add(entry.metadata.agentId);
    }
  }
  return ids;
}

/**
 * `teacher-recommendation`受諾済みの推薦が実際に参加成功へ結びついたagentIdの集合。
 * `teacherRecommendation.ts`の`onAfterStateTransition`が`agent.state === "joined" &&
 * agent.joinedGroupId === groupId`のときのみ`triggerReason: "recommendationFulfilled"`を記録するため、
 * 受諾しても実際に所属しなかった場合はここに含まれない。
 */
function recommendationAssistedAgentIds(log: LogFilterable): Set<string> {
  const ids = new Set<string>();
  for (const entry of log) {
    if (
      isSchoolInterventionEvent(entry, "teacher-recommendation") &&
      entry.metadata.triggerReason === "recommendationFulfilled" &&
      entry.metadata.agentId !== undefined
    ) {
      ids.add(entry.metadata.agentId);
    }
  }
  return ids;
}

type Interval = { start: number; end: number };

function withinAnyWindow(tick: number, windows: readonly Interval[]): boolean {
  return windows.some((window) => tick >= window.start && tick < window.end);
}

/**
 * `nearby-peer-prompt`の一時効果期間。この介入は`agentId`/`secondAgentId`両方へ直接
 * (groupIdと紐づかない)`approachProbability`/`attractiveness`の加算補正を与えるため、
 * agent単位の期間だけで十分(`nearbyPeerPrompt.ts`参照)。
 */
function nearbyPeerPromptWindowsForAgent(log: LogFilterable, agentId: string): Interval[] {
  return log
    .filter(
      (entry) =>
        isSchoolInterventionEvent(entry, "nearby-peer-prompt") &&
        entry.metadata.outcome === "presented" &&
        (entry.metadata.agentId === agentId || entry.metadata.secondAgentId === agentId) &&
        entry.metadata.effectStartedAtTick !== undefined &&
        entry.metadata.effectExpiresAtTick !== undefined,
    )
    .map((entry) => ({ start: entry.metadata!.effectStartedAtTick!, end: entry.metadata!.effectExpiresAtTick! }));
}

/**
 * `open-group-signal`は候補(group)単位で「空きあり」表示のon/off区間を持つ(`openGroupSignal.ts`)。
 * `presented`で開始し、次の(`presented`ではない)イベントで終了する区間として組み立てる。
 * runの終了時点まで終了イベントが無ければ、区間は無期限に開いたままとして扱う。
 */
function openGroupSignalWindowsForGroup(log: LogFilterable, groupId: string): Interval[] {
  const relevant = log
    .filter((entry) => isSchoolInterventionEvent(entry, "open-group-signal") && entry.metadata.groupId === groupId)
    .sort((a, b) => a.tick - b.tick);

  const windows: Interval[] = [];
  let openStart: number | undefined;
  for (const entry of relevant) {
    if (entry.metadata!.outcome === "presented") {
      if (openStart === undefined) openStart = entry.metadata!.effectStartedAtTick ?? entry.tick;
    } else if (openStart !== undefined) {
      windows.push({ start: openStart, end: entry.metadata!.effectExpiresAtTick ?? entry.tick });
      openStart = undefined;
    }
  }
  if (openStart !== undefined) windows.push({ start: openStart, end: Number.POSITIVE_INFINITY });
  return windows;
}

/** `agentId`が`groupId`へ向けて接近を開始した最後のtick(接近失敗後の再接近を含め、最新のもの) */
function lastApproachTickToGroup(log: LogFilterable, agentId: string, groupId: string): number | undefined {
  const matches = log.filter(
    (entry) =>
      (entry.eventType === "agentApproached" || entry.eventType === "observerApproached") &&
      entry.metadata?.agentId === agentId &&
      entry.metadata?.groupId === groupId,
  );
  return matches.length === 0 ? undefined : matches[matches.length - 1].tick;
}

/**
 * `state.agents`のうち`state === "joined"`のagentそれぞれについて、所属確定経路を1つに分類する。
 * 戻り値のキーは`agentId`、値は`AssignmentOrigin`。joined以外のagentはキーに含まれない。
 */
export function deriveAssignmentOrigins(state: SimulationState): Record<string, AssignmentOrigin> {
  const origins: Record<string, AssignmentOrigin> = {};
  const joinedAgents = state.agents.filter((agent) => agent.state === "joined");
  if (joinedAgents.length === 0) return origins;

  // `random-assignment-baseline`は自由形成を一切行わないため、joinedは常にランダム割当由来
  // (`randomAssignmentBaseline.ts`のコメント参照)。`interventionId`が未設定でもイベントの有無で判定する。
  const isRandomBaseline = state.log.some((entry) => entry.eventType === "randomAssignmentStarted");
  if (isRandomBaseline) {
    for (const agent of joinedAgents) origins[agent.id] = "randomAssigned";
    return origins;
  }

  const interventionId = state.interventionId;
  const teacherAssignedIds = interventionId === "teacher-deadline-assignment" ? teacherAssignedAgentIds(state.log) : new Set<string>();
  const recommendationAssistedIds =
    interventionId === "teacher-recommendation" ? recommendationAssistedAgentIds(state.log) : new Set<string>();
  const isLowPressure = interventionId === "nearby-peer-prompt" || interventionId === "open-group-signal";

  for (const agent of joinedAgents) {
    if (teacherAssignedIds.has(agent.id)) {
      origins[agent.id] = "teacherAssigned";
      continue;
    }
    if (recommendationAssistedIds.has(agent.id)) {
      origins[agent.id] = "recommendationAssisted";
      continue;
    }
    if (isLowPressure && agent.joinedGroupId !== undefined) {
      const approachTick = lastApproachTickToGroup(state.log, agent.id, agent.joinedGroupId);
      if (approachTick !== undefined) {
        const windows =
          interventionId === "nearby-peer-prompt"
            ? nearbyPeerPromptWindowsForAgent(state.log, agent.id)
            : openGroupSignalWindowsForGroup(state.log, agent.joinedGroupId);
        if (withinAnyWindow(approachTick, windows)) {
          origins[agent.id] = "lowPressureAssisted";
          continue;
        }
      }
    }
    origins[agent.id] = "natural";
  }

  return origins;
}

const ASSIGNMENT_ORIGINS: readonly AssignmentOrigin[] = [
  "natural",
  "lowPressureAssisted",
  "recommendationAssisted",
  "teacherAssigned",
  "randomAssigned",
];

/** `deriveAssignmentOrigins`の戻り値を起源別の人数へ集計する。合計は必ず入力のagent数と一致する */
export function summarizeAssignmentOrigins(origins: Record<string, AssignmentOrigin>): AssignmentOriginCounts {
  const counts = Object.fromEntries(ASSIGNMENT_ORIGINS.map((origin) => [origin, 0])) as AssignmentOriginCounts;
  for (const origin of Object.values(origins)) counts[origin]++;
  return counts;
}

/**
 * `interventionScenarioId`(`nearby-peer-prompt`/`open-group-signal`)専用の「発火 → 対象 → 接近 →
 * 所属/失敗」ファネルを`state.log`から導出する。選択中の介入(`state.interventionId`)が
 * `interventionScenarioId`と一致しない場合は`undefined`を返す(「0」ではなく「対象外」を明示)。
 */
export function buildLowPressureInterventionFunnel(
  state: SimulationState,
  interventionScenarioId: "nearby-peer-prompt" | "open-group-signal",
): LowPressureInterventionFunnel | undefined {
  if (state.interventionId !== interventionScenarioId) return undefined;

  const presentedEvents = state.log.filter(
    (entry) => isSchoolInterventionEvent(entry, interventionScenarioId) && entry.metadata.outcome === "presented",
  );
  const triggeredCount = presentedEvents.length;

  const targetedAgentIds = new Set<string>();
  const targetedGroupIds = new Set<string>();
  for (const entry of presentedEvents) {
    if (entry.metadata!.agentId !== undefined) targetedAgentIds.add(entry.metadata!.agentId);
    if (entry.metadata!.secondAgentId !== undefined) targetedAgentIds.add(entry.metadata!.secondAgentId);
    if (entry.metadata!.groupId !== undefined) targetedGroupIds.add(entry.metadata!.groupId);
  }

  // open-group-signalは特定agentを狙い撃つ介入ではなく、対象groupへ実際に接近したagentを
  // 「対象群にいたと確認できたagent」の近似値として扱う(型定義コメント参照)。
  if (interventionScenarioId === "open-group-signal") {
    for (const entry of state.log) {
      if (
        (entry.eventType === "agentApproached" || entry.eventType === "observerApproached") &&
        entry.metadata?.groupId !== undefined &&
        targetedGroupIds.has(entry.metadata.groupId) &&
        entry.metadata.agentId !== undefined
      ) {
        targetedAgentIds.add(entry.metadata.agentId);
      }
    }
  }

  const origins = deriveAssignmentOrigins(state);
  const assistedJoinCount = Object.values(origins).filter((origin) => origin === "lowPressureAssisted").length;

  let approachedDuringEffectCount = 0;
  let failedAfterApproachCount = 0;
  let noActionCount = 0;

  for (const agentId of targetedAgentIds) {
    const approachEntries = state.log.filter(
      (entry) =>
        (entry.eventType === "agentApproached" || entry.eventType === "observerApproached") &&
        entry.metadata?.agentId === agentId,
    );

    const relevantApproach = approachEntries.find((entry) => {
      const groupId = entry.metadata?.groupId;
      if (interventionScenarioId === "nearby-peer-prompt") {
        return withinAnyWindow(entry.tick, nearbyPeerPromptWindowsForAgent(state.log, agentId));
      }
      if (groupId === undefined || !targetedGroupIds.has(groupId)) return false;
      return withinAnyWindow(entry.tick, openGroupSignalWindowsForGroup(state.log, groupId));
    });

    if (!relevantApproach) {
      noActionCount++;
      continue;
    }
    approachedDuringEffectCount++;

    if (origins[agentId] === "lowPressureAssisted") continue; // assistedJoinCountで既に計上済み

    const failedAfter = state.log.some(
      (entry) =>
        (entry.eventType === "approachTargetInvalidated" || entry.eventType === "joinFailedCapacity") &&
        entry.metadata?.agentId === agentId &&
        entry.tick >= relevantApproach.tick,
    );
    if (failedAfter) failedAfterApproachCount++;
  }

  return {
    interventionScenarioId,
    triggeredCount,
    targetedAgentCount: targetedAgentIds.size,
    targetedGroupCount: targetedGroupIds.size,
    approachedDuringEffectCount,
    assistedJoinCount,
    failedAfterApproachCount,
    noActionCount,
  };
}
