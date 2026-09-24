/**
 * smoke が、1 本のクロールの終わり方を読む。
 *
 * **読み分けは実物の文から書いた。** 2026-09-19 に本物のスタックで 7 通りの失敗を起こし、
 * capture-ledger と Windmill の答えを `test/fixtures/crawl/` に残してある。計画の段階で
 * 想像した文は、実物と違った —— BrowserHive を止めたときの `UNAVAILABLE` は
 * `[cap] BrowserHive に届きません: …` だったし、段の報告が届かないときは「時間切れ」を
 * 待たなくても、Windmill の run が先に失敗で終わっていた。
 *
 * 失敗の文は 3 か所から来る:
 *
 *   台帳の error          flow が落ち、締める段 (fail_crawl) が `[段] 文` で締めたとき
 *   取れなかったページ     succeeded・0 ページ。理由は台帳の failures[].reason
 *   run の落ちた段の job   締める段も落ち、クロールが running のまま残ったとき
 *                          (段の報告と同じトークン・同じ宛先で締めるので、報告が 401・404・
 *                          届かない、のときは締めるのも同じ理由で落ちる)
 *
 * 入出力を持たない。訊くのは `smoke.ts`。
 */
import { sectionUrl, SECTIONS } from "../doctor/sections.js";

export interface Crawl {
  crawlId: string;
  state: string;
  stopReason: string | null;
  pagesCaptured: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** capture-ledger v0.43.0 から。それより古いと無い。 */
  lastJob?: { id: string; depth: number } | null;
  failures?: { url: string; depth: number; reason: string | null }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** `GET /api/crawls/:id` の本文。形が違えば undefined。 */
export const parseCrawl = (body: unknown): Crawl | undefined => {
  if (!isRecord(body)) return undefined;
  const { crawlId, state, pagesCaptured, startedAt } = body;
  if (
    typeof crawlId !== "string" ||
    typeof state !== "string" ||
    typeof pagesCaptured !== "number" ||
    typeof startedAt !== "string"
  ) {
    return undefined;
  }
  return body as unknown as Crawl;
};

/** Windmill の flow の job (`jobs_u/get/<id>`) を、smoke が要るだけに読む。 */
export type Run =
  | { state: "running" }
  | { state: "succeeded" }
  | {
      state: "failed";
      /** 落ちた段の id (report・hosts …)。 */
      step?: string;
      /** その段の job。文はそちらに在る。 */
      stepJob?: string;
      /** 締める段が締められなかった理由。 */
      closeProblem?: string;
      /** 取り消されたときの文。取り消すと締める段は走らない (2026-09-19 に実測)。 */
      canceled?: string;
    }
  | { state: "unknown"; detail: string };

export const readRun = (job: unknown): Run => {
  if (!isRecord(job)) return { state: "unknown", detail: String(job) };
  // 走っている job は QueuedJob として返る (2026-09-19 に実測。`running: true`)。
  if (job["type"] === "QueuedJob") return { state: "running" };
  if (job["type"] !== "CompletedJob") {
    return { state: "unknown", detail: `type=${String(job["type"])}` };
  }
  if (job["success"] === true) return { state: "succeeded" };
  const flow = isRecord(job["flow_status"]) ? job["flow_status"] : {};
  const modules = Array.isArray(flow["modules"]) ? flow["modules"] : [];
  const failed = modules.find(
    (m): m is Record<string, unknown> => isRecord(m) && m["type"] === "Failure",
  );
  const result = isRecord(job["result"]) ? job["result"] : {};
  const error = isRecord(result["error"]) ? result["error"] : {};
  return {
    state: "failed",
    ...(job["canceled"] === true && {
      canceled: typeof error["message"] === "string" ? error["message"] : "取り消された",
    }),
    ...(typeof failed?.["id"] === "string" && { step: failed["id"] }),
    ...(typeof failed?.["job"] === "string" && { stepJob: failed["job"] }),
    ...(result["closed"] === false &&
      typeof result["problem"] === "string" && { closeProblem: result["problem"] }),
  };
};

/**
 * 落ちた段の job から、投げられた文を読む。素の script の段だけが持っている —— for ループの
 * 段 (hosts) の job は `{ closed: true }` しか返さない (実測)。そのときは台帳の error を読む。
 */
export const stepMessage = (job: unknown): string | undefined => {
  if (!isRecord(job) || !isRecord(job["result"])) return undefined;
  const error = job["result"]["error"];
  return isRecord(error) && typeof error["message"] === "string" ? error["message"] : undefined;
};

/** 何を見て、何を直すか。smoke はこれを 2 行に印字する。 */
export interface Reading {
  /** 台帳か Windmill が言ったそのままの文と、その出どころ。 */
  evidence: string;
  /** 意味と直し方。 */
  fix: string;
}

const DIG = `run を開いて、落ちた段の log を見る (${sectionUrl(SECTIONS.digFailures)})`;

/** 段の報告・索引・締めは、どれも capture-ledger の API を叩く段。 */
const API_STEPS = new Set(["report", "index", "failure"]);

/**
 * 段の失敗の文 (台帳の `[段] 文`、または落ちた段の job の文) を、直し方に当てる。
 * 型はどれも実物で見たもの (`test/fixtures/crawl/`)。知らない型は文をそのまま出して run を見させる。
 */
export const readStepFailure = (step: string | undefined, message: string): string => {
  const unreachable = /BrowserHive に届きません: (.+)$/.exec(message);
  if (unreachable !== null) {
    return (
      `BrowserHive に届かない (${unreachable[1] ?? ""}) —— 止まっていれば起こす: ` +
      "cd ../capture-ledger && pnpm run stack:up (どの口かは pnpm run doctor の worker→browserhive)"
    );
  }
  if (/^POST \/api\/crawls\/\S+ → 401\b/.test(message)) {
    return (
      "段の報告を API が受けない (401) —— flow のトークンが古い (issuer を起こし直した後) → " +
      "pnpm run windmill:capture-ledger-token"
    );
  }
  if (/^POST \/api\/crawls\/\S+ → 404\b/.test(message)) {
    return (
      "段の報告が 404 —— flow のトークンの名前に、その組織のクロールの許可が無い → " +
      "cd ../capture-ledger && pnpm run fga:grant submitter windmill acme " +
      "(名前と組織が違えば pnpm run doctor の can_submit が言う)"
    );
  }
  if (step !== undefined && API_STEPS.has(step) && /Unable to connect/.test(message)) {
    return (
      "段の報告が capture-ledger の API に届かない —— API が 127.0.0.1 で待っているか、宛先が古い " +
      "(どちらかは pnpm run doctor の container→api が言う)"
    );
  }
  return `知らない失敗 —— ${DIG}`;
};

/** 取れなかったページの理由 (crawl_host が BrowserHive の答えから書く)。 */
export const readPageFailure = (reason: string): string => {
  if (/net::ERR_NAME_NOT_RESOLVED/.test(reason)) {
    return (
      "ページの名前が引けない —— URL の綴りを確かめる。綴りが正しければ、" +
      "BrowserHive (Chromium) のコンテナから外の名前を引けるか"
    );
  }
  return `ページを開けなかった —— ${DIG}`;
};

/** `[段] 文` を段と文に分ける (fail_crawl の `describe` の形)。 */
export const splitStep = (error: string): { step?: string; message: string } => {
  const match = /^\[([^\]]+)\] ([\s\S]*)$/.exec(error);
  return match === null ? { message: error } : { step: match[1], message: match[2] ?? "" };
};

