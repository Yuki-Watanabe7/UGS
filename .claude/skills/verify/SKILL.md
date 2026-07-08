---
name: verify
description: UGSのUI変更をdevサーバー+Playwrightで実走確認する手順
---

# UGS verify recipe

## 起動

```bash
npm run dev   # http://localhost:5173/UGS/ (base pathが /UGS/ な点に注意)
```

## 駆動

- Playwrightはリポジトリにはない。scratchpad等に `npm i playwright` して使う
  (macOSローカルに `~/Library/Caches/ms-playwright` のchromiumキャッシュあり)。
- モバイル確認は `devices["iPhone 14"]`(390x664, hasTouch)、PC確認は 1440x900。
- レスポンシブのブレークポイントは 768px(スマホ)と 1100px(1カラム化)。
  768px以下ではJS側(`useIsMobile`)も分岐し、ヘッダー説明文と詳細パラメータが
  `<details>` になる。PC幅では `<details>` は存在しないこと。

## 確認する観点(モバイル)

- `document.documentElement.scrollWidth <= clientWidth`(横スクロールなし)
- 初期表示で `window.scrollY === 0` かつ `.canvas-panel` が視界内
  (EventLogの末尾追従がページ全体をスクロールさせる回帰に注意 — #54で修正済み。
  リスト自身の `scrollTop` を動かす実装であること)
- パネルの縦積み順: canvas → control → intervention → legend → inspector →
  summary → event-log → monte-carlo → 介入比較
- Start/Pause/Stepをタップしてtickが進むこと
- Monte Carlo実行後もレイアウトが崩れないこと

## 注意

- シミュレーション挙動そのものの検証(プリセット間の対比など)は CLAUDE.md の
  記載どおり複数seedで実走が必要。単一seedのスクリーンショットでは不十分。
