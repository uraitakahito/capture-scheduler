---
title: capture-scheduler
description: capture-ledger のクロールを Windmill の上で回す —— 1 段ずつ BrowserHive に撮らせる
---

capture-scheduler は [capture-ledger](https://uraitakahito.github.io/capture-ledger/) のクロールを
**[Windmill](https://www.windmill.dev/) の上で回す**。capture-ledger がクロールを 1 段ずつ webhook で
渡してくる。flow はその段の URL をホストで束ね、robots.txt を確かめ、BrowserHive に HTTP で撮らせて、
見つけたものを返す。**BrowserHive を呼ぶのはこの repo の flow だけ** —— capture-ledger はもう
BrowserHive と話さない。

いつ始めるかも capture-ledger が決める。定期実行の時計は capture-ledger の API プロセスの中に在り、
この repo に schedule は無い。

## 境界

|                                |                                                                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **capture-ledger が決める**    | 何を（起点の URL）・いつ（予定）・どこまで（深さ・規則・上限）・どの間隔で（方針の値）・どの形式で。何が起きたかを記録し、次の段があるかを決める                                  |
| **capture-scheduler が決める** | 1 段をどう回すか（ホストで束ねる・並列の数を BrowserHive のエンドポイントの数で頭打ちにする・ホスト内は逐次で完了の後に間隔をあける・robots.txt・空いているエンドポイントを選ぶ） |

だから、この repo に **URL は 1 つも書いていない**。URL も方針の値も、capture-ledger から届く。

この切り分けは守る価値がある。「何を取るか」も知っている実行側は、
おかしなものが取り込まれたときに**見る場所が 2 つ**になる —— そして 2 つは、
いつか食い違う。例外は robots.txt で、禁じられたページを外すのは flow だが、外したページは
理由つきで capture-ledger に報告され、記録に残る。

## 撮る —— 1 段ずつ

capture-ledger が **1 段ずつ**渡し、capture-scheduler は見つけたものを返す。次の段があるかは
capture-ledger が決める。[リンクを辿る](/crawl/) を見ること。

面白い制約が集まっているのはこちら —— **他人のサーバを繰り返し叩く**のがこの道だから。

## 始める —— 時計は capture-ledger の中

この repo は自分ではクロールを始めない。予定は capture-ledger の表 `crawl_schedules` の行で、その
API プロセスの中の周回が、期限の来た予定からクロールを始める。予定を作るのは
[capture-workbench](https://github.com/uraitakahito/capture-workbench) の「新しいクロール」の画面か
`POST /api/schedules` で、操作はタブ「定期実行」から。capture-ledger の
[定期実行](https://uraitakahito.github.io/capture-ledger/ja/schedules/) を見ること。

定期の回も、ほかのクロールと同じ形でこの repo に届く —— 同じ webhook、同じ flow、同じホストへの間隔。

手で 1 本撮るのは、「新しいクロール」の画面か `pnpm run smoke`。

## どこに何があるか

| したいこと                           | ページ                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| 初めて立ち上げる                     | [クイックスタート](/quickstart/)                                                         |
| クロールの flow を理解する           | [リンクを辿る](/crawl/)                                                                  |
| クロールの時刻を変える               | [capture-ledger の定期実行](https://uraitakahito.github.io/capture-ledger/ja/schedules/) |
| Windmill CE が黙って飛ばすことを知る | [Windmill CE](/windmill-ce/)                                                             |
| 試験を走らせる・足す                 | [試験](/testing/)                                                                        |
| 変更を Windmill に戻す               | [開発](/development/)                                                                    |
