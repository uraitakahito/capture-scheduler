/**
 * smoke が、撮った 1 本が **索引に載り、検索に当たる** ところまでを読む (CAPTURE-53)。
 *
 * 台帳は段の報告の時点でクロールを succeeded にし、その後に flow の索引の段が走る。だから succeeded を
 * 見ただけでは、索引が載ったかは分からない —— smoke は段の run の終わりを待ち、索引の段の答え
 * (`pending・indexed・failed・pages`) を読み、撮った頁の語で台帳の検索を引いて、当たった時点を照らす。
 *
 * **当たるはずの時点は、その WACZ のページ一覧から決める。** BrowserHive v25.0.0 から、ページ一覧の
 * 1 行目は取り込んだ文書の行 (stage が無い) で、写しがあればその後に時点ごとの行が並ぶ。台帳
 * (capture-ledger v0.70.0 から) は、写しの行があれば写しの時点だけを索引に入れ、文書の行は入れない
 * (文書の行は after-behaviors の写しとほぼ同じ文なので、入れると同じ語が 1 本で 2 回当たる)。写しの行が
 * 無ければ、文書の行の 1 件 (`page`) を入れる。
 *
 * 入出力を持たない。訊くのは `smoke.ts`。
 */
import type { Reading } from "./read-crawl.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parse = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** smoke が既定で撮る、capture-fixtures の印付きの頁の名前 (`/marked/page/:name`)。 */
export const SMOKE_PAGE = "smoke";

/**
 * smoke が既定で撮る頁と、検索に使う語。
 *
 * capture-fixtures の印付きの頁は、題に `title-<名前>-<印>`、本文に `text-<名前>-<印>` を書く。**印を
 * 撮るたびに変える**ので、印で引けば、この回の archive にだけ当たる —— 前の回の取り込みが索引に
 * 残っていても混ざらない (検索は 1 回 50 件まで。同じ語の当たりが溜まると、この回が外れうる)。
 * 印は capture-fixtures の決まり (`^[a-z0-9-]{1,32}$`) に収め、`-` を含めない —— 台帳の解析器は `-` で
 * 語を切るので、`-` の無い 1 語にしておけば、印そのもので引ける。
 */
export const smokeTarget = (
  fixtures: string,
  now: number,
  random: string,
): { url: string; query: string } => {
  const tag = `smoke${now.toString(36)}${random.replace(/[^a-z0-9]/g, "")}`.slice(0, 32);
  return { url: `${fixtures}/marked/page/${SMOKE_PAGE}?tag=${tag}`, query: tag };
};

/** flow の段の job (`jobs_u/get/<id>`) から、索引の段 (flow.yaml の `id: index`) の job を探す。 */
export const indexJobOf = (job: unknown): string | undefined => {
  if (!isRecord(job)) return undefined;
  const flow = isRecord(job["flow_status"]) ? job["flow_status"] : {};
  const modules = Array.isArray(flow["modules"]) ? flow["modules"] : [];
  const index = modules.find(
    (m): m is Record<string, unknown> => isRecord(m) && m["id"] === "index",
  );
  return typeof index?.["job"] === "string" ? index["job"] : undefined;
};

