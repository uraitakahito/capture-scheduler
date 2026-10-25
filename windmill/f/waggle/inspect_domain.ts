/**
 * あるドメイン (とその下) を、どのクロールがどの規則で落としたか (撮るだけにしたか・辿ったか) を引く。
 *
 * **クロールの通り道には居ない。** Windmill の画面で引数を書いて走らせる調べ物の道具で、何も書かない。
 *
 * 判断は台帳が決め、台帳に残している (`report_level.ts` の冒頭、capture-ledger の `crawl_decisions`)。
 * ここは台帳の `GET /api/decisions` を引き、クロールを跨いで表に描くだけ。run の中身は最長 30 日で
 * 消えるが、台帳の行はクロールがある限り残るので、`days` を伸ばして走らせ直せる。
 */
import * as wmill from "windmill-client";

type Action = "follow" | "capture" | "skip";

/** 台帳の `GET /api/decisions` の答え。 */
export interface DomainAnswer {
  decisions: {
    crawlId: string;
    startedAt: string;
    seeds: string[];
    rule: number;
    action: Action;
    /** 当たった規則の当てる物。どれにも当たらない (規則 0) なら null。 */
    pattern: string | null;
    hostname: string;
    links: number;
  }[];
  /** 台帳が行の上限で切ったか。 */
  truncated: boolean;
}

/** 見出しの言い方。 */
export const VERB: Record<Action, string> = {
  skip: "落とした",
  capture: "撮るだけにした",
  follow: "撮って辿った",
};

/** Windmill の rich display の形。`render_all` の要素を上から並べて描く。 */
export interface Rendered {
  render_all: Record<string, unknown>[];
}

/**
 * 見出しと、クロール × 規則 × ホスト名の表を描く。純粋な関数 (試験はここを呼ぶ)。
 *
 * クロールは前の 8 字で出す —— dashboard と run の画面に出る形で、`f/waggle/inspect_crawl` にも
 * そのまま渡せる。
 */
export const renderDomain = (
  domain: string,
  days: number,
  action: Action,
  got: DomainAnswer,
): Rendered => {
  const crawls = new Set(got.decisions.map((row) => row.crawlId)).size;
  const cut = got.truncated
    ? " —— 台帳が行の上限で切りました。days を短くして走らせ直してください"
    : "";
  const rows = got.decisions.map((row) => ({
    始めた: row.startedAt.slice(0, 16).replace("T", " "),
    クロール: row.crawlId.slice(0, 8),
    起点: row.seeds.join(" "),
    規則: row.rule === 0 ? "どれにも当たらない" : `${String(row.rule)}. ${row.pattern ?? ""}`,
    ホスト名: row.hostname,
    "URL の数": row.links,
  }));
  return {
    render_all: [
      {
        markdown: `**${domain}** とその下を${VERB[action]}クロール: ${String(crawls)} 本（${String(days)} 日のうち）${cut}`,
      },
      rows.length === 0
        ? { markdown: "ありません。" }
        : {
            "table-row-object": [
              ["始めた", "クロール", "起点", "規則", "ホスト名", "URL の数"],
              ...rows,
            ],
          },
    ],
  };
};

export async function main(domain: string, days = 90, action: Action = "skip"): Promise<Rendered> {
  // 設定は flow の段と同じ変数から読む (schema の既定値は UI からの実行にしか埋まらない)
  const base = await wmill.getVariable("u/admin/waggle_api_url");
  const token = await wmill.getVariable("u/admin/waggle_token");
  const path =
    `/api/decisions?domain=${encodeURIComponent(domain)}` +
    `&days=${String(days)}&action=${encodeURIComponent(action)}`;
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${String(res.status)} ${(await res.text()).slice(0, 300)}`);
  }
  return renderDomain(domain, days, action, (await res.json()) as DomainAnswer);
}
