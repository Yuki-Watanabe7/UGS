import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Router, { HomePage } from "./Router";

describe("Router", () => {
  it("shows links to both simulation categories on the home page", () => {
    const html = renderToStaticMarkup(createElement(HomePage));

    expect(html).toContain("二次会のグループ形成");
    expect(html).toContain("学校のペア・班作り");
    expect(html).toContain("simulate/after-party");
    expect(html).toContain("simulate/classroom");
  });

  it("opens the after-party URL with only after-party presets", () => {
    const html = renderToStaticMarkup(
      createElement(Router, { initialPathname: "/simulate/after-party" }),
    );

    expect(html).toContain("二次会のグループ形成シミュレーション");
    expect(html).toContain("自然に二次会が成立する場");
    expect(html).not.toContain("教室で自由にペアを作る場");
  });

  it("opens the classroom URL with classroom-pair selected and no after-party presets", () => {
    const html = renderToStaticMarkup(
      createElement(Router, { initialPathname: "/simulate/classroom" }),
    );

    expect(html).toContain("学校のペア・班作りシミュレーション");
    expect(html).toContain("教室で自由にペアを作る場");
    expect(html).toContain("教室で自由に3〜4人班を作る場");
    expect(html).toContain("自由にペア・班を作るよう促した教室");
    expect(html).not.toContain("自然に二次会が成立する場");
  });
});