/**
 * running でなくなったクロール。撮れていれば undefined (中身を取り出せるかは smoke が見る)。
 */
export const readFinished = (crawl: Crawl): Reading | undefined => {
  if (crawl.state === "succeeded" && crawl.pagesCaptured > 0) return undefined;
  if (crawl.state === "succeeded") {
    const [first] = crawl.failures ?? [];
    if (first === undefined) {
      return {
        evidence: "succeeded だが 1 ページも撮れていない。取れなかったページの記録も無い",
        fix: `robots.txt で飛ばしたか、capture-ledger が v0.43.0 より古い —— ${DIG}`,
      };
    }
    const reason = first.reason ?? "(理由の記録が無い)";
    return { evidence: `${first.url} —— ${reason}`, fix: readPageFailure(reason) };
  }
  if (crawl.error === null) {
    return {
      evidence: `${crawl.state} (${crawl.stopReason ?? "理由なし"})、台帳に error が無い`,
      fix: DIG,
    };
  }
  const { step, message } = splitStep(crawl.error);
  return { evidence: `台帳の error: ${crawl.error}`, fix: readStepFailure(step, message) };
};

/**
 * クロールは running のまま、run だけが失敗で終わった —— 締める段も落ちた。
 * 段の文が読めなければ、締められなかった理由で読む (同じトークン・同じ宛先なので、たいてい同じ理由)。
 */
export const readStuck = (run: Extract<Run, { state: "failed" }>, message?: string): Reading => {
  if (run.canceled !== undefined) {
    return {
      evidence: `run が取り消された: ${run.canceled}`,
      fix: "Windmill で run を取り消すと、締める段も走らない —— 撮り直すなら pnpm run smoke",
    };
  }
  const text = message ?? run.closeProblem;
  if (text === undefined) {
    return {
      evidence: `run が${run.step === undefined ? "" : ` ${run.step} の段で`}失敗し、クロールは running のまま`,
      fix: DIG,
    };
  }
  return {
    evidence: `run の ${run.step ?? "?"} の段: ${text}`,
    fix: readStepFailure(run.step, text),
  };
};

/** `POST /api/crawls` が 202 でなかった。 */
export const readRefused = (status: number | undefined, body: string): Reading => {
  const evidence = `POST /api/crawls → ${String(status)} ${body.trim().slice(0, 300)}`;
  if (status === undefined) {
    return {
      evidence,
      fix: "capture-ledger の API に届かない → cd ../capture-ledger && pnpm run api",
    };
  }
  if (status === 401) {
    return {
      evidence,
      fix: "API が flow のトークン (u/admin/waggle_token) を受けない → pnpm run windmill:capture-ledger-token (pnpm run doctor の jwt・can_submit)",
    };
  }
  if (status === 404 && /Route POST:\/api\/crawls not found/.test(body)) {
    return {
      evidence,
      fix: "/api/crawls そのものが無い —— capture-ledger の .env に webhook の 2 行が無い (pnpm run doctor の crawl route)",
    };
  }
  if (status === 404) {
    return {
      evidence,
      fix:
        "flow のトークンの名前に、クロールの許可が無い → cd ../capture-ledger && " +
        "pnpm run fga:grant submitter windmill acme (pnpm run doctor の can_submit)",
    };
  }
  return { evidence, fix: DIG };
};

/** 409 の本文 (capture-ledger v0.43.0 から、走行中の 1 本を名指しする)。 */
export const readBusy = (body: unknown): { crawlId?: string; startedAt?: string } => {
  if (!isRecord(body)) return {};
  return {
    ...(typeof body["crawlId"] === "string" && { crawlId: body["crawlId"] }),
    ...(typeof body["startedAt"] === "string" && { startedAt: body["startedAt"] }),
  };
};
