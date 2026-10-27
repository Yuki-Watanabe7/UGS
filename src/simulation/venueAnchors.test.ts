import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { WORLD_HEIGHT, WORLD_WIDTH, distance } from "./model";
import { getPresetById, DEFAULT_PARAMS } from "./presets";
import { SeededRandom } from "./random";
import {
  DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  STANDING_PARTY_VENUE_CATALOG_CONFIG,
} from "./standingPartyScenarioConfig";
import type { StandingPartyScenarioConfig } from "./standingPartyScenarioConfig";
import type { SimulationState } from "./types";
import {
  DEFAULT_VENUE_ANCHOR_CONFIG,
  MVP_DRINK_ANCHOR,
  MVP_FOOD_ANCHOR,
  MVP_VENUE_ANCHORS,
  VENUE_ANCHOR_MIN_CENTER_SEPARATION,
  validateVenueAnchorConfig,
  venueAnchorConfigWithEnabled,
  venueAnchorsForRun,
  type VenueAnchor,
  type VenueAnchorConfig,
} from "./venueAnchors";

function anchor(overrides: Partial<VenueAnchor> = {}): VenueAnchor {
  return {
    id: "anchor:food-a",
    kind: "food",
    x: 100,
    y: 260,
    interactionRadius: 28,
    capacity: 3,
    serviceTicks: 4,
    label: "料理台",
    ...overrides,
  };
}

function config(overrides: Partial<VenueAnchorConfig> = {}, anchors: VenueAnchor[] = []): VenueAnchorConfig {
  return {
    ...DEFAULT_VENUE_ANCHOR_CONFIG,
    ...overrides,
    needs: { ...DEFAULT_VENUE_ANCHOR_CONFIG.needs, ...overrides.needs },
    visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, ...overrides.visit },
    encounter: { ...DEFAULT_VENUE_ANCHOR_CONFIG.encounter, ...overrides.encounter },
    anchors,
  };
}

function standingConfig(venueAnchors: VenueAnchorConfig): StandingPartyScenarioConfig {
  return { ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG, venueAnchors };
}

const STANDING_PARTY_PARAMS = getPresetById("standing-party").params;

function runStandingParty(venueAnchors: VenueAnchorConfig, seed: number, ticks: number) {
  const formation = { scenarioId: "standingParty" as const, standingPartyConfig: standingConfig(venueAnchors) };
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, STANDING_PARTY_PARAMS, undefined, undefined, undefined, undefined, undefined, formation);
  for (let i = 0; i < ticks; i++) {
    state = stepSimulation(state, STANDING_PARTY_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, formation);
  }
  return { state, probe: [rng.next(), rng.next(), rng.next()] };
}

function withoutVenueCatalog(state: SimulationState): Omit<SimulationState, "venueAnchors" | "standingPartyConfig"> {
  const { venueAnchors: _anchors, standingPartyConfig: _config, ...rest } = state;
  return rest;
}

