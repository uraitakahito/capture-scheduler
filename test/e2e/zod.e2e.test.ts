import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { FIXTURES, ledger, mintToken, requestCounts, resetFixtures } from "./helpers/stack.js";
import { readWacz, textOf } from "./helpers/wacz.js";

/**
 * **スクリプトの `import { z } from "zod"` が、本物の Chromium のページの中で動く。**
 *
 * ts-compile-service の単体は `node:vm` で組み上げの形を見る。本物の CSP に投げられないか、相手のサイトへ
 * 違反の報告が飛ばないか、BrowserHive が終わりを待てるかは、本物を通さないと言えない。
 *
 * 判定は 2 か所で採る。相手が何を受け取ったかは capture-fixtures のリクエストログ、ページの中で何が起きたかは
 * 台帳の `GET /api/crawls/:id/pages/:page/log` (BrowserHive の答えのログ)。
 *
 * ## `await` の後で動かす
 *
 * `page.evaluate` の同期の間は CDP が eval を許すので、同期のまま `new Function` を呼んでも CSP に当たらない
 * (Chrome for Testing 156 で 0 回)。`await` の後は CSP に戻る。だから試すスクリプトも対照も、`await` の後で動かす。
 *
 * ## 報告が届く間を置く
 *
 * 違反の報告はブラウザが後から送る。取り込みが先に終わると、0 回が「飛ばなかった」のか「まだ」なのかを
 * 分けられない。スクリプトの中で待ち、対照で届くことを示す。
 */

/** `/csp/strict` の報告の口 (capture-fixtures の `CSP_REPORT.path`) */
const CSP_REPORT = "/csp/report";

/** 報告がブラウザから届くまでの間 */
const REPORT_SETTLE_MS = 500;
const pause = (ms: number): string =>
  `await new Promise((resolve) => setTimeout(resolve, ${String(ms)}));`;

let api: ReturnType<typeof ledger>;

beforeAll(async () => {
  api = ledger(await mintToken());
});

/** その場の TS を 1 本、起点 1 つで走らせ、終わるまで待つ。 */
const crawlWith = async (
  seed: string,
  source: string,
): Promise<{ crawlId: string; got: Record<string, unknown> }> => {
  const crawlId = await api.start({
    seeds: [`${FIXTURES}${seed}`],
    maxDepth: 0,
    scripts: [{ inline: { name: "zod-probe", phase: "behavior", source } }],
  });
  return { crawlId, got: await api.finished(crawlId) };
};

interface LogLine {
  source: string;
  script?: string;
  level: string;
  msg: string;
  data?: unknown;
}

/** クロールの最初のページの、BrowserHive のログ。 */
const logOf = async (crawlId: string): Promise<LogLine[]> => {
  const listed = (await api.get(`/api/crawls/${crawlId}/pages`)) as { pages: { id: string }[] };
  const page = listed.pages[0];
  expect(page, "クロールにページが無い").toBeDefined();
  const got = (await api.get(`/api/crawls/${crawlId}/pages/${String(page?.id)}/log`)) as {
    log: { lines: LogLine[] } | null;
    reason: string | null;
  };
  expect(got.log, `ログを読めない: ${String(got.reason)}`).not.toBeNull();
  return got.log?.lines ?? [];
};

