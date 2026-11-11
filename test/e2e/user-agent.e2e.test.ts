import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { jobArgsTree } from "./helpers/jobs.js";
import {
  FIXTURES,
  FIXTURES_HOST,
  json,
  ledger,
  mintToken,
  resetFixtures,
  WINDMILL,
  windmillToken,
  WORKSPACE,
} from "./helpers/stack.js";
import { readWacz, settingsOf } from "./helpers/wacz.js";

/**
 * **クロールごとの User-Agent が、capture-ledger → flow → crawl_host → BrowserHive → 相手 と運ばれる。**
 *
 * 単体で見えるのは「crawl_host が要求に載せる形」までで、flow が `user_agent` を運ぶか (`flow.yaml` の input_transforms)、
 * 次の段にも配られるか、BrowserHive が `{chrome}` を解くかは、本物を通さないと言えない。判定は 3 か所で採る:
 *
 *   - **相手が見た字** —— capture-fixtures のリクエストログ (`/__requests`)。robots.txt は別の道具が取るので除く
 *   - **capture-ledger の行** —— `GET /api/crawls/:id` の `userAgent` (打った字)
 *   - **WACZ** —— `datapackage.json` の `settings.userAgent` (解いた字)
 *
 * `sec-ch-ua` はここでは見られない。capture-fixtures は http で、Chromium は secure context にしか送らない。
 */

interface Logged {
  url: string;
  userAgent?: string;
}

/** 相手が見た要求。robots.txt を除く。 */
const seenByFixtures = async (): Promise<Logged[]> => {
  const { requests } = (await json(await fetch(`${FIXTURES_HOST}/__requests`))) as unknown as {
    requests: Logged[];
  };
  return requests.filter((r) => !r.url.includes("robots.txt"));
};

const pathOf = (url: string): string => new URL(url, "http://x").pathname;

const jobsOf = async (
  got: Record<string, unknown>,
): Promise<{ path: string | null; args: unknown }[]> => {
  const lastJob = got["lastJob"] as { id: string } | null;
  expect(lastJob, "capture-ledger が run の id を持っていない").not.toBeNull();
  return jobArgsTree(String(lastJob?.id), {
    windmill: WINDMILL,
    workspace: WORKSPACE,
    token: windmillToken(),
  });
};

const userAgentArgOf = (
  jobs: { path: string | null; args: unknown }[],
  script: string,
): unknown[] =>
  jobs
    .filter((job) => job.path === `f/waggle/${script}`)
    .map((job) => (job.args as { user_agent?: unknown }).user_agent);

let api: ReturnType<typeof ledger>;

beforeAll(async () => {
  api = ledger(await mintToken());
});

afterAll(async () => {
  await resetFixtures();
});

describe("クロールごとの User-Agent", () => {
  it("頼んだ字が 2 段とも相手に届き、capture-ledger は打った字を、WACZ は解いた字を持つ", async () => {
    await resetFixtures();
    const seed = `${FIXTURES}/links/hub`;
    const asked = "{chrome} BrowserHive";

    const got = await api.finished(
      await api.start({ seeds: [seed], maxDepth: 1, maxPages: 5, userAgent: asked }),
    );
    expect(got["state"], String(got["error"])).toBe("succeeded");
    expect(got["userAgent"]).toBe(asked);

    const archive = await api.archiveOf(seed, String(got["startedAt"]));
    const recorded = settingsOf(await readWacz(await api.signedUrl(archive.id)))[
      "userAgent"
    ] as string;
    expect(recorded).toMatch(/ Chrome\/.* BrowserHive$/);
    expect(recorded).not.toContain("HeadlessChrome");
    expect(recorded).not.toContain("{chrome}");

    const seen = await seenByFixtures();
    const paths = new Set(seen.map((r) => pathOf(r.url)));
    expect(paths, "1 段目の起点が届いていない").toContain("/links/hub");
    expect(paths.size, "2 段目のページが届いていない").toBeGreaterThan(1);
    expect(new Set(seen.map((r) => r.userAgent)), "字の違う要求が在る").toEqual(
      new Set([recorded]),
    );

    // BrowserHive の名前で照らしても、名指しの組が無ければ * の組に落ちて断られる
    expect(paths, "robots が禁じたページに触れた").not.toContain("/links/hidden");

    // flow が 2 つの部品へ打った字のまま運んだ（最後の段の run）
    const jobs = await jobsOf(got);
    expect(userAgentArgOf(jobs, "plan_level"), "plan_level に届いていない").toEqual([asked]);
    expect(new Set(userAgentArgOf(jobs, "crawl_host")), "crawl_host に届いていない").toEqual(
      new Set([asked]),
    );
  });

  it("頼まなければ browser の字のまま撮り、capture-ledger は null を、flow は空の字を持つ", async () => {
    await resetFixtures();
    const seed = `${FIXTURES}/plain-html`;

    const got = await api.finished(await api.start({ seeds: [seed], maxDepth: 0 }));
    expect(got["state"], String(got["error"])).toBe("succeeded");
    expect(got["userAgent"]).toBeNull();

    const archive = await api.archiveOf(seed, String(got["startedAt"]));
    const recorded = settingsOf(await readWacz(await api.signedUrl(archive.id)))[
      "userAgent"
    ] as string;
    expect(recorded).toContain("HeadlessChrome");
    expect(new Set((await seenByFixtures()).map((r) => r.userAgent))).toEqual(new Set([recorded]));

    const jobs = await jobsOf(got);
    expect(userAgentArgOf(jobs, "plan_level")).toEqual([""]);
    expect(new Set(userAgentArgOf(jobs, "crawl_host"))).toEqual(new Set([""]));
  });

  it("BrowserHive を含まない字でも撮り、相手にその字が届く", async () => {
    await resetFixtures();
    const seed = `${FIXTURES}/plain-html`;
    const asked = "{chrome}";

    const got = await api.finished(
      await api.start({ seeds: [seed], maxDepth: 0, userAgent: asked }),
    );
    expect(got["state"], String(got["error"])).toBe("succeeded");
    expect(got["userAgent"]).toBe(asked);

    const archive = await api.archiveOf(seed, String(got["startedAt"]));
    const recorded = settingsOf(await readWacz(await api.signedUrl(archive.id)))[
      "userAgent"
    ] as string;
    expect(recorded).toMatch(/ Chrome\/.* Safari\/[\d.]+$/);
    expect(recorded).not.toContain("HeadlessChrome");
    expect(recorded).not.toContain("{chrome}");
    expect(recorded).not.toContain("BrowserHive");
    expect(new Set((await seenByFixtures()).map((r) => r.userAgent))).toEqual(new Set([recorded]));

    const jobs = await jobsOf(got);
    expect(userAgentArgOf(jobs, "plan_level")).toEqual([asked]);
    expect(new Set(userAgentArgOf(jobs, "crawl_host"))).toEqual(new Set([asked]));
  });

  it("形に合わない字は 400 で断り、相手に何も届かない", async () => {
    await resetFixtures();

    const { status, text } = await api.post({
      seeds: [`${FIXTURES}/plain-html`],
      maxDepth: 0,
      userAgent: "クローラー",
    });

    expect(status, text).toBe(400);
    expect(text).toContain("userAgent must be printable ASCII");
    expect(await seenByFixtures()).toEqual([]);
  });
});
