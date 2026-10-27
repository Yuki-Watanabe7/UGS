import { describe, expect, it } from "vitest";
import { createSpatialRandom } from "./roaming";
import { SeededRandom } from "./random";
import {
  advanceRefreshmentNeed,
  applyRefreshmentRefill,
  applyVisitCooldown,
  createInitialRefreshmentNeed,
  createInitialRefreshmentNeeds,
  createVenueRandom,
  stepRefreshmentNeeds,
} from "./refreshmentNeeds";
import { DEFAULT_VENUE_ANCHOR_CONFIG, type AgentRefreshmentNeed } from "./venueAnchors";

const needsConfig = DEFAULT_VENUE_ANCHOR_CONFIG.needs;

describe("refreshment needs (Issue #263 / ADR §3)", () => {
  it("初期化は派生streamを4回だけ使い、主系列と空間roamingの系列を消費しない", () => {
    const probe = createVenueRandom(5, "needInit", "agent-a", 0);
    const hunger = probe.range(needsConfig.initialMin, needsConfig.initialMax);
    const thirst = probe.range(needsConfig.initialMin, needsConfig.initialMax);
    const hungerRate = probe.range(needsConfig.rateMin, needsConfig.rateMax);
    const thirstRate = probe.range(needsConfig.rateMin, needsConfig.rateMax);
    expect(createInitialRefreshmentNeed(5, "agent-a", needsConfig)).toEqual({
      hunger,
      thirst,
      hungerRate,
      thirstRate,
    });

    const mainA = new SeededRandom(9);
    const mainB = new SeededRandom(9);
    createInitialRefreshmentNeed(9, "agent-a", needsConfig);
    expect(mainA.next()).toBe(mainB.next());

    const spatial = createSpatialRandom(5, "roaming", "agent-a", 0);
    const venue = createVenueRandom(5, "needInit", "agent-a", 0);
    expect(spatial.next()).not.toBe(venue.next());
  });

  it("同一seedは同一need、agentが違えば個体差が出る", () => {
    const agents = Array.from({ length: 8 }, (_, i) => ({ id: `a-${i}` }));
    const a = createInitialRefreshmentNeeds(agents, 11, needsConfig);
    const b = createInitialRefreshmentNeeds(agents, 11, needsConfig);
    expect(a).toEqual(b);
    const hungers = new Set(Object.values(a).map((need) => need.hunger));
    expect(hungers.size).toBeGreaterThan(1);
    for (const need of Object.values(a)) {
      expect(need.hunger).toBeGreaterThanOrEqual(needsConfig.initialMin);
      expect(need.hunger).toBeLessThan(needsConfig.initialMax);
      expect(need.thirst).toBeGreaterThanOrEqual(needsConfig.initialMin);
      expect(need.thirst).toBeLessThan(needsConfig.initialMax);
      expect(need.hungerRate).toBeGreaterThanOrEqual(needsConfig.rateMin);
      expect(need.hungerRate).toBeLessThan(needsConfig.rateMax);
    }
  });

  it("hungerとthirstは独立に増分し、[0,1]に収まる", () => {
    const start: AgentRefreshmentNeed = { hunger: 0.2, thirst: 0.35, hungerRate: 1, thirstRate: 1.15 };
    const once = advanceRefreshmentNeed(start, needsConfig);
    expect(once.hunger).toBeCloseTo(0.2 + 0.0032, 10);
    expect(once.thirst).toBeCloseTo(0.35 + 0.004 * 1.15, 10);
    expect(once.hungerRate).toBe(1);
    expect(once.thirstRate).toBe(1.15);

    const capped = advanceRefreshmentNeed({ ...start, hunger: 0.999, thirst: 0.999 }, needsConfig);
    expect(capped.hunger).toBe(1);
    expect(capped.thirst).toBe(1);
  });

  it("既定係数では閾値前は届かず、数百tick以内に閾値を超える", () => {
    let early: AgentRefreshmentNeed = { hunger: 0.349, thirst: 0.349, hungerRate: 1.15, thirstRate: 1.15 };
    for (let i = 0; i < 20; i++) early = advanceRefreshmentNeed(early, needsConfig);
    expect(early.hunger).toBeLessThan(needsConfig.visitThreshold);
    expect(early.thirst).toBeLessThan(needsConfig.visitThreshold);

    let hungerSteps = 0;
    let hunger: AgentRefreshmentNeed = { hunger: 0.2, thirst: 0, hungerRate: 1, thirstRate: 1 };
    while (hunger.hunger < needsConfig.visitThreshold && hungerSteps < 400) {
      hunger = advanceRefreshmentNeed(hunger, needsConfig);
      hungerSteps += 1;
    }
    expect(hungerSteps).toBeGreaterThan(100);
    expect(hungerSteps).toBeLessThan(250);

    let thirstSteps = 0;
    let thirst: AgentRefreshmentNeed = { hunger: 0, thirst: 0.35, hungerRate: 1, thirstRate: 1.15 };
    while (thirst.thirst < needsConfig.visitThreshold && thirstSteps < 400) {
      thirst = advanceRefreshmentNeed(thirst, needsConfig);
      thirstSteps += 1;
    }
    expect(thirstSteps).toBeLessThan(hungerSteps);
    expect(thirstSteps).toBeLessThan(120);
  });

  it("標準presetの人口を300tick進めると、複数agentが閾値以上になる", () => {
    const agents = Array.from({ length: 24 }, (_, i) => ({ id: `agent-${i}`, state: "undecided" }));
    let needs = createInitialRefreshmentNeeds(agents, 4, needsConfig);
    for (let tick = 0; tick < 20; tick++) needs = stepRefreshmentNeeds(agents, needs, 4, needsConfig);
    expect(Object.values(needs).every((need) => need.hunger < 0.7 && need.thirst < 0.7)).toBe(true);

    for (let tick = 20; tick < 300; tick++) needs = stepRefreshmentNeeds(agents, needs, 4, needsConfig);
    const above = Object.values(needs).filter((need) => need.hunger >= 0.7 || need.thirst >= 0.7);
    expect(above.length).toBeGreaterThanOrEqual(2);
  });

  it("left/unassignedは増分せず、補充はpurpose側だけを下げ、cooldownはもう一方を変えない", () => {
    const agents = [
      { id: "stay", state: "joined" },
      { id: "gone", state: "left" },
      { id: "open", state: "unassigned" },
    ];
    const previous = {
      stay: { hunger: 0.4, thirst: 0.4, hungerRate: 1, thirstRate: 1 },
      gone: { hunger: 0.4, thirst: 0.5, hungerRate: 1, thirstRate: 1 },
      open: { hunger: 0.2, thirst: 0.2, hungerRate: 1, thirstRate: 1 },
    };
    const next = stepRefreshmentNeeds(agents, previous, 1, needsConfig);
    expect(next.stay.hunger).toBeGreaterThan(0.4);
    expect(next.gone).toEqual(previous.gone);
    expect(next.open).toEqual(previous.open);

    const gained = advanceRefreshmentNeed(
      { hunger: 0.5, thirst: 0.8, hungerRate: 1, thirstRate: 1, foodCooldownUntilTick: 10 },
      needsConfig,
    );
    const refilled = applyRefreshmentRefill(gained, "drink", needsConfig.needAfterRefill);
    expect(refilled.thirst).toBe(0.15);
    expect(refilled.hunger).toBe(gained.hunger);
    expect(refilled.foodCooldownUntilTick).toBe(10);

    const cooled = applyVisitCooldown(refilled, "drink", 40, 55);
    expect(cooled.drinkCooldownUntilTick).toBe(95);
    expect(cooled.foodCooldownUntilTick).toBe(10);
    expect(cooled.hunger).toBe(refilled.hunger);
  });
});
