import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    css: true,
    // Issue #203: standingPartyの1000tick級ロングラン・複数preset×複数seedのシミュレーション
    // テストが増え、フルスイート実行時のCPU競合下ではvitestの既定5000msを超えることがある
    // (個々のテストは正しく、実行環境の負荷だけが原因)。既存の重いテストが個別に指定していた
    // 30000msに近い値をグローバル既定へ引き上げ、フルスイート実行時のflakinessを避ける。
    testTimeout: 20000,
  },
});
