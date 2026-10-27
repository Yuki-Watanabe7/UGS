import { describe, expect, it } from "vitest";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG, validateStandingPartyScenarioConfig } from "./standingPartyScenarioConfig";
import {
  DEFAULT_VENUE_ANCHOR_CONFIG,
  MVP_DRINK_ANCHOR,
  MVP_FOOD_ANCHOR,
  MVP_VENUE_ANCHORS,
  validateVenueAnchorConfig,
  type VenueAnchorConfig,
} from "./venueAnchors";

function withAnchors(anchors: VenueAnchorConfig["anchors"], patch: Partial<VenueAnchorConfig> = {}): VenueAnchorConfig {
  return {
    ...DEFAULT_VENUE_ANCHOR_CONFIG,
    ...patch,
    anchors,
    needs: { ...DEFAULT_VENUE_ANCHOR_CONFIG.needs, ...patch.needs },
    visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, ...patch.visit },
    encounter: { ...DEFAULT_VENUE_ANCHOR_CONFIG.encounter, ...patch.encounter },
  };
}

describe("validateVenueAnchorConfig (Issue #263 / ADR §2.2, §9.1)", () => {
  it("既定(enabled false・anchorなし)とMVP2台を受け入れる", () => {
    expect(() => validateVenueAnchorConfig(DEFAULT_VENUE_ANCHOR_CONFIG)).not.toThrow();
    expect(DEFAULT_VENUE_ANCHOR_CONFIG.enabled).toBe(false);
    expect(() => validateVenueAnchorConfig(withAnchors([...MVP_VENUE_ANCHORS], { enabled: true }))).not.toThrow();
    expect(MVP_FOOD_ANCHOR.kind).toBe("food");
    expect(MVP_DRINK_ANCHOR.kind).toBe("drink");
  });

  it("enabledがfalseでも、配列に不正なanchorがあれば拒否する", () => {
    expect(() => validateVenueAnchorConfig(withAnchors([{ ...MVP_FOOD_ANCHOR, x: 0 }]))).toThrow(/coordinates/);
  });

  it("重複id・空label・範囲外半径・非整数capacityを拒否する", () => {
    expect(() =>
      validateVenueAnchorConfig(withAnchors([MVP_FOOD_ANCHOR, { ...MVP_DRINK_ANCHOR, id: MVP_FOOD_ANCHOR.id }])),
    ).toThrow(/duplicates/);
    expect(() => validateVenueAnchorConfig(withAnchors([{ ...MVP_FOOD_ANCHOR, label: "" }]))).toThrow(/label/);
    expect(() => validateVenueAnchorConfig(withAnchors([{ ...MVP_FOOD_ANCHOR, interactionRadius: 81 }]))).toThrow(
      /interactionRadius/,
    );
    expect(() => validateVenueAnchorConfig(withAnchors([{ ...MVP_FOOD_ANCHOR, capacity: 1.5 }]))).toThrow(/capacity/);
  });

  it("中心距離が200未満、またはapproachSpeedが半径を超える配置を拒否する", () => {
    expect(() =>
      validateVenueAnchorConfig(
        withAnchors([
          MVP_FOOD_ANCHOR,
          { ...MVP_DRINK_ANCHOR, x: MVP_FOOD_ANCHOR.x + 50, y: MVP_FOOD_ANCHOR.y },
        ]),
      ),
    ).toThrow(/minimum is 200/);
    expect(() =>
      validateVenueAnchorConfig(
        withAnchors([{ ...MVP_FOOD_ANCHOR, interactionRadius: 10 }], { visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, approachSpeed: 12 } }),
      ),
    ).toThrow(/approachSpeed/);
  });

  it("needAfterRefillは閾値未満、failedVisitCooldownTicksは0を許す", () => {
    expect(() =>
      validateVenueAnchorConfig(
        withAnchors([], {
          needs: { ...DEFAULT_VENUE_ANCHOR_CONFIG.needs, needAfterRefill: 0.7, visitThreshold: 0.7 },
        }),
      ),
    ).toThrow(/needAfterRefill/);
    expect(() =>
      validateVenueAnchorConfig(
        withAnchors([], { visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, failedVisitCooldownTicks: 0 } }),
      ),
    ).not.toThrow();
    expect(() =>
      validateVenueAnchorConfig(
        withAnchors([], { visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, failedVisitCooldownTicks: -1 } }),
      ),
    ).toThrow(/failedVisitCooldownTicks/);
  });

  it("standingPartyの検証がvenueAnchorsを通す", () => {
    expect(() => validateStandingPartyScenarioConfig(DEFAULT_STANDING_PARTY_SCENARIO_CONFIG)).not.toThrow();
    expect(() =>
      validateStandingPartyScenarioConfig({
        ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
        venueAnchors: withAnchors([{ ...MVP_FOOD_ANCHOR, y: -1 }]),
      }),
    ).toThrow(/venueAnchors:/);
  });
});
