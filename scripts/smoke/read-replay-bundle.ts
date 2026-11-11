/**
 * smoke が、撮った 1 本が **合本に入り、replayweb-server から読める** ところまでを読む (CAPTURE-57)。
 *
 * flow は段の報告の後に合本の段 (`replay_bundle_level.ts`) を走らせ、capture-ledger がクロールの合本 (`replay.json` と
 * `pages.json` の組) を保管庫の `org/<組織>/crawls/<クロール>/r<版>/` に書く。合本の段は、台帳が 200 で返す失敗
 * (保管庫に書けない・検められない WACZ・入れる WACZ が無い) では投げない (クロールを止めないため) ので、**run が
 * 緑でも、合本が書けたとは限らない** —— smoke は合本の段の答えを読み、台帳が指す合本の `replay.json` を replayweb-server の
 * `/wacz/<鍵>` から読んで、この回の archive が `resources` に入っているかまで照らす。
 *
 * 入出力を持たない。訊くのは `smoke.ts`。
 */
import type { Reading } from "./read-crawl.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** flow の段の job (`jobs_u/get/<id>`) から、合本の段 (flow.yaml の `id: replay_bundle`) の job を探す。 */
export const replayBundleJobOf = (job: unknown): string | undefined => {
  if (!isRecord(job)) return undefined;
  const flow = isRecord(job["flow_status"]) ? job["flow_status"] : {};
  const modules = Array.isArray(flow["modules"]) ? flow["modules"] : [];
  const step = modules.find(
    (m): m is Record<string, unknown> => isRecord(m) && m["id"] === "replay_bundle",
  );
  return typeof step?.["job"] === "string" ? step["job"] : undefined;
};

/** 合本の段 (`replay_bundle_level.ts`) が返した、capture-ledger の答え。 */
export interface ReplayBundleOutcome {
  rev: number | null;
  pages: number;
  members: number;
  skipped: number;
  failed: number;
  error: string | null;
}

/** 合本の段の job の `result`。形が違えば undefined。 */
export const readReplayBundleOutcome = (job: unknown): ReplayBundleOutcome | undefined => {
  if (!isRecord(job) || !isRecord(job["result"])) return undefined;
  const { rev, pages, members, skipped, failed, error } = job["result"];
  if (
    !(rev === null || (isCount(rev) && rev >= 1)) ||
    !isCount(pages) ||
    !isCount(members) ||
    !isCount(skipped) ||
    !isCount(failed) ||
    !(error === null || typeof error === "string")
  ) {
    return undefined;
  }
  return { rev, pages, members, skipped, failed, error };
};

/** 合本を作り直す手 (capture-ledger の道具。エンドポイントと同じ関数で、新しい版を書く)。 */
const rebuild = (crawlId: string): string =>
  `cd ../capture-ledger && pnpm run replay-bundle:rebuild --crawl ${crawlId}`;

/** 合本の段の答えが、smoke を止めるか。止めなければ undefined (書けた版がある)。 */
export const readReplayBundleStep = (
  outcome: ReplayBundleOutcome | undefined,
  crawlId: string,
): Reading | undefined => {
  if (outcome === undefined) {
    return {
      evidence: "合本の段の答えが読めない (run に replay_bundle の段が無いか、答えの形が違う)",
      fix: "Windmill の flow が古い → pnpm run windmill:push",
    };
  }
  if (outcome.error !== null) {
    return {
      evidence: `合本の段: r${String(outcome.rev)} を保管庫に書けなかった: ${outcome.error}`,
      fix: `capture-ledger の API のログの「could not write the replay bundle」で理由を見て直し、作り直す → ${rebuild(crawlId)}`,
    };
  }
  if (outcome.failed > 0) {
    return {
      evidence: `合本の段: 検められなかった WACZ が ${String(outcome.failed)} 本`,
      fix: `capture-ledger の API のログの「could not inspect this archive」を見て直し、作り直す → ${rebuild(crawlId)}`,
    };
  }
  if (outcome.rev === null) {
    return {
      evidence: `合本の段: 入れる WACZ が無く、書かなかった (記録が 0 で外した ${String(outcome.skipped)} 本)`,
      fix: "この回の archive が台帳に載る前に合本の段が走ったか、WACZ の記録が 0 —— run を開いて report と replay_bundle の段の log を見る",
    };
  }
  return undefined;
};

/**
 * 合本の段が落ちた文 (`replay_bundle_level.ts` が投げる文) を、直し方に当てる。当てられなければ undefined
 * (呼ぶ側が段の失敗の読み分け `readStepFailure` に回す。401・許可の 404 はそちらが読む)。
 */
export const readReplayBundleFailure = (message: string): string | undefined => {
  if (/合本のエンドポイントが無い/.test(message)) {
    return (
      "capture-ledger に合本のエンドポイントが無い (capture-ledger が古い) → cd ../capture-ledger && git pull && " +
      "pnpm run dev:up (pnpm run doctor の replay-bundle route)"
    );
  }
  if (/\/replay-bundle → 400\b/.test(message)) {
    return (
      "capture-ledger が合本の段の本文を断った —— capture-ledger と capture-scheduler の版の組が合っていない " +
      "(pnpm run doctor の replay-bundle route)"
    );
  }
  return undefined;
};

