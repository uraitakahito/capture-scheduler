/**
 * クロール 1 本で、規則がリンクをどう決めたかを読む。
 *
 * **クロールの通り道には居ない。** Windmill の画面で引数を書いて走らせる調べ物の道具で、何も書かない。
 *
 * 判断は台帳が決め、台帳に残している (`report_level.ts` の冒頭、capture-ledger の `crawl_decisions`)。
 * ここは台帳の `GET /api/crawls/:id/decisions` を引き、規則ごとの数と、落とした物を表に描くだけ
 * (Windmill の rich display の `render_all`)。run の中身は最長 30 日で消えるが、台帳の行はクロールが
 * ある限り残るので、いつでも走らせ直せる。
 */
import * as wmill from "windmill-client";

type Action = "follow" | "capture" | "skip";

/** 規則 1 本。鍵が 1 つの object (`{ "skip": "ads.example.com" }`)。 */
export type Rule = Partial<Record<Action, string>>;

/** 台帳の `GET /api/crawls/:id` のうち、見出しに要る欄。 */
export interface CrawlDetail {
  crawlId: string;
  seeds: string[];
  rules: Rule[];
  state: string;
  stopReason: string | null;
  maxDepth: number;
  maxPages: number;
}

/** 台帳の `GET /api/crawls/:id/decisions` の答え。 */
export interface Decisions {
  rules: Rule[];
  decisions: {
    depth: number;
    rule: number;
    action: Action;
    hostname: string;
    links: number;
    samples: string[];
  }[];
  robots: { hostname: string; pages: number; samples: string[] }[];
}

/** 一覧の 1 行のうち、引き当てに要る欄。 */
interface Listed {
  crawlId: string;
  startedAt: string;
  seeds: string[];
}

export type Getter = <T>(path: string) => Promise<T>;

/** 画面の言い方 (dashboard の規則の表と同じ)。 */
export const ACTION_LABEL: Record<Action, string> = {
  follow: "撮って辿る",
  capture: "撮るだけ",
  skip: "落とす",
};

/** 前の字で探すとき、台帳の一覧を何ページまで読むか (新しい順)。 */
export const LIST_PAGES = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * クロールの id を引き当てる。全部の id でも、前の字 (dashboard と run の画面に出る 8 字) でもよい。
 *
 * 前の字なら一覧を新しい順に読み、当たる物を集める。**2 本以上当たれば、どれも選ばずに止める** ——
 * 違うクロールを読んで、それと気づかないのが最も悪い。
 */
export const resolveCrawl = async (given: string, get: Getter): Promise<string> => {
  const text = given.trim().toLowerCase();
  if (UUID.test(text)) return text;
  if (!/^[0-9a-f][0-9a-f-]{3,}$/.test(text)) {
    throw new Error(`クロールの id か、その前の字（8 字）を書いてください: ${given}`);
  }

  const found: Listed[] = [];
  let before: string | undefined;
  for (let page = 0; page < LIST_PAGES; page++) {
    const query = before === undefined ? "" : `?before=${encodeURIComponent(before)}`;
    const { crawls } = await get<{ crawls: Listed[] }>(`/api/crawls${query}`);
    found.push(...crawls.filter((crawl) => crawl.crawlId.startsWith(text)));
    if (found.length > 1) break;
    const last = crawls.at(-1);
    if (last === undefined) break;
    before = last.startedAt;
  }

  const [only, ...others] = found;
  if (only === undefined) {
    throw new Error(
      `${text} で始まるクロールが、一覧の新しい ${String(LIST_PAGES)} ページの中にありません。id を全部書いてください`,
    );
  }
  if (others.length > 0) {
    const listed = found
      .map((crawl) => `${crawl.crawlId}（${crawl.startedAt}・${crawl.seeds.join(" ")}）`)
      .join(" / ");
    throw new Error(
      `${text} で始まるクロールが ${String(found.length)} 本あります。id を全部書いてください: ${listed}`,
    );
  }
  return only.crawlId;
};

