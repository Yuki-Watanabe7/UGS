import { useEffect, useState } from "react";
import App from "./App";
import "./Router.css";
import { AppLink } from "./components/AppLink";
import { routeFromPathname } from "./routing";
import { getScenarioById, SCENARIOS } from "./scenarios";

type Props = {
  initialPathname?: string;
};

export function HomePage() {
  return (
    <main className="home-page">
      <section className="home-hero">
        <p className="home-eyebrow">UGS · Group formation simulator</p>
        <h1>人がグループを作る過程を、場面ごとに観察する</h1>
        <p>
          目的に合うシミュレーションを選んでください。シナリオごとに専用の設定と観察ポイントを用意しています。
        </p>
      </section>

      <section className="scenario-grid" aria-label="シミュレーション種別">
        {SCENARIOS.map((scenario, index) => (
          <AppLink key={scenario.id} to={scenario.routePath} className="scenario-card">
            <span className="scenario-card-number" aria-hidden="true">
              0{index + 1}
            </span>
            <h2>{scenario.homeTitle}</h2>
            <p>{scenario.homeDescription}</p>
            <dl>
              <div>
                <dt>主な観察対象</dt>
                <dd>{scenario.observationTargets}</dd>
              </div>
              <div>
                <dt>利用できるシナリオ</dt>
                <dd>{scenario.availableScenarios}</dd>
              </div>
            </dl>
            <span className="scenario-card-action">シミュレーションを開く →</span>
          </AppLink>
        ))}
      </section>
    </main>
  );
}

export function NotFoundPage() {
  return (
    <main className="not-found-page">
      <p className="home-eyebrow">404 · Page not found</p>
      <h1>このページは見つかりませんでした</h1>
      <p>URLを確認するか、シナリオ選択へ戻ってください。</p>
      <AppLink to="/" className="not-found-link">
        シナリオ選択へ戻る
      </AppLink>
    </main>
  );
}

function pageTitle(pathname: string): string {
  const route = routeFromPathname(pathname);
  if (route.page === "simulation") {
    return `${getScenarioById(route.scenarioId).pageTitle} | UGS`;
  }
  return route.page === "home" ? "UGS | グループ形成過程シミュレーター" : "ページが見つかりません | UGS";
}

export default function Router({ initialPathname }: Props) {
  const [pathname, setPathname] = useState(
    () => initialPathname ?? (typeof window === "undefined" ? import.meta.env.BASE_URL : window.location.pathname),
  );
  const route = routeFromPathname(pathname);

  useEffect(() => {
    if (initialPathname !== undefined) return;
    const handlePopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [initialPathname]);

  useEffect(() => {
    document.title = pageTitle(pathname);
  }, [pathname]);

  if (route.page === "home") return <HomePage />;
  if (route.page === "not-found") return <NotFoundPage />;

  const scenario = getScenarioById(route.scenarioId);
  return <App key={scenario.id} scenario={scenario} />;
}