/** 台帳が指す合本 (`GET /api/crawls/:id` の `replayBundle`)。smoke が使う所だけ。 */
export interface LedgerReplayBundle {
  /** 保管庫の `replay.json` の鍵 (`org/<組織>/crawls/<クロール>/r<版>/replay.json`)。 */
  key: string;
  rev: number;
}

/**
 * `GET /api/crawls/:id` の本文から、台帳が指す合本を読む。合本の段が r`wrote` を書いたと言った後に呼ぶ。
 * 台帳が指す版は前へだけ進むので、`wrote` より小さければ食い違い。
 */
export const readLedgerReplayBundle = (
  body: unknown,
  wrote: number,
): { replayBundle: LedgerReplayBundle } | { problem: Reading } => {
  if (!isRecord(body) || !("replayBundle" in body)) {
    return {
      problem: {
        evidence: "GET /api/crawls/:id の答えに replayBundle が無い",
        fix: "capture-ledger が古い (合本の欄が無い) → cd ../capture-ledger && git pull && pnpm run dev:up",
      },
    };
  }
  const field = body["replayBundle"];
  if (field === null) {
    return {
      problem: {
        evidence: `合本の段は r${String(wrote)} を書いたと言ったが、台帳はこのクロールの合本を指していない (replayBundle が null)`,
        fix: "capture-ledger の API のログの「replay bundle written」と「could not write the replay bundle」を見る",
      },
    };
  }
  const key = isRecord(field) ? field["key"] : undefined;
  const rev = isRecord(field) ? field["rev"] : undefined;
  if (typeof key !== "string" || !isCount(rev)) {
    return {
      problem: {
        evidence: `台帳の replayBundle の形が違う (key と rev が要る): ${JSON.stringify(field).slice(0, 200)}`,
        fix: "capture-ledger が合本を 1 度も書けていないか (key が null)、capture-ledger と capture-scheduler の版の組が合っていない",
      },
    };
  }
  if (rev < wrote) {
    return {
      problem: {
        evidence: `台帳が指す合本は r${String(rev)} で、合本の段が書いた r${String(wrote)} より古い`,
        fix: "台帳が指す版は前へだけ進むはず —— capture-ledger の src/replay-bundle/write.ts の「前へだけ」を見る",
      },
    };
  }
  return { replayBundle: { key, rev } };
};

/** replayweb-server の `/wacz/<鍵>` の URL。鍵は区切りごとに符号にする (replayweb-server は区切りごとに 1 度だけ解く)。 */
export const replayJsonKeyUrl = (replaywebServerOrigin: string, key: string): string =>
  `${replaywebServerOrigin}/wacz/${key.split("/").map(encodeURIComponent).join("/")}`;

/** `resources[].path` (`/wacz/` ＋ 区切りごとに符号にした鍵) を、保管庫の鍵に戻す。戻せなければ undefined。 */
const keyOfPath = (path: unknown): string | undefined => {
  if (typeof path !== "string" || !path.startsWith("/wacz/")) return undefined;
  try {
    return path.slice("/wacz/".length).split("/").map(decodeURIComponent).join("/");
  } catch {
    return undefined;
  }
};

/**
 * replayweb-server から読んだ `replay.json` を照らす。JSON として読め、この回の archive の鍵 (`objectKey`) が `resources` に
 * 在れば undefined。
 *
 * @param status 届かなければ undefined
 */
export const readReplayJson = (
  url: string,
  status: number | undefined,
  body: string,
  objectKey: string,
): Reading | undefined => {
  if (status === undefined) {
    return {
      evidence: `${url} に届かない`,
      fix: "capture-ledger のスタックの replayweb-server が答えない → cd ../capture-ledger && pnpm run stack:up",
    };
  }
  if (status !== 200) {
    return {
      evidence: `GET ${url} → ${String(status)} ${body.slice(0, 200)}`,
      fix:
        status === 404
          ? "台帳が指す合本が、replayweb-server の読む保管庫に無い —— capture-ledger の保管庫の bucket と、replayweb-server の S3_BUCKET_URL が同じか"
          : status === 502 || status === 504
            ? "replayweb-server が保管庫に届かない —— 保管庫が動いているか、replayweb-server の S3_BUCKET_URL を見る"
            : "replayweb-server の /wacz/ が保管庫の物をそのまま返していない —— replayweb-server の版 (capture-ledger の .upstream/replayweb-server)",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const resources = isRecord(parsed) ? parsed["resources"] : undefined;
  if (!Array.isArray(resources)) {
    return {
      evidence: `${url} の中身が合本の replay.json でない (JSON でないか、resources が無い): ${body.slice(0, 120)}`,
      fix: "capture-ledger が書いた replay.json を、保管庫で直に見る (replayweb-server の /wacz/ が別の物を返していないか)",
    };
  }
  const keys = resources.map((resource) =>
    isRecord(resource) ? keyOfPath(resource["path"]) : undefined,
  );
  if (!keys.includes(objectKey)) {
    return {
      evidence: `合本の resources (${String(resources.length)} 本) に、この回の archive ${objectKey} が無い`,
      fix: "capture-ledger が、この取り込みをクロールに繋いでいない (archives.crawl_id) —— 段の報告の log を見る",
    };
  }
  return undefined;
};
