import {
  getRenderableScenarioIntroSections,
  type ScenarioIntroSection,
} from "./scenarioIntroductionContent";

type Props = {
  summary: string;
  details?: readonly ScenarioIntroSection[];
};

/**
 * シナリオ共通の概要・詳細説明。native `<details>`は閉じた状態から始まり、
 * keyboard操作と展開状態のアクセシビリティセマンティクスをブラウザ標準で提供する。
 */
export function ScenarioIntroduction({ summary, details }: Props) {
  const sections = getRenderableScenarioIntroSections(details);

  return (
    <section className="scenario-introduction" aria-label="シミュレーターの概要">
      <p className="scenario-introduction-summary">{summary}</p>
      {sections.length > 0 && (
        <details className="scenario-introduction-details">
          <summary>仕組みと見方</summary>
          <div className="scenario-introduction-detail-content">
            {sections.map((section) => {
              const headingId = `scenario-introduction-${section.id}`;
              return (
                <section className="scenario-introduction-section" key={section.id} aria-labelledby={headingId}>
                  <h2 id={headingId}>{section.title}</h2>
                  <p>{section.body}</p>
                </section>
              );
            })}
          </div>
        </details>
      )}
    </section>
  );
}
