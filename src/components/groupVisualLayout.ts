import type { Agent, GroupCandidate } from "../simulation/types";
import type { FormationScenarioId, GroupSizeRule } from "../simulation/formationPolicy";

export type Point = {
  x: number;
  y: number;
};

export type VisualOffset = Point;

export type CandidateVisualLayout = {
  candidateId: string;
  center: Point;
  offset: VisualOffset;
  slotIndex?: number;
  displayRadius: number;
  isEvacuated: boolean;
  isVisible: boolean;
};

export type AgentVisualPosition = Point & {
  agentId: string;
  offset: VisualOffset;
  candidateId?: string;
  isEvacuated: boolean;
  isVisible: boolean;
};

export type ResolvedGroupVisualRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  columns: number;
  visibleCapacity: number;
  overflowCount: number;
};

export type GroupVisualLayout = {
  candidates: ReadonlyMap<string, CandidateVisualLayout>;
  agents: ReadonlyMap<string, AgentVisualPosition>;
  resolvedRegion?: ResolvedGroupVisualRegion;
};

const EDGE_MARGIN = 8;
const REGION_HEADER_HEIGHT = 26;
const REGION_BOTTOM_PADDING = 8;
const SLOT_HEIGHT = 86;
const DESKTOP_COLUMNS = 10;
const COMPACT_COLUMNS = 4;
const COMPACT_VIEWPORT_BREAKPOINT = 480;
const MIN_FORMATION_REGION_HEIGHT = 130;
const MIN_RING_RADIUS = 22;
const MAX_RING_RADIUS = 34;
const RING_HORIZONTAL_SAFETY = 12;
const MEMBER_EDGE_MARGIN = 14;
const DEFAULT_CLASSROOM_GROUP_SIZE = 2;

/**
 * 候補固有のオーバーライド(`candidate.maxGroupSize`。通常は未設定)を優先し、なければ選択中の
 * 学校向け班人数設定(`classroomGroupSize`、Issue #154の`GroupSizeRule`)の`maxGroupSize`を使う。
 * どちらも無ければ現行FormationPolicyの既定値である2人固定として扱う(古い学校stateとの後方互換)。
 * `engine.ts`は`GroupCandidate.maxGroupSize`自体を書き込まない(候補固有オーバーライドの仕組みのみ)
 * ため、Issue #155で3人班・4人班・3〜4人班プリセットを追加した際、この`classroomGroupSize`を
 * 渡し忘れると常に2人固定にフォールバックしてしまう(「満員」判定・退避タイミングが狂う)点に注意。
 */
function finiteGroupSize(candidate: GroupCandidate, classroomGroupSize?: GroupSizeRule): number {
  if (candidate.maxGroupSize !== undefined && Number.isFinite(candidate.maxGroupSize)) {
    return Math.max(1, candidate.maxGroupSize);
  }
  return classroomGroupSize?.maxGroupSize ?? DEFAULT_CLASSROOM_GROUP_SIZE;
}

/**
 * 成立済み領域へ退避する境界。解散・期限切れ表示は既存の実座標フェードを維持し、slotを占有しない。
 * 可変定員(min<max)では、成立(confirmed)後も収容最大人数までは合流を受け付け続けるため、
 * 「成立」だけでなく実際に`maxGroupSize`へ到達したときだけ退避させる(受入条件: 成立済みだが
 * 空きのある班は、まだ合流できるあいだメインの形成領域に残る)。
 */
export function isEvacuatedClassroomCandidate(
  candidate: GroupCandidate,
  formationScenarioId?: FormationScenarioId,
  classroomGroupSize?: GroupSizeRule,
): boolean {
  return (
    formationScenarioId === "classroomPair" &&
    candidate.status === "confirmed" &&
    candidate.memberIds.length >= finiteGroupSize(candidate, classroomGroupSize)
  );
}

/**
 * Canvasが初めてconfirmedとして観測した順にslotを割り当てる。
 * 消えたcandidateのslotは同じrun中は再利用しないため、再登場や配列順変更でも既存slotが動かない。
 * Reset時は呼び出し側が空Mapを渡すことでslot番号を最初から割り当て直す。
 */
