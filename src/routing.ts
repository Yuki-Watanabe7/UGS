import type { ScenarioCategoryId } from "./scenarios";

export type AppRoute =
  | { page: "home" }
  | { page: "simulation"; scenarioId: ScenarioCategoryId }
  | { page: "not-found" };

function normalizeBasePath(baseUrl: string): string {
  const withLeadingSlash = baseUrl.startsWith("/") ? baseUrl : `/${baseUrl}`;
  return withLeadingSlash === "/" ? "" : withLeadingSlash.replace(/\/+$/, "");
}

export function appPathname(path: string, baseUrl = import.meta.env.BASE_URL): string {
  const basePath = normalizeBasePath(baseUrl);
  if (path === "/") return `${basePath}/`;
  return `${basePath}/${path.replace(/^\/+|\/+$/g, "")}`;
}

export function routeFromPathname(
  pathname: string,
  baseUrl = import.meta.env.BASE_URL,
): AppRoute {
  const basePath = normalizeBasePath(baseUrl);
  let routePath = pathname.replace(/\/+$/, "") || "/";

  if (basePath) {
    if (routePath === basePath) {
      routePath = "/";
    } else if (routePath.startsWith(`${basePath}/`)) {
      routePath = routePath.slice(basePath.length) || "/";
    } else {
      return { page: "not-found" };
    }
  }

  switch (routePath) {
    case "/":
      return { page: "home" };
    case "/simulate/after-party":
      return { page: "simulation", scenarioId: "after-party" };
    case "/simulate/classroom":
      return { page: "simulation", scenarioId: "classroom" };
    case "/simulate/standing-party":
      return { page: "simulation", scenarioId: "standing-party" };
    default:
      return { page: "not-found" };
  }
}
