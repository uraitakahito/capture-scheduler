import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../windmill/f/waggle/crawl_host.js";

/**
 * crawl_host の `main` の配線。flow から届いた引数を、解いたシークレットと一緒に BrowserHive の要求まで運ぶか。
 *
 * 要求の組み立ては `captureHost` が見ている (`crawl-host.test.ts`)。ここは `main` が渡し忘れないかだけを見る ——
 * `main` が `secret_archive` を `captureHost` に渡し忘れても、取り込みは成功し、keep と宣言した値が黙って隠れる。
 * Windmill の変数と BrowserHive のエンドポイントは差し替える (`windmill-client` と `fetch`)。
 */
const VARS: Record<string, string> = {
  "u/admin/browserhive_endpoints": '["http://bh.test:50051"]',
  "u/admin/browserhive_tls_ca": "",
  "f/waggle_secrets/note": "kept-value-1234",
  "f/waggle_secrets/password": "hidden-value-5678",
};

vi.mock("windmill-client", () => ({
  getVariable: (path: string) => {
    const value = VARS[path];
    return value === undefined
      ? Promise.reject(new Error(`Variable ${path} not found`))
      : Promise.resolve(value);
  },
}));

/** BrowserHive のエンドポイントの偽物。届いた要求の本文を積み、成功の答えを返す。 */
const answering = (): unknown[] => {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            taskId: "t1",
            report: { status: "success", artifacts: {} },
            manifest: { location: "s3://b/t1.result.json" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }),
  );
  return bodies;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const FORMATS = { png: false, webp: false, html: false, links: true, mhtml: false, wacz: true };

/** flow が渡す形で 1 回呼ぶ。シークレットは 2 つ (note・password) を path で渡す。 */
const run = (secretArchive: Record<string, "keep"> | null | undefined) =>
  main(
    "c1",
    "site.test",
    ["http://site.test/a"],
    0,
    FORMATS,
    false,
    [],
    0,
    undefined,
    {},
    { note: "f/waggle_secrets/note", password: "f/waggle_secrets/password" },
    "",
    secretArchive,
  );

describe("main が secret_archive を BrowserHive の要求へ運ぶ", () => {
  it("flow から届いた keep を、解いたシークレットに在る名前だけにして secretArchive に載せる", async () => {
    const bodies = answering();
    const results = await run({ note: "keep", absent: "keep" });
    expect(results.map((result) => result.status)).toEqual(["captured"]);
    expect(bodies[0]).toMatchObject({
      secrets: { note: "kept-value-1234", password: "hidden-value-5678" },
      secretArchive: { note: "keep" },
    });
  });

  it("古い capture-ledger から null で届けば、secretArchive は送らない（全部を隠す側に倒れる）", async () => {
    const bodies = answering();
    await run(null);
    expect(bodies[0]).toHaveProperty("secrets");
    expect(bodies[0]).not.toHaveProperty("secretArchive");
  });
});
