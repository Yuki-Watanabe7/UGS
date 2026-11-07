# public リポジトリと GitHub Pages での公開範囲

- **決定**: このリポジトリは public で、GitHub Pages から誰でも使える形で配布している。
  - 2026-07-08、[#53](https://github.com/Yuki-Watanabe7/UGS/issues/53) で、iPhone から使えるように GitHub Pages で公開すると決めた。GitHub Free では、Pages を使えるのは public repo だけである。
  - 2026-11-07、所有者（Yuki-Watanabe7）が二つのことを確認した。一つは、repo を public のままにすること。もう一つは、アイコンなどの画像がすべて自作（AI 生成）であること。
- **関連**: [#275](https://github.com/Yuki-Watanabe7/UGS/issues/275)（この記録）。#53 で抜けていた項目、つまり repo の可視性、画像の出どころ、止め方を補う。
- **方針**: [Artifact Publication Policy v1](https://github.com/Yuki-Watanabe7/portfolio-control-plane/blob/main/docs/governance/artifact-publication-policy.md) の §4 が求める判断記録。項目は方針に合わせている。

## 公開しているもの

| 公開物 | 公開先 | 読める人 | 保持 |
| --- | --- | --- | --- |
| ソースと全ブランチの履歴、Issue / PR とコメント | このリポジトリ | 誰でも | 履歴は残り続ける |
| アプリのビルド（`dist`） | GitHub Pages <https://yuki-watanabe7.github.io/UGS/> | 誰でも | 次の配布で置き換わる |
| Playwright のレポート（アプリのスクリーンショットを含む） | Actions artifact `playwright-report` | 一覧は誰でも見られる。ダウンロードは GitHub にサインインした人ならできる | 14 日 |
| Actions のログ | Actions | 誰でも | 90 日 |

中身は、自作のコードと、架空の参加者によるシミュレーションだけである。画像は次の5点だけで、所有者が自作（AI 生成）したもの。

- `public/favicon.svg`
- `public/apple-touch-icon.png`
- `public/icons/icon-192.png`
- `public/icons/icon-512.png`
- `public/icons/icon-maskable-512.png`

外部のフォントや CDN からは何も読み込まない。Release とパッケージは出していない。

## public にする理由

開発環境のない iPhone を含め、任意のブラウザからインストールなしで使うためである（#53）。GitHub Free で Pages を使うには、repo が public である必要がある。

## 素材の出典とライセンス

第三者のデータ・素材は使っていない。

LICENSE ファイルはない。閲覧はできるが、利用の許諾は与えていない状態である。

## 秘密情報と個人データの確認（2026-11-07）

| 対象 | 結果 |
| --- | --- |
| 全ブランチの履歴（188 commit、過去に存在したパス 344） | API キー、トークン、秘密鍵、AWS の識別子、パスワードの代入らしい文字列はない。メールアドレスもない。IP アドレスは、説明用の例示 `192.168.1.23` と `0.0.0.0` だけ。`.env`、DB、CSV、PDF は一度も commit されていない。画像は上の5点だけ。 |
| commit のメールアドレス | 所有者、`noreply@anthropic.com`、`cursoragent@cursor.com`。所有者のものは、DME など他の public repo で既に公開されている。 |
| Issue / PR 274 件、コメント 196 件 | 書いたのは所有者と `claude[bot]` だけ。秘密情報らしい文字列とメールアドレスはない。PR #56 の本文には、実機確認のときに使った家庭内 LAN の private アドレスが1件ある。private 範囲のアドレスなので、インターネットからは到達できない。 |
| Actions | artifact は `playwright-report` だけ。Release は 0 件。secrets は `CLAUDE_CODE_OAUTH_TOKEN` だけで、値はログ上で伏せられる。`claude.yml` は `show_full_output` を使っておらず、既定の `false` のままである。 |

## 配布経路と権限

| workflow | 起動条件と権限 |
| --- | --- |
| `pages.yml` | `main` への push と手動実行で動く。lint・test・build の後に、`dist` を Pages へ配布する。権限は `contents: read`、`pages: write`、`id-token: write`（OIDC）。environment `github-pages` は `main` からの配布だけを許す（required reviewer はない）。`main` へのマージが、この記録の範囲での配布の承認にあたる。 |
| `ci.yml` | `main`・`develop` への push と、`main` への PR で動く。E2E のレポートを artifact に上げる。secrets は使わない。fork からの PR には secrets が渡らない。 |
| `claude.yml`、`claude-code-review.yml` | `@claude` を含む Issue、コメント、PR、レビューで起動し、`CLAUDE_CODE_OAUTH_TOKEN` を使う。#275 で、`author_association` が OWNER / MEMBER / COLLABORATOR のときだけ動くようにした。claude-code-action 自体も、書き込み権限のない人の依頼を拒否する。 |

各配布は、`pages.yml` の実行と、その commit に対応する（[deployments の `github-pages`](https://github.com/Yuki-Watanabe7/UGS/deployments)）。

## 止め方と、取り消せないこと

- **サイトを止める**:
  1. Settings → Pages で **Unpublish site** を選ぶ。
  2. 次の push で再配布されないよう、`gh workflow disable pages.yml -R Yuki-Watanabe7/UGS` で workflow を止める。
  3. 公開 URL が開けないことを確かめる。
- **repo を private に戻す**: `gh repo edit Yuki-Watanabe7/UGS --visibility private --accept-visibility-change-consequences` を実行する。GitHub Free では、これで Pages も止まる。
- **取り消せないこと**:
  - 公開中に取得された clone、fork、ダウンロード済みの artifact は回収できない。
  - private に戻しても、既存の public fork は残る。2026-11-07 時点で fork は 0。
  - ホーム画面に追加した端末では、Service Worker（`public/sw.js`）がキャッシュしたアプリが、サイトを止めた後も残りうる。

## 見直し

2027-11-07 までに見直す。次のどれかが起きたときも見直す。

- 第三者の素材を入れるとき。画像、フォント、音声、実在の人物やデータなど。
- 個人データを扱う機能、または秘密情報を必要とする機能や workflow を足すとき。
- Pages 以外の公開先を加えるとき。Release やパッケージなど。
- LICENSE を選ぶとき、collaborator を加えるとき、GitHub のプランが変わるとき。
