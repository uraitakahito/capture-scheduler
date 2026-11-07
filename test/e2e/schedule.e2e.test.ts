import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FIXTURES, json, ledger, mintToken, WAGGLE } from "./helpers/stack.js";

/**
 * **定期実行の予定から、本物の flow を通して 1 本撮る。**
 *
 * 時計は capture-ledger の中に在る。この repo に schedule は無く、flow は台帳が webhook で投げた段を撮るだけ。周回の判定は
 * 台帳の単体と `schedules-smoke` が見るので、ここで見るのは端から端 —— 周回が始めた回が flow まで届き、撮れて、回の行に
 * 予定の名前が残ること。
 *
 * 期限の回は静かな時間を待つので試験にならない。「いま撮る」は静けさを見ない。
 */

let token: string;
let api: ReturnType<typeof ledger>;
const made: string[] = [];

const post = async (path: string, body: Record<string, unknown> = {}) => {
  const res = await fetch(`${WAGGLE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await json(res) };
};

const nameOf = (): string => `e2e-${randomUUID().slice(0, 8)}`;

/** 深さ 0 で何も走らせない頼み。撮れたかだけを見るので、スクリプトの顔ぶれに依らない。 */
const REQUEST = { seeds: [`${FIXTURES}/responsive-images`], maxDepth: 0, scripts: [] };

const create = async (name: string): Promise<string> => {
  const { status, body } = await post("/api/schedules", {
    name,
    // 遠い先の 1 回。いま撮るで動かすので、期限が来ることは無い
    cron: "0 4 1 1 *",
    request: REQUEST,
  });
  expect(status, JSON.stringify(body)).toBe(201);
  const id = String(body["id"]);
  made.push(id);
  return id;
};

beforeAll(async () => {
  token = await mintToken();
  api = ledger(token);
});

afterAll(async () => {
  await Promise.all(made.map((id) => post(`/api/schedules/${id}/delete`)));
});

describe("定期実行", () => {
  it("予定を作り、いま撮るで回が撮れて、行に予定の名前が残る", async () => {
    const name = nameOf();
    const id = await create(name);

    const asked = await post(`/api/schedules/${id}/run`);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);

    // 周回は頼みの直後に回るが、走っているクロールがあれば次の周回 (30 秒) に回る
    let runs: Record<string, unknown>[] = [];
    for (let i = 0; i < 40 && runs.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      runs = (await api.get(`/api/schedules/${id}`))["recentRuns"] as Record<string, unknown>[];
    }
    expect(runs, "周回が回を始めなかった").toHaveLength(1);

    const crawlId = String(runs[0]?.["crawlId"]);
    const got = await api.finished(crawlId);
    expect(got["state"], String(got["error"])).toBe("succeeded");
    expect(got["schedule"]).toEqual({ id, name });
    // いま撮るの回に本来の時刻は無い
    expect(got["scheduledFor"]).toBeNull();
    expect(got["scheduleMissed"]).toBe(0);

    const after = await api.get(`/api/schedules/${id}`);
    expect(after["health"]).toBe("ok");
    expect(after["runRequestedAt"]).toBeNull();
    expect((after["recentRuns"] as Record<string, unknown>[])[0]).toMatchObject({
      crawlId,
      state: "succeeded",
      pagesCaptured: 1,
    });
  });

  it("止めて再開でき、消すと読めなくなる", async () => {
    const id = await create(nameOf());

    const paused = await post(`/api/schedules/${id}/pause`);
    expect(paused.body).toMatchObject({ enabled: false, health: "paused" });

    const resumed = await post(`/api/schedules/${id}/resume`);
    expect(resumed.body).toMatchObject({ enabled: true, health: "ok" });

    const deleted = await post(`/api/schedules/${id}/delete`);
    expect(deleted.body).toEqual({ deleted: true });
    const res = await fetch(`${WAGGLE}/api/schedules/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("読めない cron と短すぎる周期は 400 で、頼みの中身は始める口と同じ文で断る", async () => {
    const bad = await post("/api/schedules", {
      name: nameOf(),
      cron: "61 4 * * *",
      request: REQUEST,
    });
    expect(bad.status).toBe(400);
    expect(bad.body["error"]).toBe("invalid cron");

    const often = await post("/api/schedules", {
      name: nameOf(),
      cron: "*/5 * * * *",
      request: REQUEST,
    });
    expect(often.status).toBe(400);
    expect(often.body["error"]).toBe("cron runs too often");

    const refused = await post("/api/schedules", {
      name: nameOf(),
      cron: "0 4 * * *",
      request: { seeds: ["not a url"], scripts: [] },
    });
    expect(refused.status).toBe(400);
    expect(refused.body["error"]).toBe("every seed must be an http(s) URL");
  });

  it("同じ名前は 409", async () => {
    const name = nameOf();
    await create(name);
    const again = await post("/api/schedules", { name, cron: "0 4 1 1 *", request: REQUEST });
    expect(again.status).toBe(409);
  });
});