const ruleText = (rule: Rule | undefined): { action: Action; pattern: string } | undefined => {
  const entry = rule === undefined ? undefined : Object.entries(rule)[0];
  return entry === undefined ? undefined : { action: entry[0] as Action, pattern: entry[1] };
};

/** Windmill の rich display の形。`render_all` の要素を上から並べて描く。 */
export interface Rendered {
  render_all: Record<string, unknown>[];
}

/**
 * 見出し・規則ごとの数・落とした物の 3 つを描く。純粋な関数 (試験はここを呼ぶ)。
 *
 * 規則ごとの数は、段ごとの別々の URL を足した物。**0 回の規則に印を付ける** —— 当たらない規則は、
 * 書いた人の意図が外れている合図。落とした物は、規則で落とした物と robots.txt で取らなかったページを
 * ホスト名ごとに並べる。
 */
export const renderCrawl = (detail: CrawlDetail, got: Decisions): Rendered => {
  const short = detail.crawlId.slice(0, 8);
  const stopped = detail.stopReason === null ? "" : `・${detail.stopReason}`;
  const heading =
    `**クロール ${short}**（起点 ${detail.seeds.join(" ")}・${String(detail.maxDepth)} 段・` +
    `${String(detail.maxPages)} 枚まで）—— ${detail.state}${stopped}`;

  const byRule = new Map<number, number>();
  for (const row of got.decisions) byRule.set(row.rule, (byRule.get(row.rule) ?? 0) + row.links);

  const ruleRows: Record<string, string | number>[] = got.rules.map((rule, i) => {
    const text = ruleText(rule);
    const links = byRule.get(i + 1) ?? 0;
    return {
      規則: `${String(i + 1)}. ${text === undefined ? "?" : ACTION_LABEL[text.action]}`,
      当てる物: text?.pattern ?? "",
      "URL の数": links,
      印: links === 0 ? "当たっていない" : "",
    };
  });
  const unmatched = byRule.get(0);
  if (unmatched !== undefined) {
    ruleRows.push({
      規則: "どれにも当たらない（落とす）",
      当てる物: "",
      "URL の数": unmatched,
      印: "",
    });
  }

  const dropped: Record<string, string | number>[] = [
    ...got.decisions
      .filter((row) => row.action === "skip")
      .map((row) => ({
        なぜ: row.rule === 0 ? "どれにも当たらない" : `規則 ${String(row.rule)}`,
        ホスト名: row.hostname,
        段: row.depth,
        "URL の数": row.links,
        例: row.samples[0] ?? "",
      })),
    ...got.robots.map((row) => ({
      なぜ: "robots.txt",
      ホスト名: row.hostname,
      段: "",
      "URL の数": row.pages,
      例: row.samples[0] ?? "",
    })),
  ];

  return {
    render_all: [
      { markdown: heading },
      { markdown: "#### 規則ごと（段ごとの別々の URL を足した数。0 回の規則に印）" },
      { "table-row-object": [["規則", "当てる物", "URL の数", "印"], ...ruleRows] },
      { markdown: "#### 落とした物（規則と robots.txt・ホスト名ごと）" },
      dropped.length === 0
        ? { markdown: "落とした物はありません。" }
        : { "table-row-object": [["なぜ", "ホスト名", "段", "URL の数", "例"], ...dropped] },
    ],
  };
};

/** 台帳を引く関数。設定は flow の段と同じ変数から読む (schema の既定値は UI からの実行にしか埋まらない)。 */
const ledger = async (): Promise<Getter> => {
  const base = await wmill.getVariable("u/admin/waggle_api_url");
  const token = await wmill.getVariable("u/admin/waggle_token");
  return async <T>(path: string): Promise<T> => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`GET ${path} → ${String(res.status)} ${(await res.text()).slice(0, 300)}`);
    }
    return (await res.json()) as T;
  };
};

export async function main(crawl: string): Promise<Rendered> {
  const get = await ledger();
  const crawlId = await resolveCrawl(crawl, get);
  const detail = await get<CrawlDetail>(`/api/crawls/${crawlId}`);
  const got = await get<Decisions>(`/api/crawls/${crawlId}/decisions`);
  return renderCrawl(detail, got);
}
