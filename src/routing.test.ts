import { describe, expect, it } from "vitest";
import { appPathname, routeFromPathname } from "./routing";

describe("application routing", () => {
  it("resolves the home and all simulation URLs below the configured base", () => {
    expect(routeFromPathname("/UGS/", "/UGS/")).toEqual({ page: "home" });
    expect(routeFromPathname("/UGS/simulate/after-party", "/UGS/")).toEqual({
      page: "simulation",
      scenarioId: "after-party",
    });
    expect(routeFromPathname("/UGS/simulate/classroom", "/UGS/")).toEqual({
      page: "simulation",
      scenarioId: "classroom",
    });
    expect(routeFromPathname("/UGS/simulate/standing-party", "/UGS/")).toEqual({
      page: "simulation",
      scenarioId: "standing-party",
    });
  });

  it("falls back to not found for unknown or out-of-base URLs", () => {
    expect(routeFromPathname("/UGS/unknown", "/UGS/")).toEqual({ page: "not-found" });
    expect(routeFromPathname("/simulate/classroom", "/UGS/")).toEqual({ page: "not-found" });
  });

  it("builds base-aware internal URLs", () => {
    expect(appPathname("/", "/UGS/")).toBe("/UGS/");
    expect(appPathname("/simulate/classroom", "/UGS/")).toBe("/UGS/simulate/classroom");
    expect(appPathname("/simulate/after-party", "/")).toBe("/simulate/after-party");
    expect(appPathname("/simulate/standing-party", "/UGS/")).toBe("/UGS/simulate/standing-party");
  });
});