describe("スクリプトで Zod を使う", () => {
  it("厳しい CSP のページで Zod が動き、相手のサイトへ報告が飛ばない", async () => {
    await resetFixtures();
    const mark = `z-${randomUUID().slice(0, 8)}`;
    // 同期で定義して await の後で parse する。jitless が無いと、ここで Zod が new Function を呼んで投げる
    const { got } = await crawlWith(
      "/csp/strict",
      `import { z } from "zod";

const Mark = z.object({ mark: z.string() });

(async () => {
  ${pause(0)}
  const { mark } = Mark.parse({ mark: ${JSON.stringify(mark)} });
  await fetch("/plain-html?zod=" + mark);
  ${pause(REPORT_SETTLE_MS)}
})();
`,
    );
    expect(got["state"], String(got["error"])).toBe("succeeded");

    const counts = await requestCounts();
    expect(counts["/csp/strict"], "取り込みが届いていない").toBeGreaterThan(0);
    expect(
      counts[`/plain-html?zod=${mark}`] ?? 0,
      "Zod の parse の後の印が届かない —— ページの中で投げたか、スクリプトが走っていない",
    ).toBeGreaterThan(0);
    expect(counts[CSP_REPORT] ?? 0, "Zod が eval を試して、相手のサイトへ報告が飛んだ").toBe(0);
  });

  it("対照: 同じページで await の後に new Function を呼ぶと、報告が届く", async () => {
    // これが無いと、上の 0 回は「報告の道が壊れている」ときにも緑になる
    await resetFixtures();
    const { got } = await crawlWith(
      "/csp/strict",
      `(async () => {
  ${pause(0)}
  try {
    new Function("");
  } catch {
    // CSP が拒む。投げても投げなくても、報告は飛ぶ
  }
  ${pause(REPORT_SETTLE_MS)}
})();
`,
    );
    expect(got["state"], String(got["error"])).toBe("succeeded");
    expect((await requestCounts())[CSP_REPORT] ?? 0, "違反の報告が届かない").toBeGreaterThan(0);
  });

  it("BrowserHive がスクリプトの終わりを待つ —— 待つ間の時間がログに出る", async () => {
    await resetFixtures();
    const waitMs = 1500;
    const { crawlId, got } = await crawlWith(
      "/plain-html",
      `import { z } from "zod";

(async () => {
  z.string().parse("x");
  ${pause(waitMs)}
})();
`,
    );
    expect(got["state"], String(got["error"])).toBe("succeeded");

    const lines = await logOf(crawlId);
    const finished = lines.find((l) =>
      /^script inline-zod-probe finished after \d+ms$/.test(l.msg),
    );
    expect(finished, JSON.stringify(lines.map((l) => l.msg))).toBeDefined();
    const elapsed = Number(/after (\d+)ms/.exec(finished?.msg ?? "")?.[1]);
    expect(elapsed, "終わりを待っていない —— 完了値が Promise でない").toBeGreaterThanOrEqual(
      waitMs,
    );
  });

  it("走った JS が記録に残り、Zod の版が読めて、import は残らない", async () => {
    await resetFixtures();
    const seed = `${FIXTURES}/plain-html`;
    const { got } = await crawlWith(
      "/plain-html",
      `import { z } from "zod";\n\n(async () => {\n  z.string().parse("x");\n})();\n`,
    );
    expect(got["state"], String(got["error"])).toBe("succeeded");

    const archive = await api.archiveOf(seed, String(got["startedAt"]));
    const members = await readWacz(await api.signedUrl(archive.id));
    const custom = members.get("behaviors/custom.jsonl");
    expect(custom, "behaviors/custom.jsonl が無い").toBeDefined();
    const [row] = textOf("behaviors/custom.jsonl", custom ?? new Uint8Array())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; source: string });
    expect(row?.id).toBe("inline-zod-probe");
    expect(row?.source).toMatch(/\/\/ zod \d+\.\d+\.\d+ \(MIT\)/);
    expect(row?.source).not.toMatch(/^import /m);
  });

  it("形が合わないときは成功のまま、どの項目かがログに残る", async () => {
    await resetFixtures();
    const { crawlId, got } = await crawlWith(
      "/plain-html",
      `import { z } from "zod";

(async () => {
  const parsed = z.object({ hits: z.number() }).safeParse({ hits: "x" });
  if (!parsed.success) globalThis.__bh.log.error("形が違う", z.treeifyError(parsed.error));
})();
`,
    );
    expect(got["state"], String(got["error"])).toBe("succeeded");

    const lines = await logOf(crawlId);
    const line = lines.find((l) => l.source === "script" && l.level === "error");
    expect(line?.msg, JSON.stringify(lines.map((l) => l.msg))).toBe("形が違う");
    expect(JSON.stringify(line?.data)).toContain("hits");
  });

  it("受けない import の形は、compile の段でクロールごと落ちる", async () => {
    const { got } = await crawlWith(
      "/plain-html",
      `import { z as zod } from "zod";\n\n(async () => {\n  zod.string().parse("x");\n})();\n`,
    );
    expect(got["state"], `stopReason=${String(got["stopReason"])}`).toBe("failed");
    const reason = String(got["error"]);
    expect(reason, "落ちた段が compile ではない").toContain("compile 422");
    expect(reason, "BH0003 が error に無い").toContain("BH0003");
    expect(reason, "診断が、その場の TS を名指していない").toContain("inline-zod-probe.ts");
  });
});
