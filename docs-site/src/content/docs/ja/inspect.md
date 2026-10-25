---
title: 落とした物を Windmill で調べる
description: クロールの規則が辿った・撮るだけにした・落としたリンクを、capture-ledger の記録から Windmill で引く 2 本の script
---

クロールの規則は、リンクを 1 本ずつ「撮って辿る」「撮るだけ」「落とす」に分ける。決めるのは
**capture-ledger** で、flow ではない。だから Windmill の run には、撮ったページと、`plan_level` が
robots.txt で見送ったページは出ても、**規則で落としたリンクは出ない**。capture-ledger は段ごとに
それを残しており（`crawl_decisions`）、この repo の 2 本の script が Windmill の中から読む。

どちらもクロールの通り道には居ない。知りたいときに Windmill の画面（か API）から走らせる。何も書かない。

| script                    | 引数                                       | 答えること                                           |
| ------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| `f/waggle/inspect_crawl`  | `crawl` —— クロールの id か、その前の 8 字 | このクロールの規則は何をしたか                       |
| `f/waggle/inspect_domain` | `domain`・`days`（90）・`action`（`skip`） | このドメインを落としたのは、どのクロールのどの規則か |

## inspect_crawl

クロール（起点・段と枚数の上限・どう終わったか）を出し、続けて:

- **規則ごと**に、段を跨いで足した別々の URL の数。1 度も当たらなかった規則には「当たっていない」と
  印を付ける —— 当たらない規則は、たいてい書いた人の意図と違うことを言っている。
- **落とした物**をホスト名ごとに: 規則で落としたリンク、どの規則にも当たらなかったリンク（これも
  落とす）、robots.txt のために取らなかったページ。

前の 8 字は dashboard と Windmill の run の画面に出る形。script は capture-ledger のクロールの一覧の
新しいページから引き当て、2 本が同じ字で始まれば、どちらも選ばずに両方を名指して止まる。

## inspect_domain

`domain` は小文字のホスト名で、その下のサブドメインにもラベルの境目で当たる ——
`ads.example.com` は `x.ads.example.com` を見つけ、`badads.example.com` は見つけない。表は新しい
クロールから、どのクロールの・どの規則（どれにも当たらない、も）が・別々の URL を何本、を並べる。
クロールは前の 8 字で出るので、そのまま `inspect_crawl` に渡せる。

`action` で問いを替える: `capture` は外へ出て撮るだけにした先、`follow` は辿った先。

## 30 日

Windmill のオープンソース版は run の中身を最長 30 日で消す。この 2 本は capture-ledger を読むだけで、
その行はクロールがある限り残るので、消えた run は script を走らせ直せば答えが出る。

## 結果の形

どちらも Windmill の rich display の `render_all`（Markdown の見出しと `table-row-object` の表）を
返すので、run の画面には JSON ではなく表が出る。script は `windmill/f/waggle/inspect_crawl.ts` と
`windmill/f/waggle/inspect_domain.ts`。