describe("venueAnchors: MVP placement", () => {
  it("places one food station and one drink station inside the world, apart, and outside the initial spawn box", () => {
    expect(MVP_VENUE_ANCHORS.map((item) => item.id)).toEqual(["anchor:food-main", "anchor:drink-main"]);
    expect(MVP_FOOD_ANCHOR).toMatchObject({ kind: "food", x: 72, y: 460, interactionRadius: 28, label: "料理台" });
    expect(MVP_DRINK_ANCHOR).toMatchObject({ kind: "drink", x: 728, y: 60, interactionRadius: 28, label: "ドリンク台" });
    expect(() => validateVenueAnchorConfig(config({ enabled: true }, [...MVP_VENUE_ANCHORS]))).not.toThrow();

    const separation = distance(MVP_FOOD_ANCHOR.x, MVP_FOOD_ANCHOR.y, MVP_DRINK_ANCHOR.x, MVP_DRINK_ANCHOR.y);
    expect(separation).toBeGreaterThanOrEqual(VENUE_ANCHOR_MIN_CENTER_SEPARATION);

    for (const item of MVP_VENUE_ANCHORS) {
      expect(item.x).toBeGreaterThanOrEqual(5);
      expect(item.x).toBeLessThanOrEqual(WORLD_WIDTH - 5);
      expect(item.y).toBeGreaterThanOrEqual(5);
      expect(item.y).toBeLessThanOrEqual(WORLD_HEIGHT - 5);
      const wall = Math.min(item.x, WORLD_WIDTH - item.x, item.y, WORLD_HEIGHT - item.y);
      expect(wall).toBeGreaterThan(40);
      const inNonCliqueSpawn = item.x >= 80 && item.x < 720 && item.y >= 78 && item.y < 442;
      const inCliqueSpawn = item.x >= 90 && item.x <= 710 && item.y >= 74 && item.y <= 446;
      expect(inNonCliqueSpawn).toBe(false);
      expect(inCliqueSpawn).toBe(false);
    }
  });

  it("keeps the standing-party preset catalog inactive, and leaves other presets and scenarios without it", () => {
    const standing = getPresetById("standing-party");
    expect(standing.formationStandingPartyConfig?.venueAnchors.enabled).toBe(false);
    expect(standing.formationStandingPartyConfig?.venueAnchors.anchors).toEqual(
      STANDING_PARTY_VENUE_CATALOG_CONFIG.venueAnchors.anchors,
    );
    expect(getPresetById("standing-party-networking").formationStandingPartyConfig?.venueAnchors).toEqual(
      DEFAULT_VENUE_ANCHOR_CONFIG,
    );
    expect(getPresetById("standing-party-spatial-roaming").formationStandingPartyConfig?.venueAnchors.enabled).toBe(false);
    expect(getPresetById("standing-party-spatial-roaming").formationStandingPartyConfig?.venueAnchors.anchors).toEqual([]);
    expect(getPresetById("natural").formationStandingPartyConfig).toBeUndefined();
  });
});

