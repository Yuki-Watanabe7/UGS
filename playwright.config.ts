import { defineConfig, devices } from "@playwright/test";

/**
 * Issue #203 (Phase 3, 検証範囲11節): これまでリポジトリに存在しなかったE2E基盤。
 * `.claude/skills/verify/SKILL.md`が明記するとおり、baseパスは `/UGS/`(`vite.config.ts`)。
 * `npm run dev`のViteサーバーをCI/ローカルの両方で自動起動する(`webServer`)。
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    // 既定の5173番はローカル環境で他プロジェクトのdevサーバーと衝突しうるため、E2E専用ポートを使う
    // (`reuseExistingServer`で無関係な既存プロセスを誤って使い回さないようにする狙いも兼ねる)。
    baseURL: "http://localhost:5174/UGS/",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 5174 --strictPort",
    url: "http://localhost:5174/UGS/",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
  projects: [
    {
      name: "desktop-chromium",
      testMatch: /\.desktop\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "iphone-chromium",
      // `.claude/skills/verify/SKILL.md`と同じ既定(iPhone 14相当、390x664、タッチ操作あり)。
      testMatch: /\.mobile\.spec\.ts$/,
      use: { ...devices["iPhone 14"] },
    },
  ],
});
