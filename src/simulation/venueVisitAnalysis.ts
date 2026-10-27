/**
 * Issue #266 (Phase 7): 飲食訪問のread-only集計。
 * eventTypeとmetadataだけを読む。文言は解析しない。stateは変更しない。RNGは使わない。
 */
import {
  VENUE_VISIT_ANALYSIS_SCHEMA_VERSION,
  type LogEntry,
  type SimulationEventType,
  type SimulationState,
  type VenueVisitAnalysis,
  type VenueVisitHistorySnapshot,
} from "./types";
import type { VenueAnchorKind, VenueVisitAbandonReason } from "./venueAnchors";

/** `standingPartyAnalysis.ts` の episode開始eventと同じ集合。飲食後の新しいjoinを数えるため */
const JOIN_EVENT_TYPES: ReadonlySet<SimulationEventType> = new Set([
  "agentJoined",
  "observerJoinedForming",
  "observerJoinedConfirmed",
  "clusterRejoined",
  "clusterTransitionCompleted",
]);

type AwaitingJoin = {
  leftGroupId?: string;
};

function kindOf(entry: LogEntry): VenueAnchorKind | undefined {
  const kind = entry.metadata?.venueAnchorKind;
  return kind === "food" || kind === "drink" ? kind : undefined;
}

/**
 * log全体を1パスで集計する。dashboardのtick filterは掛けない
 * (会話履歴の窓と飲食件数を混ぜない)。
 */
export function buildVenueVisitAnalysis(state: SimulationState): VenueVisitAnalysis {
  const enabled =
    state.formationScenarioId === "standingParty" && state.standingPartyConfig?.venueAnchors.enabled === true;

  let foodVisitCount = 0;
  let drinkVisitCount = 0;
  let arrivedCount = 0;
  let completedCount = 0;
  let abandonedCount = 0;
  let travelDistanceSampleCount = 0;
  let travelDistanceSum = 0;
  let newClusterJoinAfterVisitCount = 0;
  const openVisit = new Map<string, { leftGroupId?: string }>();
  const awaiting = new Map<string, AwaitingJoin>();

  for (const entry of state.log) {
    const agentId = entry.metadata?.agentId;
    switch (entry.eventType) {
      case "venueVisitStarted": {
        const kind = kindOf(entry);
        if (kind === "food") foodVisitCount += 1;
        else if (kind === "drink") drinkVisitCount += 1;
        const distance = entry.metadata?.venueTravelDistance;
        if (distance !== undefined && Number.isFinite(distance)) {
          travelDistanceSampleCount += 1;
          travelDistanceSum += distance;
        }
        if (agentId) {
          openVisit.set(agentId, { leftGroupId: entry.metadata?.groupId });
          awaiting.delete(agentId);
        }
        break;
      }
      case "venueVisitArrived":
        arrivedCount += 1;
        break;
      case "venueVisitCompleted":
        completedCount += 1;
        if (agentId) {
          awaiting.set(agentId, { leftGroupId: openVisit.get(agentId)?.leftGroupId });
          openVisit.delete(agentId);
        }
        break;
      case "venueVisitAbandoned":
        abandonedCount += 1;
        if (agentId) {
          openVisit.delete(agentId);
          awaiting.delete(agentId);
        }
        break;
      default:
        break;
    }

    if (agentId && entry.eventType && JOIN_EVENT_TYPES.has(entry.eventType)) {
      const pending = awaiting.get(agentId);
      const groupId = entry.metadata?.groupId;
      if (pending && groupId) {
        if (pending.leftGroupId === undefined || pending.leftGroupId !== groupId) {
          newClusterJoinAfterVisitCount += 1;
        }
        awaiting.delete(agentId);
      }
    }
  }

  return {
    schemaVersion: VENUE_VISIT_ANALYSIS_SCHEMA_VERSION,
    enabled,
    foodVisitCount,
    drinkVisitCount,
    arrivedCount,
    completedCount,
    abandonedCount,
    travelDistanceSampleCount,
    ...(travelDistanceSampleCount > 0
      ? { meanTravelDistance: travelDistanceSum / travelDistanceSampleCount }
      : {}),
    newClusterJoinAfterVisitCount,
  };
}

/** Inspector用。このagentの直近の到着・取得・完了・放棄tick。閾値は再計算しない */
export function readAgentVenueVisitHistory(
  log: readonly LogEntry[],
  agentId: string,
): VenueVisitHistorySnapshot | undefined {
  let snapshot: VenueVisitHistorySnapshot | undefined;
  for (const entry of log) {
    if (entry.metadata?.agentId !== agentId) continue;
    const anchorId = entry.metadata?.venueAnchorId;
    const kind = kindOf(entry);
    const touch = (patch: VenueVisitHistorySnapshot) => {
      snapshot = {
        ...(snapshot ?? {}),
        ...patch,
        ...(anchorId !== undefined ? { lastAnchorId: anchorId } : {}),
        ...(kind !== undefined ? { lastKind: kind } : {}),
      };
    };
    switch (entry.eventType) {
      case "venueVisitArrived":
        touch({ arrivedAtTick: entry.tick });
        break;
      case "refreshmentObtained":
        touch({ obtainedAtTick: entry.tick });
        break;
      case "venueVisitCompleted":
        touch({ completedAtTick: entry.tick });
        break;
      case "venueVisitAbandoned":
        touch({
          abandonedAtTick: entry.tick,
          ...(entry.metadata?.venueVisitAbandonReason
            ? { abandonReason: entry.metadata.venueVisitAbandonReason as VenueVisitAbandonReason }
            : {}),
        });
        break;
      default:
        break;
    }
  }
  return snapshot;
}
