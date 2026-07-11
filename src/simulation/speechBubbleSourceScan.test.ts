import { describe, expect, it } from "vitest";

// 発言吹き出し表示に関わるソース一式を`?raw`で読み込み、Math.random等の非決定的APIに
// 依存していないことを静的に検証する(`expressionReproducibility.test.ts`と同じ方針)。
import activeSpeechBubblesSource from "./activeSpeechBubbles.ts?raw";
import speechBubbleFormatSource from "../components/speechBubbleFormat.ts?raw";
import speechBubbleSource from "../components/SpeechBubble.tsx?raw";
import speechBubbleDisplayFilterSource from "../components/speechBubbleDisplayFilter.ts?raw";
import speechBubbleDisplaySettingsSource from "../components/SpeechBubbleDisplaySettings.tsx?raw";
import useActiveSpeechBubblesSource from "../hooks/useActiveSpeechBubbles.ts?raw";

describe("発言吹き出し表示はMath.random等の非決定的APIに依存していない", () => {
  const SOURCES: [string, string][] = [
    ["simulation/activeSpeechBubbles.ts", activeSpeechBubblesSource],
    ["components/speechBubbleFormat.ts", speechBubbleFormatSource],
    ["components/SpeechBubble.tsx", speechBubbleSource],
    ["components/speechBubbleDisplayFilter.ts", speechBubbleDisplayFilterSource],
    ["components/SpeechBubbleDisplaySettings.tsx", speechBubbleDisplaySettingsSource],
    ["hooks/useActiveSpeechBubbles.ts", useActiveSpeechBubblesSource],
  ];

  const FORBIDDEN: [RegExp, string][] = [
    [/Math\.random\s*\(/, "Math.random()"],
    [/crypto\.getRandomValues/, "crypto.getRandomValues"],
    [/new Date\s*\(/, "new Date()"],
    [/Date\.now\s*\(/, "Date.now()"],
  ];

  it.each(SOURCES)("%sにMath.random/crypto.getRandomValues/new Date()/Date.now()呼び出しが存在しない", (_name, source) => {
    const offenders = FORBIDDEN.filter(([pattern]) => pattern.test(source)).map(([, label]) => label);
    expect(offenders).toEqual([]);
  });
});