export function reconcileGroupVisualSlots(
  previous: ReadonlyMap<string, number>,
  observedCandidateIds: readonly string[],
): Map<string, number> {
  const next = new Map(previous);
  let nextSlot = [...next.values()].reduce((maximum, slot) => Math.max(maximum, slot), -1) + 1;

  for (const candidateId of observedCandidateIds) {
    if (next.has(candidateId)) continue;
    next.set(candidateId, nextSlot);
    nextSlot += 1;
  }

  return next;
}

export type GroupVisualSlotRegistry = {
  resetKey: string;
  assignments: ReadonlyMap<string, number>;
};

/** run/scenario keyが変わった場合だけ空の割当から再開する、Canvas用registry更新境界。 */
export function updateGroupVisualSlotRegistry(
  previous: GroupVisualSlotRegistry,
  resetKey: string,
  observedCandidateIds: readonly string[],
): GroupVisualSlotRegistry {
  const previousAssignments = previous.resetKey === resetKey ? previous.assignments : new Map<string, number>();
  return {
    resetKey,
    assignments: reconcileGroupVisualSlots(previousAssignments, observedCandidateIds),
  };
}

type DeriveGroupVisualLayoutInput = {
  agents: readonly Agent[];
  groupCandidates: readonly GroupCandidate[];
  width: number;
  height: number;
  formationScenarioId?: FormationScenarioId;
  /** Issue #155: 選択中の学校向け班人数設定。`finiteGroupSize`のフォールバック解決にのみ使う */
  classroomGroupSize?: GroupSizeRule;
  slotAssignments: ReadonlyMap<string, number>;
  /** CSS上の表示幅。SVG viewBox幅と異なる場合でも狭幅用の列数を選べるようにする。 */
  viewportWidth?: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function displayRadiusFor(candidate: GroupCandidate, slotWidth: number): number {
  const memberExpansion = Math.max(0, candidate.memberIds.length - 2) * 3;
  const preferred = 28 + memberExpansion;
  const horizontalLimit = (slotWidth - RING_HORIZONTAL_SAFETY) / 2;
  return clamp(Math.min(preferred, horizontalLimit, MAX_RING_RADIUS), MIN_RING_RADIUS, MAX_RING_RADIUS);
}

function defaultCandidateLayout(candidate: GroupCandidate): CandidateVisualLayout {
  return {
    candidateId: candidate.id,
    center: { x: candidate.x, y: candidate.y },
    offset: { x: 0, y: 0 },
    displayRadius: 54,
    isEvacuated: false,
    isVisible: true,
  };
}

/**
 * SimulationStateを変更せず、学校シナリオの満員confirmedグループだけを表示slotへ写像する純粋計算。
 * slot座標は現在の成立件数ではなく固定列数とslotIndexだけで決まるため、新しい成立が増えても既存位置は動かない。
 */
export function deriveGroupVisualLayout({
  agents,
  groupCandidates,
  width,
  height,
  formationScenarioId,
  classroomGroupSize,
  slotAssignments,
  viewportWidth = width,
}: DeriveGroupVisualLayoutInput): GroupVisualLayout {
  const candidateLayouts = new Map<string, CandidateVisualLayout>();
  const evacuatedCandidates = groupCandidates.filter((candidate) =>
    isEvacuatedClassroomCandidate(candidate, formationScenarioId, classroomGroupSize),
  );

  for (const candidate of groupCandidates) candidateLayouts.set(candidate.id, defaultCandidateLayout(candidate));

  if (evacuatedCandidates.length === 0) {
    return {
      candidates: candidateLayouts,
      agents: new Map(
        agents.map((agent) => [
          agent.id,
          {
            agentId: agent.id,
            x: agent.x,
            y: agent.y,
            offset: { x: 0, y: 0 },
            isEvacuated: false,
            isVisible: true,
          },
        ]),
      ),
    };
  }

  const desiredColumns = viewportWidth < COMPACT_VIEWPORT_BREAKPOINT ? COMPACT_COLUMNS : DESKTOP_COLUMNS;
  const columns = Math.min(
    desiredColumns,
    Math.max(
      1,
      Math.floor((width - EDGE_MARGIN * 2) / (MIN_RING_RADIUS * 2 + RING_HORIZONTAL_SAFETY)),
    ),
  );
  const slotWidth = (width - EDGE_MARGIN * 2) / columns;
  const maxRows = Math.max(
    1,
    Math.floor(
      (height - MIN_FORMATION_REGION_HEIGHT - REGION_HEADER_HEIGHT - REGION_BOTTOM_PADDING) /
        SLOT_HEIGHT,
    ),
  );
  const visibleCapacity = columns * maxRows;
  const assignedSlots = evacuatedCandidates
    .map((candidate) => slotAssignments.get(candidate.id))
    .filter((slot): slot is number => slot !== undefined);
  const visibleSlots = assignedSlots.filter((slot) => slot < visibleCapacity);
  const visibleRows = Math.max(
    1,
    Math.min(maxRows, Math.floor(Math.max(...visibleSlots, 0) / columns) + 1),
  );
  const regionHeight =
    REGION_HEADER_HEIGHT + visibleRows * SLOT_HEIGHT + REGION_BOTTOM_PADDING;

  for (const candidate of evacuatedCandidates) {
    const slotIndex = slotAssignments.get(candidate.id);
    if (slotIndex === undefined) continue;
    if (slotIndex >= visibleCapacity) {
      candidateLayouts.set(candidate.id, {
        ...defaultCandidateLayout(candidate),
        slotIndex,
        isEvacuated: true,
        isVisible: false,
      });
      continue;
    }

    const column = slotIndex % columns;
    const row = Math.floor(slotIndex / columns);
    const center = {
      x: EDGE_MARGIN + slotWidth * (column + 0.5),
      y: REGION_HEADER_HEIGHT + SLOT_HEIGHT * (row + 0.5),
    };
    candidateLayouts.set(candidate.id, {
      candidateId: candidate.id,
      center,
      offset: { x: center.x - candidate.x, y: center.y - candidate.y },
      slotIndex,
      displayRadius: displayRadiusFor(candidate, slotWidth),
      isEvacuated: true,
      isVisible: true,
    });
  }

  const evacuatedByMemberId = new Map<string, { candidate: GroupCandidate; layout: CandidateVisualLayout }>();
  for (const candidate of evacuatedCandidates) {
    const layout = candidateLayouts.get(candidate.id);
    if (!layout) continue;
    for (const memberId of candidate.memberIds) {
      if (!evacuatedByMemberId.has(memberId)) evacuatedByMemberId.set(memberId, { candidate, layout });
    }
  }

  const agentPositions = new Map<string, AgentVisualPosition>();
  for (const agent of agents) {
    const membership = evacuatedByMemberId.get(agent.id);
    if (!membership) {
      agentPositions.set(agent.id, {
        agentId: agent.id,
        x: agent.x,
        y: agent.y,
        offset: { x: 0, y: 0 },
        isEvacuated: false,
        isVisible: true,
      });
      continue;
    }

    const { candidate, layout } = membership;
    if (!layout.isVisible) {
      agentPositions.set(agent.id, {
        agentId: agent.id,
        x: agent.x,
        y: agent.y,
        offset: { x: 0, y: 0 },
        candidateId: candidate.id,
        isEvacuated: true,
        isVisible: false,
      });
      continue;
    }

    const relativeX = agent.x - candidate.x;
    const relativeY = agent.y - candidate.y;
    const relativeDistance = Math.hypot(relativeX, relativeY);
    const maximumDistance = Math.max(0, layout.displayRadius - MEMBER_EDGE_MARGIN);
    const scale = relativeDistance > maximumDistance && relativeDistance > 0
      ? maximumDistance / relativeDistance
      : 1;
    const x = layout.center.x + relativeX * scale;
    const y = layout.center.y + relativeY * scale;
    agentPositions.set(agent.id, {
      agentId: agent.id,
      x,
      y,
      offset: { x: x - agent.x, y: y - agent.y },
      candidateId: candidate.id,
      isEvacuated: true,
      isVisible: true,
    });
  }

  const overflowCount = evacuatedCandidates.filter(
    (candidate) => candidateLayouts.get(candidate.id)?.isVisible === false,
  ).length;

  return {
    candidates: candidateLayouts,
    agents: agentPositions,
    resolvedRegion: {
      x: 0,
      y: 0,
      width,
      height: regionHeight,
      columns,
      visibleCapacity,
      overflowCount,
    },
  };
}
