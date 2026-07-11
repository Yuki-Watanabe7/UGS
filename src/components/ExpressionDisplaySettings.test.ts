import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExpressionDisplaySettings } from "./ExpressionDisplaySettings";
import { DEFAULT_EXPRESSION_DISPLAY_SETTINGS, type ExpressionDisplaySettingsState } from "./expressionDisplayFilter";

function render(settings: ExpressionDisplaySettingsState) {
  return renderToStaticMarkup(
    createElement(ExpressionDisplaySettings, { settings, onSettingsChange: () => {} }),
  );
}

describe("ExpressionDisplaySettings", () => {
  it("renders the non-intervention note and an enabled checkbox by default", () => {
    const html = render(DEFAULT_EXPRESSION_DISPLAY_SETTINGS);
    expect(html).toContain("結果は変わりません");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked=\"\"");
  });

  it("shows target and density selects while enabled", () => {
    const html = render(DEFAULT_EXPRESSION_DISPLAY_SETTINGS);
    expect(html).toContain("observerJoinerのみ");
    expect(html).toContain("重要イベントのみ");
    expect(html).toContain("少なめ");
    expect(html).toContain("多め");
  });

  it("hides the target/density selects and shows an unchecked checkbox when disabled", () => {
    const html = render({ ...DEFAULT_EXPRESSION_DISPLAY_SETTINGS, enabled: false });
    expect(html).not.toContain("observerJoinerのみ");
    expect(html).not.toContain("表示密度");
    expect(html).not.toContain("checked=\"\"");
  });

  it("marks the current target and density as the selected option", () => {
    const html = render({ enabled: true, target: "observerJoiner", density: "few" });
    expect(html).toContain('value="observerJoiner" selected=""');
    expect(html).toContain('value="few" selected=""');
  });

  it("uses only native form controls (checkbox/select wrapped in label) so keyboard and touch operate them without extra script", () => {
    // Issue #67「表示設定をキーボードおよびタッチ相当操作で変更できる」: <input>/<select>はブラウザ標準で
    // Tab/Space/Enter/矢印キー操作とタッチタップの両方に対応するため、独自のdiv+onClickの
    // 疑似ボタン(キーボード操作に追加のJSが必要になりがちなパターン)を使っていないことを保証する。
    const html = render({ ...DEFAULT_EXPRESSION_DISPLAY_SETTINGS, target: "observerJoiner", density: "many" });

    expect(html).toContain("<label");
    expect((html.match(/<input /g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect((html.match(/<select/g) ?? []).length).toBe(2);
    expect(html).not.toContain("onClick");
    expect(html).not.toMatch(/role="button"/);
    expect(html).not.toMatch(/tabIndex/i);
  });
});
