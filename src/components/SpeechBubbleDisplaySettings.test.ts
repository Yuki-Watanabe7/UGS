import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SpeechBubbleDisplaySettings } from "./SpeechBubbleDisplaySettings";
import { DEFAULT_SPEECH_BUBBLE_DISPLAY_SETTINGS, type SpeechBubbleDisplaySettingsState } from "./speechBubbleDisplayFilter";

function render(settings: SpeechBubbleDisplaySettingsState) {
  return renderToStaticMarkup(
    createElement(SpeechBubbleDisplaySettings, { settings, onSettingsChange: () => {} }),
  );
}

describe("SpeechBubbleDisplaySettings", () => {
  it("renders the non-intervention note and a checkbox reflecting the enabled state", () => {
    const html = render(DEFAULT_SPEECH_BUBBLE_DISPLAY_SETTINGS);
    expect(html).toContain("結果は変わりません");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
  });

  it("renders an unchecked checkbox when disabled", () => {
    const html = render({ enabled: false });
    expect(html).not.toContain('checked=""');
  });

  it("uses a native checkbox wrapped in a label so keyboard and touch operate it without extra script", () => {
    const html = render(DEFAULT_SPEECH_BUBBLE_DISPLAY_SETTINGS);
    expect(html).toContain("<label");
    expect(html).not.toContain("onClick");
    expect(html).not.toMatch(/role="button"/);
  });
});
