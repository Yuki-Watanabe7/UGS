import type { Agent, SimParams } from "./types";
import { SeededRandom } from "./random";

export const WORLD_WIDTH = 800;
export const WORLD_HEIGHT = 520;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

const NAME_POOL = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J",
  "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T",
];

/** 内部用: 既存の人間関係クラスタ(仲良しグループ)の割り当て */
type CliqueAssignment = Map<number, number | undefined>;

function assignCliques(
  populationSize: number,
  existingTieStrength: number,
  rng: SeededRandom,
): CliqueAssignment {
  const assignment: CliqueAssignment = new Map();
  if (existingTieStrength < 0.35) {
    // 既存関係性が弱い場: みな独立して集まる
    return assignment;
  }
  const cliqueSize = existingTieStrength > 0.6 ? 3 : 4;
  const numCliques = Math.max(1, Math.floor((populationSize * 0.7) / cliqueSize));
  let cliqueIndex = 0;
  const indices = Array.from({ length: populationSize }, (_, i) => i);
  // shuffle deterministically
  for (let i = indices.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  let coveredCount = 0;
  const targetCovered = Math.round(populationSize * 0.7);
  for (const idx of indices) {
    if (coveredCount >= targetCovered || cliqueIndex >= numCliques) break;
    assignment.set(idx, cliqueIndex);
    coveredCount += 1;
    if ((coveredCount / cliqueSize) >= cliqueIndex + 1) {
      cliqueIndex += 1;
    }
  }
  return assignment;
}

export function createInitialAgents(seed: number, params: SimParams): Agent[] {
  const rng = new SeededRandom(seed);
  const population = Math.max(3, Math.round(params.populationSize));
  const observerCount = population >= 20 ? 2 : 1;
  const leaderCount = Math.min(params.numLeaders, population);

  // observerJoinerは既存の人間関係を持たない「よそ者」として扱うため、
  // クラスタ(仲良しグループ)の割り当て対象から外す
  const cliques = assignCliques(population - observerCount, params.existingTieStrength, rng);

  // クラスタごとの中心座標を先に決めておく
  const clusterCenters = new Map<number, { x: number; y: number }>();

  const agents: Agent[] = [];

  for (let i = 0; i < population; i++) {
    const cliqueId = cliques.get(i);
    let center: { x: number; y: number };
    if (cliqueId !== undefined) {
      if (!clusterCenters.has(cliqueId)) {
        clusterCenters.set(cliqueId, {
          x: rng.range(WORLD_WIDTH * 0.15, WORLD_WIDTH * 0.85),
          y: rng.range(WORLD_HEIGHT * 0.2, WORLD_HEIGHT * 0.8),
        });
      }
      center = clusterCenters.get(cliqueId)!;
    } else {
      center = {
        x: rng.range(WORLD_WIDTH * 0.1, WORLD_WIDTH * 0.9),
        y: rng.range(WORLD_HEIGHT * 0.15, WORLD_HEIGHT * 0.85),
      };
    }

    const isObserverJoiner = i >= population - observerCount;
    const isDesignatedLeader = !isObserverJoiner && i < leaderCount;

    let willingness: number;
    let initiative: number;
    let ambiguityTolerance: number;
    let influenceAvoidance: number;
    let conformity: number;
    let leaveThreshold: number;

    if (isObserverJoiner) {
      willingness = 0.8;
      initiative = 0.1;
      ambiguityTolerance = params.observerAmbiguityTolerance;
      influenceAvoidance = params.observerInfluenceAvoidance;
      conformity = 0.5;
      leaveThreshold = clamp(1 - params.observerLeaveEase, 0.05, 0.95);
    } else if (isDesignatedLeader) {
      willingness = clamp(params.overallWillingness + rng.range(0.15, 0.35), 0, 1);
      initiative = rng.range(0.7, 0.95);
      ambiguityTolerance = rng.range(0.5, 0.85);
      influenceAvoidance = rng.range(0.05, 0.25);
      conformity = rng.range(0.3, 0.6);
      leaveThreshold = rng.range(0.6, 0.9);
    } else {
      willingness = clamp(params.overallWillingness + rng.range(-0.25, 0.25), 0.05, 1);
      initiative = rng.range(0.1, 0.45);
      ambiguityTolerance = rng.range(0.2, 0.75);
      influenceAvoidance = rng.range(0.2, 0.7);
      conformity = rng.range(0.35, 0.8);
      leaveThreshold = rng.range(0.3, 0.75);
    }

    const label = NAME_POOL[i % NAME_POOL.length] + (i >= NAME_POOL.length ? String(Math.floor(i / NAME_POOL.length) + 1) : "");

    agents.push({
      id: `agent-${i}`,
      label,
      x: clamp(center.x + rng.range(-30, 30), 10, WORLD_WIDTH - 10),
      y: clamp(center.y + rng.range(-30, 30), 10, WORLD_HEIGHT - 10),
      vx: 0,
      vy: 0,
      willingness,
      initiative,
      ambiguityTolerance,
      influenceAvoidance,
      conformity,
      leaveThreshold,
      isObserverJoiner,
      state: "undecided",
      stress: 0,
      cliqueId,
    });
  }

  return agents;
}