/** 索引の段 (`index_level.ts`) が返した数。 */
export interface IndexOutcome {
  pending: number;
  indexed: number;
  failed: number;
  pages: number;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** 索引の段の job の `result`。形が違えば undefined (古い flow は `skipped` を返し、`failed` を持たない)。 */
export const readIndexOutcome = (job: unknown): IndexOutcome | undefined => {
  if (!isRecord(job) || !isRecord(job["result"])) return undefined;
  const { pending, indexed, failed, pages } = job["result"];
  if (!isCount(pending) || !isCount(indexed) || !isCount(failed) || !isCount(pages))
    return undefined;
  return { pending, indexed, failed, pages };
};

/** 索引の段の答えが、smoke を止めるか。止めなければ undefined。 */
export const readIndexStep = (outcome: IndexOutcome | undefined): Reading | undefined => {
  if (outcome === undefined) {
    return {
      evidence: "索引の段の答えが読めない (run に index の段が無いか、答えに failed が無い)",
      fix: "Windmill の flow が古い → pnpm run windmill:push",
    };
  }
  if (outcome.failed > 0) {
    return {
      evidence: `索引の段: 待っていたアーカイブ ${String(outcome.pending)} 本のうち ${String(outcome.failed)} 本が載らなかった`,
      fix: "capture-ledger の API のログの「could not index this archive」を見て直し、載せ直す → cd ../capture-ledger && pnpm run search:reindex",
    };
  }
  if (outcome.indexed < 1) {
    return {
      evidence: `索引の段が載せたアーカイブは 0 本 (待っていた ${String(outcome.pending)} 本)`,
      fix: "この回の archive が台帳に載る前に索引の段が走った —— run を開いて report と index の段の log を見る",
    };
  }
  return undefined;
};

/**
 * 索引の段が落ちたときの文 (`index_level.ts` が投げる文) を、直し方に当てる。当てられなければ undefined
 * (呼ぶ側が段の失敗の読み分け `readStepFailure` に回す)。
 */
export const readIndexFailure = (message: string): string | undefined => {
  if (/\/index → 503\b/.test(message)) {
    return "capture-ledger の OpenSearch が答えない → cd ../capture-ledger && pnpm run dev:up --from search";
  }
  if (/索引に入らなかったアーカイブ/.test(message)) {
    return "capture-ledger の API のログの「could not index this archive」を見て直し、載せ直す → cd ../capture-ledger && pnpm run search:reindex";
  }
  if (/\/index → 404\b/.test(message)) {
    return (
      "索引の口が 404 —— flow のトークンの名前に、その組織のクロールの許可が無いか、capture-ledger が古い " +
      "(pnpm run doctor の can_submit と search route)"
    );
  }
  return undefined;
};

/**
 * WACZ の `pages/pages.jsonl` から、索引に載るはずの時点。写しの行 (stage を持つ行) があればその時点を
 * 一覧の順に、無ければ文書の行の 1 件 (`page`)。見出しの行 (url を持たない) は数えない。
 */
export const expectedStages = (pagesJsonl: string): string[] => {
  const rows = pagesJsonl
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map(parse)
    .filter(
      (row): row is Record<string, unknown> => isRecord(row) && typeof row["url"] === "string",
    );
  const staged = rows
    .map((row) => row["stage"])
    .filter((stage): stage is string => typeof stage === "string" && stage !== "");
  return staged.length > 0 ? staged : ["page"];
};

/** 検索の 1 件のうち、smoke が照らす所。 */
export interface SearchHit {
  archiveId: string;
  stage: string | null;
}

/** `GET /api/search` の本文から当たりを読む。形が違えば undefined。 */
export const readSearchHits = (body: unknown): SearchHit[] | undefined => {
  if (!isRecord(body) || !Array.isArray(body["hits"]) || typeof body["total"] !== "number") {
    return undefined;
  }
  const hits: SearchHit[] = [];
  for (const hit of body["hits"]) {
    if (!isRecord(hit) || typeof hit["archiveId"] !== "string") return undefined;
    const stage = hit["stage"];
    hits.push({ archiveId: hit["archiveId"], stage: typeof stage === "string" ? stage : null });
  }
  return hits;
};

/** この archive の当たりの時点 (時点の無い当たりは `page`)。並べ替えて返す。 */
export const stagesOf = (hits: readonly SearchHit[], archiveId: string): string[] =>
  hits
    .filter((hit) => hit.archiveId === archiveId)
    .map((hit) => hit.stage ?? "page")
    .sort();

/**
 * この archive の当たりの時点が、ページ一覧から予想した時点と同じか。同じなら undefined。
 *
 * 当たりが 0 件のときも Reading を返す —— 待って引き直すかは呼ぶ側が決める (見てよいかの権限は
 * capture-ledger が 5 秒ごとに OpenFGA へ書くので、撮った直後は当たらないことがある)。
 */
export const compareSearchHits = (
  hits: readonly SearchHit[],
  archiveId: string,
  expected: readonly string[],
): Reading | undefined => {
  const found = stagesOf(hits, archiveId);
  const want = [...expected].sort();
  if (found.join(",") === want.join(",")) return undefined;
  if (found.length === 0) {
    return {
      evidence: `この回の archive ${archiveId} が検索に当たらない`,
      fix:
        "索引の段は載せたと言っている —— 見てよいかの関係が書かれていないか (capture-ledger の API のログの " +
        "「Scheduled outbox drain failed」)、OpenSearch の索引が作り直された (pnpm run search:reindex)",
    };
  }
  if (found.includes("page") && !want.includes("page")) {
    return {
      evidence: `検索の当たりに文書の行 (page) がある: ${found.join("・")} (ページ一覧から予想した時点は ${want.join("・")})`,
      fix: "capture-ledger が、写しの行がある WACZ の文書の行を索引に入れている —— capture-ledger が v0.70.0 より古い",
    };
  }
  return {
    evidence: `検索の当たりの時点が ${found.join("・")} で、ページ一覧から予想した ${want.join("・")} と違う`,
    fix: "capture-ledger の索引の作り方 (src/search/document.ts の pagesToIndex) と、この WACZ の pages/pages.jsonl を見比べる",
  };
};