describe("venueAnchors: validation", () => {
  it("accepts the default config and an enabled MVP catalog", () => {
    expect(() => validateVenueAnchorConfig(DEFAULT_VENUE_ANCHOR_CONFIG)).not.toThrow();
    expect(() => validateVenueAnchorConfig(venueAnchorConfigWithEnabled(DEFAULT_VENUE_ANCHOR_CONFIG, true))).not.toThrow();
  });

  it("rejects empty ids, duplicate ids, unknown kinds, blank labels, and non-finite geometry", () => {
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ id: "  " })]))).toThrow(/id/);
    expect(() =>
      validateVenueAnchorConfig(config({}, [anchor({ id: "same" }), anchor({ id: "same", x: 400, kind: "drink", label: "ドリンク台" })])),
    ).toThrow(/duplicate/);
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ kind: "snack" as "food" })]))).toThrow(/kind/);
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ label: "" })]))).toThrow(/label/);
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ x: Number.NaN })]))).toThrow(/finite/);
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ y: Number.POSITIVE_INFINITY })]))).toThrow(/finite/);
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ interactionRadius: Number.NaN })]))).toThrow(/finite/);
  });

  it("rejects coordinates outside the reachable world and abnormal radii", () => {
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ x: 4.9 })]))).toThrow(/coordinates/);
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ x: WORLD_WIDTH - 4.9 })]))).toThrow(/coordinates/);
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ y: 4.9 })]))).toThrow(/coordinates/);
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ y: WORLD_HEIGHT - 4.9 })]))).toThrow(/coordinates/);
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ x: 5, y: 5 })]))).not.toThrow();
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ x: WORLD_WIDTH - 5, y: WORLD_HEIGHT - 5 })]))).not.toThrow();
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ interactionRadius: 0 })]))).toThrow(/interactionRadius/);
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ interactionRadius: 80.1 })]))).toThrow(/interactionRadius/);
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ interactionRadius: 80 })]))).not.toThrow();
  });

  it("rejects non-integer capacity and service ticks, close stations, and approach speed past the radius", () => {
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ capacity: 0 })]))).toThrow(/capacity/);
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ capacity: 1.5 })]))).toThrow(/capacity/);
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ serviceTicks: 0 })]))).toThrow(/serviceTicks/);
    expect(() =>
      validateVenueAnchorConfig(
        config({}, [anchor({ id: "a", x: 100 }), anchor({ id: "b", x: 299, kind: "drink", label: "ドリンク台" })]),
      ),
    ).toThrow(/at least 200/);
    expect(() =>
      validateVenueAnchorConfig(
        config({}, [anchor({ id: "a", x: 100 }), anchor({ id: "b", x: 300, kind: "drink", label: "ドリンク台" })]),
      ),
    ).not.toThrow();
    expect(() => validateVenueAnchorConfig(config({}, [anchor({ interactionRadius: 8 })]))).toThrow(/approachSpeed/);
  });

  it("still validates a non-empty catalog when the feature is off, and checks need and visit bounds", () => {
    expect(() => validateVenueAnchorConfig(config({ enabled: false }, [anchor({ x: -10 })]))).toThrow(/coordinates/);
    expect(() => validateVenueAnchorConfig(config({ enabled: false }, []))).not.toThrow();
    expect(() => validateVenueAnchorConfig(config({ needs: { ...DEFAULT_VENUE_ANCHOR_CONFIG.needs, initialMin: 0.4, initialMax: 0.4 } }))).toThrow(
      /initialMin/,
    );
    expect(() => validateVenueAnchorConfig(config({ needs: { ...DEFAULT_VENUE_ANCHOR_CONFIG.needs, rateMin: 1.2, rateMax: 0.8 } }))).toThrow(
      /rateMin/,
    );
    expect(() => validateVenueAnchorConfig(config({ needs: { ...DEFAULT_VENUE_ANCHOR_CONFIG.needs, hungerGainPerTick: -0.1 } }))).toThrow(/gains/);
    expect(() => validateVenueAnchorConfig(config({ needs: { ...DEFAULT_VENUE_ANCHOR_CONFIG.needs, visitThreshold: 0 } }))).toThrow(
      /visitThreshold/,
    );
    expect(() =>
      validateVenueAnchorConfig(config({ needs: { ...DEFAULT_VENUE_ANCHOR_CONFIG.needs, needAfterRefill: 0.7 } })),
    ).toThrow(/needAfterRefill/);
    expect(() => validateVenueAnchorConfig(config({ visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, approachSpeed: 14.1 } }))).toThrow(
      /approachSpeed/,
    );
    expect(() => validateVenueAnchorConfig(config({ visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, failedVisitCooldownTicks: 0 } }))).not.toThrow();
    expect(() => validateVenueAnchorConfig(config({ visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, failedVisitCooldownTicks: -1 } }))).toThrow(
      /failedVisitCooldownTicks/,
    );
    expect(() => validateVenueAnchorConfig(config({ visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, consumeTicks: 1.2 } }))).toThrow(/consumeTicks/);
    expect(() => validateVenueAnchorConfig(config({ encounter: { ...DEFAULT_VENUE_ANCHOR_CONFIG.encounter, radius: -1 } }))).toThrow(/radius/);
  });

  it("installs a detached MVP catalog only when enabling an empty list", () => {
    const enabled = venueAnchorConfigWithEnabled(DEFAULT_VENUE_ANCHOR_CONFIG, true);
    expect(enabled.enabled).toBe(true);
    expect(enabled.anchors.map((item) => item.id)).toEqual(["anchor:food-main", "anchor:drink-main"]);
    enabled.anchors[0].x = 1;
    expect(MVP_FOOD_ANCHOR.x).toBe(72);

    const custom = config({ enabled: false }, [anchor({ id: "anchor:custom", x: 200 })]);
    const kept = venueAnchorConfigWithEnabled(custom, true);
    expect(kept.anchors.map((item) => item.id)).toEqual(["anchor:custom"]);
    kept.anchors[0].x = 5;
    expect(custom.anchors[0].x).toBe(200);

    const disabled = venueAnchorConfigWithEnabled(enabled, false);
    expect(disabled.enabled).toBe(false);
    expect(disabled.anchors).toHaveLength(2);
  });
});

