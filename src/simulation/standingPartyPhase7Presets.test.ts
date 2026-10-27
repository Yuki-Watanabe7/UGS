import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import type { FormationRuntimeOptions } from "./formationPolicy";
import { getPresetById } from "./presets";
import { SeededRandom } from "./random";
import {
  SPATIAL_ROAMING_STANDING_PARTY_CONFIG,
  VENUE_OFF_BASELINE_STANDING_PARTY_CONFIG,
  VENUE_REFRESHMENT_STANDING_PARTY_CONFIG,
} from "./standingPartyScenarioConfig";
import { validateVenueAnchorConfig } from "./venueAnchors";
import { buildStandingPartyAnalysisExport } from "./analysisExport";
import { STANDING_PARTY_ANALYSIS_EXPORT_SCHEMA_VERSION } from "./analysisExport";

function formationOf(presetId: string): FormationRuntimeOptions {
  const preset = getPresetById(presetId);
  return {
    scenarioId: "standingParty",
    standingPartyConfig: preset.formationStandingPartyConfig,
  };
}

function snapshot(presetId: string, seed: number, ticks: number) {
  const preset = getPresetById(presetId);
  const formation = formationOf(presetId);
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
  for (let i = 0; i < ticks; i++) {
    state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
  }
  return {
    agents: state.agents.map((agent) => ({
      id: agent.id,
      x: agent.x,
      y: agent.y,
      state: agent.state,
      stress: agent.stress,
      joinedGroupId: agent.joinedGroupId,
    })),
    log: state.log.map((entry) => ({
      tick: entry.tick,
      message: entry.message,
      eventType: entry.eventType,
    })),
    nextDraw: rng.next(),
    venueAnchors: state.venueAnchors?.map((anchor) => anchor.id),
    visitCount: Object.keys(state.venueRuntimeState?.visits ?? {}).length,
  };
}

describe("Phase 7 venue presets (Issue #266)", () => {
  it("keeps the two comparison presets aligned except venueAnchors.enabled", () => {
    const on = getPresetById("standing-party-venue-refreshment");
    const off = getPresetById("standing-party-venue-off-baseline");
    const roaming = getPresetById("standing-party-spatial-roaming");
    expect(on.params).toEqual(off.params);
    expect(on.params).toEqual(roaming.params);
    expect(on.formationStandingPartyConfig?.venueAnchors.enabled).toBe(true);
    expect(off.formationStandingPartyConfig?.venueAnchors.enabled).toBe(false);
    expect(roaming.formationStandingPartyConfig?.venueAnchors.enabled).toBe(false);
    const { enabled: onEnabled, ...onRest } = VENUE_REFRESHMENT_STANDING_PARTY_CONFIG.venueAnchors;
    const { enabled: offEnabled, ...offRest } = VENUE_OFF_BASELINE_STANDING_PARTY_CONFIG.venueAnchors;
    expect(onEnabled).toBe(true);
    expect(offEnabled).toBe(false);
    expect(onRest).toEqual(offRest);
    expect(onRest.encounterEnabled).toBe(true);
    const { venueAnchors: onVenue, ...onSocial } = VENUE_REFRESHMENT_STANDING_PARTY_CONFIG;
    const { venueAnchors: roamingVenue, ...roamingSocial } = SPATIAL_ROAMING_STANDING_PARTY_CONFIG;
    expect(onSocial).toEqual(roamingSocial);
    expect(onVenue.enabled).toBe(true);
    expect(roamingVenue.enabled).toBe(false);
    expect(getPresetById("standing-party").id).toBe("standing-party");
    expect(getPresetById("standing-party-spatial-roaming").id).toBe("standing-party-spatial-roaming");
  });

  it("matches the Phase 6 roaming preset while venues are off", () => {
    const baseline = snapshot("standing-party-venue-off-baseline", 11, 40);
    const roaming = snapshot("standing-party-spatial-roaming", 11, 40);
    expect(baseline.agents).toEqual(roaming.agents);
    expect(baseline.log).toEqual(roaming.log);
    expect(baseline.nextDraw).toBe(roaming.nextDraw);
    expect(baseline.venueAnchors).toBeUndefined();
  });

  it("places both stations and can finish a visit on a fixed seed", () => {
    const preset = getPresetById("standing-party-venue-refreshment");
    const formation = formationOf(preset.id);
    const seed = 4;
    const rng = new SeededRandom(seed);
    let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
    expect(state.venueAnchors?.map((anchor) => anchor.id)).toEqual(["anchor:food-main", "anchor:drink-main"]);
    expect(state.venueRuntimeState?.visits).toEqual({});
    let sawTravel = false;
    let sawObtain = false;
    let sawReturn = false;
    for (let i = 0; i < 400 && !sawReturn; i++) {
      state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
      const traveling = Object.values(state.venueRuntimeState?.visits ?? {}).some((visit) => visit.phase === "traveling");
      if (traveling) sawTravel = true;
      if (state.log.some((entry) => entry.eventType === "refreshmentObtained")) sawObtain = true;
      if (state.log.some((entry) => entry.eventType === "venueVisitCompleted")) sawReturn = true;
    }
    expect(sawTravel).toBe(true);
    expect(sawObtain).toBe(true);
    expect(sawReturn).toBe(true);
    const bundle = buildStandingPartyAnalysisExport(state, {
      presetId: preset.id,
      standingPartyConfig: preset.formationStandingPartyConfig,
      simParams: preset.params,
    });
    expect(bundle.schemaVersion).toBe(STANDING_PARTY_ANALYSIS_EXPORT_SCHEMA_VERSION);
    expect(bundle.schemaVersion).toBe("standing-party-analysis-export/4");
    expect(bundle.analysisSchemaVersion).toBe(2);
    expect(bundle.venueVisits.schemaVersion).toBe("venue-visit-analysis/1");
    expect(bundle.venueVisits.summary.completedCount).toBeGreaterThan(0);
    expect(bundle.venueVisits.config?.enabled).toBe(true);
  });

  it("accepts the advanced-settings bounds in runtime validation", () => {
    const config = structuredClone(VENUE_REFRESHMENT_STANDING_PARTY_CONFIG.venueAnchors);
    config.needs.hungerGainPerTick = 0;
    config.needs.thirstGainPerTick = 0.02;
    config.needs.visitThreshold = 0.05;
    config.needs.needAfterRefill = 0.04;
    config.visit.revisitCooldownTicks = 1;
    for (const anchor of config.anchors) anchor.serviceTicks = 30;
    expect(() => validateVenueAnchorConfig(config)).not.toThrow();
    config.visit.revisitCooldownTicks = 200;
    for (const anchor of config.anchors) anchor.serviceTicks = 1;
    config.needs.visitThreshold = 1;
    expect(() => validateVenueAnchorConfig(config)).not.toThrow();
  });
});
