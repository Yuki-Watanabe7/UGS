export type ScenarioIntroSection = {
  id: string;
  title: string;
  body: string;
};

/**
 * `details`内で空のsectionを表示しない。scenario configは静的な値だが、表示層でも
 * 不完全な説明見出しだけが残らないようにしておく。
 */
export function getRenderableScenarioIntroSections(
  details: readonly ScenarioIntroSection[] | undefined,
): readonly ScenarioIntroSection[] {
  return (details ?? []).filter(
    (section) => section.id.trim() !== "" && section.title.trim() !== "" && section.body.trim() !== "",
  );
}