describe("venueAnchors: runtime copy does not change simulation", () => {
  const enabled = venueAnchorConfigWithEnabled(DEFAULT_VENUE_ANCHOR_CONFIG, true);

  it("copies anchors only for an enabled standingParty run, and drops them for other scenarios", () => {
    expect(venueAnchorsForRun("standingParty", DEFAULT_VENUE_ANCHOR_CONFIG)).toBeUndefined();
    expect(venueAnchorsForRun("afterParty", enabled)).toBeUndefined();
    expect(venueAnchorsForRun("classroomPair", enabled)).toBeUndefined();

    const formation = { scenarioId: "standingParty" as const, standingPartyConfig: standingConfig(enabled) };
    const state = createInitialState(3, STANDING_PARTY_PARAMS, undefined, undefined, undefined, undefined, undefined, formation);
    expect(state.venueAnchors?.map((item) => ({ ...item }))).toEqual(enabled.anchors.map((item) => ({ ...item })));
    expect(state.venueAnchors).not.toBe(enabled.anchors);
    state.venueAnchors![0].x = 9;
    expect(enabled.anchors[0].x).toBe(72);

    const inactive = createInitialState(3, STANDING_PARTY_PARAMS, undefined, undefined, undefined, undefined, undefined, {
      scenarioId: "standingParty",
      standingPartyConfig: STANDING_PARTY_VENUE_CATALOG_CONFIG,
    });
    expect(inactive.venueAnchors).toBeUndefined();

    const afterParty = createInitialState(3, DEFAULT_PARAMS, undefined, undefined, undefined, undefined, undefined, {
      scenarioId: "afterParty",
      standingPartyConfig: standingConfig(enabled),
    });
    expect(afterParty.venueAnchors).toBeUndefined();
    expect(afterParty.formationScenarioId).toBe("afterParty");

    const classroom = createInitialState(3, DEFAULT_PARAMS, undefined, undefined, undefined, undefined, undefined, {
      scenarioId: "classroomPair",
      standingPartyConfig: standingConfig(enabled),
    });
    expect(classroom.venueAnchors).toBeUndefined();
    expect(classroom.formationScenarioId).toBe("classroomPair");
  });

  it("keeps agent state, events, and the main PRNG identical when the catalog is shown", () => {
    const off = runStandingParty(DEFAULT_VENUE_ANCHOR_CONFIG, 11, 30);
    const on = runStandingParty(enabled, 11, 30);
    expect(on.state.venueAnchors?.map((item) => item.id)).toEqual(["anchor:food-main", "anchor:drink-main"]);
    expect(on.probe).toEqual(off.probe);
    expect(withoutVenueCatalog(on.state)).toEqual(withoutVenueCatalog(off.state));
    expect(on.state.log.some((entry) => entry.message.includes("料理") || entry.message.includes("ドリンク"))).toBe(false);

    const catalog = runStandingParty(STANDING_PARTY_VENUE_CATALOG_CONFIG.venueAnchors, 11, 30);
    expect(catalog.state.venueAnchors).toBeUndefined();
    expect(catalog.probe).toEqual(off.probe);
    expect(withoutVenueCatalog(catalog.state)).toEqual(withoutVenueCatalog(off.state));
  });

  it("does not keep anchors after the run switches to another scenario", () => {
    const formation = { scenarioId: "standingParty" as const, standingPartyConfig: standingConfig(enabled) };
    const rng = new SeededRandom(4);
    let state = createInitialState(4, STANDING_PARTY_PARAMS, undefined, undefined, undefined, undefined, undefined, formation);
    state = stepSimulation(state, STANDING_PARTY_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, formation);
    expect(state.venueAnchors).toHaveLength(2);
    expect(state.venueAnchors?.[0].x).toBe(72);
    state = stepSimulation(state, STANDING_PARTY_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, {
      scenarioId: "afterParty",
    });
    expect(state.venueAnchors).toBeUndefined();
    expect(state.formationScenarioId).toBe("afterParty");
  });
});
