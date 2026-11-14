import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { jobArgsTree } from "./helpers/jobs.js";
import {
  FIXTURES,
  ledger,
  mintToken,
  resetFixtures,
  WINDMILL,
  windmillToken,
  WORKSPACE,
} from "./helpers/stack.js";
import { datapackageOf, readWacz, textOf, type WaczMembers } from "./helpers/wacz.js";

/**
 * **クロールごとの乱数の控え (`recordRandom`) が、capture-ledger → flow → crawl_host → BrowserHive と運ばれる**（CAPTURE-378）。
 *
 * 単体で見えるのは「crawl_host が要求に載せる形」までで、flow が `record_random` を運ぶか (`flow.yaml` の input_transforms)、
 * BrowserHive が頁の JS の乱数を控えるかは、本物を通さないと言えない。判定は 2 か所で採る:
 *
 *   - **WACZ** —— `random/values.jsonl` の有無と、`datapackage.json` の `browserhive:capture.random`
 *     (BrowserHive WACZ Profile 1.26.0 の #random)
 *   - **flow の run** —— crawl_host に届いた `record_random`
 *
 * 撮るのは capture-fixtures の `scenarios.randomPick` (`/random/pick`)。`Math.random` を 1 度だけ、スクリプトのファイルから引く頁。
 *
 * **要る一式:** dev の BrowserHive v31.1.0 以上 (`recordRandom` を知らない版は 400 で断る)・capture-fixtures v0.36.0 以上
 * (`/random/*` の頁)・`record_random` を送り、`POST /api/crawls` で `recordRandom` を受ける capture-ledger。それより前の
 * 一式では赤。
 */

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

/** crawl_host の run に届いた `record_random`。 */
const recordRandomArgOf = (jobs: { path: string | null; args: unknown }[]): unknown[] =>
  jobs
    .filter((job) => job.path === "f/waggle/crawl_host")
    .map((job) => (job.args as { record_random?: unknown }).record_random);

/** `datapackage.json` の `browserhive:capture.random`。 */
const randomOf = (members: WaczMembers): Record<string, unknown> => {
  const capture = datapackageOf(members)["browserhive:capture"] as
    | { random?: Record<string, unknown> }
    | undefined;
  if (capture?.random === undefined) {
    throw new Error("datapackage.json に browserhive:capture.random が無い");
  }
  return capture.random;
};

let api: ReturnType<typeof ledger>;

beforeAll(async () => {
  api = ledger(await mintToken());
});

afterAll(async () => {
  await resetFixtures();
});

describe("クロールごとの乱数の控え", () => {
  it("頼めば、頁の JS が引いた乱数が WACZ の random/values.jsonl に控えられる", async () => {
    await resetFixtures();
    const seed = `${FIXTURES}/random/pick`;

    const got = await api.finished(
      await api.start({ seeds: [seed], maxDepth: 0, recordRandom: true }),
    );
    expect(got["state"], String(got["error"])).toBe("succeeded");

    const archive = await api.archiveOf(seed, String(got["startedAt"]));
    const members = await readWacz(await api.signedUrl(archive.id));
    const random = randomOf(members);
    expect(random["recorded"]).toBe(true);
    expect(random).not.toHaveProperty("skipped");

    const values = members.get("random/values.jsonl");
    expect(values, "WACZ に random/values.jsonl が無い").toBeDefined();
    const lines = textOf("random/values.jsonl", values ?? new Uint8Array())
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { kind?: unknown });
    // /random/pick は Math.random を 1 度引く。要約の数は行の数と同じ (Profile 1.26.0)
    expect(random["draws"]).toBeGreaterThanOrEqual(1);
    expect(lines.filter((line) => line.kind === "draw")).toHaveLength(Number(random["draws"]));

    const jobs = await jobsOf(got);
    expect(new Set(recordRandomArgOf(jobs)), "crawl_host に届いていない").toEqual(new Set([true]));
  });

  it("頼まなければ控えず、WACZ は recorded: false・skipped: not-requested で random/ を持たない", async () => {
    await resetFixtures();
    const seed = `${FIXTURES}/random/pick`;

    const got = await api.finished(
      await api.start({ seeds: [seed], maxDepth: 0, recordRandom: false }),
    );
    expect(got["state"], String(got["error"])).toBe("succeeded");

    const archive = await api.archiveOf(seed, String(got["startedAt"]));
    const members = await readWacz(await api.signedUrl(archive.id));
    expect(randomOf(members)).toMatchObject({ recorded: false, skipped: "not-requested" });
    expect([...members.keys()].filter((name) => name.startsWith("random/"))).toEqual([]);

    const jobs = await jobsOf(got);
    expect(new Set(recordRandomArgOf(jobs))).toEqual(new Set([false]));
  });
});
