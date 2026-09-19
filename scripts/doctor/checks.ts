/**
 * doctor の点検 13 本 (e2e のときは 15 本)。**クイックスタートの手の順に並べてある。**
 *
 * 1 本ずつ「クイックスタートのどの手が済んでいるか」を、その手が作るものに訊く。立っているか
 * だけでなく、**クロールが最後まで走る設定か**まで見る —— 外れていても、API に POST すれば
 * 202 が返り、flow も走り、段の報告か、ページを撮るところで初めて落ちる。報告が届かなければ
 * クロールは `running` のまま残り、以後の起動は全部 409 になる。
 *
 * **どれも、正しい設定と誤った設定で答えが変わる入力を使う。** たとえば jwt を「ヘッダで
 * 名乗ると 401」で見ると、名乗りの口がどちらも無い API も 401 で通ってしまう。だから issuer
 * から token を取り、それが 200 になることを見る。push は在るかでなく中身を比べ、変数は
 * flow が読むその値で宛先を叩く。
 *
 * 読み分けは入出力を持たない module に分けてある (`windmill-contents.ts`・`worker-probes.ts`・
 * `jwt-check.ts`・`can-submit.ts`)。ここは答えを取ってくるだけ。
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import {
  ledgerApiUrl,
  ledgerIssuer,
  optional,
  repoRoot,
  windmillUrl,
  windmillWorkspace,
} from "../env.js";
import { readCanSubmit } from "./can-submit.js";
import { readJwt } from "./jwt-check.js";
import { runChecks, type Check, type Outcome, type Result, type Verdict } from "./run.js";
import { SECTIONS } from "./sections.js";
import {
  readProto,
  readPush,
  readVariables,
  readWorkspace,
  VARIABLES,
  type Answer,
  type Deployed,
} from "./windmill-contents.js";
import {
  parseCurl,
  readBrowserhiveProbes,
  readContainerApi,
  type CurlAnswer,
} from "./worker-probes.js";

/** host から見た capture-ledger の API。smoke も同じ口を叩く。 */
export const API = "http://127.0.0.1:7070";
/** capture-ledger の開発のスタックの OpenFGA。鍵はクイックスタートの前提と同じ。 */
const OPENFGA = "http://127.0.0.1:8090";
const ISSUER = ledgerIssuer();
/** flow が走るコンテナ。段の報告も BrowserHive への呼び出しもここから出る。 */
const WORKER = "windmill-worker.capture-scheduler";
/** e2e の試験が名乗る名前 (`test/e2e/crawl-level.e2e.test.ts` と同じ既定)。 */
const E2E_SUBJECT = optional("E2E_SUBJECT", "e2e");

const exec = promisify(execFile);

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 応答の status と本文。届かなければ status は undefined。 */
const answerOf = async (url: string, init: RequestInit = {}): Promise<Answer> => {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(3000) });
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: undefined, body: "" };
  }
};

const parse = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

/** HTTP の答えが返ること自体が待ち受けの証拠。405 でも 401 でもよい。 */
const answers = async (url: string): Promise<boolean> => (await answerOf(url)).status !== undefined;

const portOpen = (host: string, port: number): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(3000);
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    socket.on("timeout", () => done(false));
  });

/** 答えたら ✓、答えなければ `need`。 */
const up = async (url: string, need: string): Promise<Verdict> =>
  (await answers(url)) ? { ok: true } : { ok: false, need };

/** Windmill の API を、この repo の `.env` の WINDMILL_TOKEN で叩く。 */
const windmill = (path: string, init: RequestInit = {}): Promise<Answer> =>
  answerOf(`${windmillUrl()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env["WINDMILL_TOKEN"] ?? ""}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
  });

const inWorkspace = (path: string): string => `/api/w/${windmillWorkspace()}/${path}`;

/** Windmill の変数の値。無い・読めないときは undefined。 */
const variable = async (path: string): Promise<string | undefined> => {
  const answer = await windmill(inWorkspace(`variables/get_value/${path}`));
  const value = answer.status === 200 ? parse(answer.body) : undefined;
  return typeof value === "string" ? value : undefined;
};

/** 変数が読めなかったときの 1 行。「変数」の点検が ✓ の後なので、ふつうは起きない。 */
const unreadable = (path: string): Verdict => ({
  ok: false,
  need: `Windmill の変数 ${path} が読めない → pnpm run windmill:capture-ledger-token`,
});

/**
 * worker の中で curl を走らせる。**同期で呼ばないこと。** 点検は並べて走らせるので、
 * execFileSync で待つと、届かない宛先の秒数のあいだ event loop が止まり、隣の点検の
 * 期限が先に切れて、そちらまで ✗ になった (実測)。
 */
const curlInWorker = async (
  url: string,
  seconds: number,
  extra: readonly string[] = [],
): Promise<CurlAnswer | { error: string }> => {
  const args = ["exec", WORKER, "curl", "-s", "-o", "/dev/null", "-w", "%{http_code} %{exitcode}"];
  try {
    const { stdout } = await exec(
      "container",
      [...args, "--max-time", String(seconds), ...extra, url],
      { encoding: "utf8" },
    );
    return parseCurl(stdout) ?? { error: stdout.trim() };
  } catch (err) {
    // curl が 0 以外で終わると container exec も同じ rc で終わる。答えは標準出力に在る。
    const { stdout = "", stderr = "" } = err as { stdout?: string; stderr?: string };
    return parseCurl(stdout) ?? { error: (stderr || messageOf(err)).trim() };
  }
};

const workerUnreachable = (error: string): Verdict => ({
  ok: false,
  need: `worker のコンテナに入れない (${error.slice(0, 200)}) → この repo で container-compose up -d`,
});

// ── 立ち上げる: Windmill の中身 ───────────────────────────────────────

const workspaceReady = async (): Promise<Verdict> => {
  const workspace = windmillWorkspace();
  if ((process.env["WINDMILL_TOKEN"] ?? "") === "") {
    return {
      ok: false,
      need: "WINDMILL_TOKEN が .env に無い → pnpm run windmill:bootstrap の WINDMILL_TOKEN=… を貼る",
    };
  }
  const whoami = await windmill(inWorkspace("users/whoami"));
  const me = whoami.status === 200 ? parse(whoami.body) : undefined;
  const nonMember = typeof me === "object" && me !== null && "non_member" in me && me.non_member;
  if (nonMember !== true) return readWorkspace({ workspace, whoami });
  const exists = await windmill("/api/workspaces/exists", {
    method: "POST",
    body: JSON.stringify({ id: workspace }),
  });
  return readWorkspace({ workspace, whoami, exists: parse(exists.body) === true });
};

/** repo の `windmill/` から、push が入れるものを拾う。名前の一覧を別に持つと腐る。 */
const pushedItems = (): { path: string; kind: Deployed["kind"]; file?: string }[] => {
  const root = join(repoRoot(), "windmill");
  const items: { path: string; kind: Deployed["kind"]; file?: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const at = relative(root, full);
      if (entry.isDirectory() && entry.name.endsWith(".flow")) {
        items.push({ path: at.replace(/\.flow$/, ""), kind: "flow" });
      } else if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".script.yaml")) {
        const path = at.replace(/\.script\.yaml$/, "");
        items.push({ path, kind: "script", file: join(root, `${path}.ts`) });
      } else if (entry.name.endsWith(".schedule.yaml")) {
        items.push({ path: at.replace(/\.schedule\.yaml$/, ""), kind: "schedule" });
      }
    }
  };
  walk(join(root, "f"));
  return items.sort((a, b) => a.path.localeCompare(b.path));
};

const pushed = async (): Promise<Verdict> => {
  const failures: string[] = [];
  const deployed = await Promise.all(
    pushedItems().map(async ({ path, kind, file }): Promise<Deployed> => {
      if (kind === "script" && file !== undefined) {
        const answer = await windmill(inWorkspace(`scripts/get/p/${path}`));
        const script = answer.status === 200 ? parse(answer.body) : undefined;
        const content =
          typeof script === "object" && script !== null && "content" in script
            ? script.content
            : undefined;
        if (answer.status !== 404 && typeof content !== "string") {
          failures.push(`scripts/get/p/${path} → ${String(answer.status)}`);
        }
        const windmillContent = typeof content === "string" ? content : undefined;
        return {
          path,
          kind,
          exists: windmillContent !== undefined,
          content: { repo: readFileSync(file, "utf8"), windmill: windmillContent },
        };
      }
      const answer = await windmill(inWorkspace(`${kind}s/exists/${path}`));
      if (answer.status !== 200)
        failures.push(`${kind}s/exists/${path} → ${String(answer.status)}`);
      return { path, kind, exists: parse(answer.body) === true };
    }),
  );
  if (failures.length > 0)
    return { ok: false, need: `Windmill に訊けない: ${failures.join("・")}` };
  return readPush(deployed);
};

const protoMatches = async (): Promise<Verdict> =>
  readProto(
    await windmill(inWorkspace("resources/get_value/u/admin/browserhive_proto")),
    readFileSync(join(repoRoot(), "proto", "browserhive", "v1", "capture.proto"), "utf8"),
  );

// ── 立ち上げる: capture-ledger ─────────────────────────────────────────

/** issuer が名乗る iss。discovery から読む —— need に出す値を決め打ちしない。 */
const issuerName = async (): Promise<string> => {
  const { status, body } = await answerOf(`${ISSUER}/.well-known/openid-configuration`);
  const discovery = status === 200 ? parse(body) : undefined;
  return typeof discovery === "object" &&
    discovery !== null &&
    "issuer" in discovery &&
    typeof discovery.issuer === "string"
    ? discovery.issuer
    : ISSUER;
};

/** issuer からトークンを取る。取れなければ undefined。 */
const mint = async (subject: string): Promise<string | undefined> => {
  const { status, body } = await answerOf(`${ISSUER}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject, organizations: ["acme"], expiresIn: "5m" }),
  });
  const token = status === 200 ? parse(body) : undefined;
  return typeof token === "object" &&
    token !== null &&
    "access_token" in token &&
    typeof token.access_token === "string"
    ? token.access_token
    : undefined;
};

/**
 * issuer から token を取り、Bearer で一覧を読む。**200 になるのは JWT を受ける API だけ** ——
 * ヘッダの設定の API も、どちらの口も無い API も 401 を返す。拒まれたら、同じ API にヘッダで
 * `GET /api/me` を訊き、どちらなのかを `jwt-check.ts` が読み分ける。
 */
const acceptsJwt = async (): Promise<Verdict> => {
  const token = await mint("doctor");
  if (token === undefined) return readJwt({ token: "no-token", iss: ISSUER });
  const { status } = await answerOf(`${API}/api/archives`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (status !== 401) return readJwt({ token: status, iss: ISSUER });
  const header = await answerOf(`${API}/api/me`, {
    headers: { "x-capture-ledger-subject": "doctor", "x-capture-ledger-organizations": "acme" },
  });
  return readJwt({ token: status, header, iss: await issuerName() });
};

// ── windmill にクロールを許可する ──────────────────────────────────────

/**
 * flow のトークン (変数 `u/admin/waggle_token`) で、クロールを起こせるかを capture-ledger に訊く。
 *
 * **flow が実際に使うトークンで訊く**のが要点 —— 許可が無いことも、トークンが古いことも、
 * 名前が docs とずれていることも、flow が 404 や 401 を踏む前にここで分かる。
 */
const flowCanSubmit = async (): Promise<Verdict> => {
  const token = await variable("u/admin/waggle_token");
  if (token === undefined || token === "") return unreadable("u/admin/waggle_token");
  const { status, body } = await answerOf(`${API}/api/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return readCanSubmit(status, body);
};

// ── 鍵を渡す: 変数と、そこから届くか ─────────────────────────────────

const variablesSet = async (): Promise<Verdict> => {
  const answers = await Promise.all(
    VARIABLES.map(
      async (path) => [path, await windmill(inWorkspace(`variables/exists/${path}`))] as const,
    ),
  );
  const failed = answers.filter(([, answer]) => answer.status !== 200);
  if (failed.length > 0) {
    return {
      ok: false,
      need: `Windmill に訊けない: ${failed.map(([path, a]) => `${path} → ${String(a.status)}`).join("・")}`,
    };
  }
  return readVariables(
    new Map(answers.map(([path, answer]) => [path, parse(answer.body) === true])),
  );
};

/** いまの gateway から組んだ宛先。`container network inspect` が失敗すれば undefined。 */
const expectedApiUrl = async (): Promise<string | undefined> => {
  try {
    const { stdout } = await exec("container", ["network", "inspect", "default"], {
      encoding: "utf8",
    });
    return ledgerApiUrl(() => stdout);
  } catch {
    return undefined;
  }
};

/**
 * flow が段の報告を送る宛先 (変数 `u/admin/waggle_api_url`) に、worker の中から届くか。
 *
 * 変数を読むのは、**flow が実際に使うのはそちら**だから —— いま gateway を計算し直しても、
 * 変数に古い IP が入っていれば報告は届かない。
 */
const containerReachesApi = async (): Promise<Verdict> => {
  const url = await variable("u/admin/waggle_api_url");
  if (url === undefined) return unreadable("u/admin/waggle_api_url");
  const [answer, expected] = await Promise.all([
    curlInWorker(`${url}/healthz`, 5),
    expectedApiUrl(),
  ]);
  if ("error" in answer) return workerUnreachable(answer.error);
  return readContainerApi({ url, answer, expected });
};

/**
 * BrowserHive の口 (変数 `u/admin/browserhive_endpoints`) に、worker の中から届くか。
 * 口は browser 1 台に 1 つなので、全部を並べて叩き、落ちている口を名指しする。
 */
const workerReachesBrowserhive = async (): Promise<Outcome> => {
  const [list, ca] = await Promise.all([
    variable("u/admin/browserhive_endpoints"),
    variable("u/admin/browserhive_tls_ca"),
  ]);
  if (list === undefined) return unreadable("u/admin/browserhive_endpoints");
  // TLS の口に平文の HTTP/2 で訊いても、答えの読み方を実測していない。推測で ✓ も ✗ も出さない。
  if (ca !== undefined && ca !== "") {
    return { skipped: "TLS の口は見ない (u/admin/browserhive_tls_ca に CA が入っている)" };
  }
  const endpoints = parse(list);
  if (!Array.isArray(endpoints) || !endpoints.every((e) => typeof e === "string")) {
    return {
      ok: false,
      need: `変数 u/admin/browserhive_endpoints が文字列の配列でない (${list.slice(0, 100)}) → pnpm run windmill:capture-ledger-token`,
    };
  }
  const answers = await Promise.all(
    endpoints.map((endpoint: string) =>
      curlInWorker(`http://${endpoint}/`, 3, ["--http2-prior-knowledge"]),
    ),
  );
  const probes: { endpoint: string; answer: CurlAnswer }[] = [];
  for (const [i, answer] of answers.entries()) {
    if ("error" in answer) return workerUnreachable(answer.error);
    probes.push({ endpoint: String(endpoints[i]), answer });
  }
  return readBrowserhiveProbes(probes);
};

// ── e2e ────────────────────────────────────────────────────────────────

/** e2e の試験が名乗る名前に、クロールの許可があるか。 */
const e2eCanSubmit = async (): Promise<Verdict> => {
  const token = await mint(E2E_SUBJECT);
  if (token === undefined) return readJwt({ token: "no-token", iss: ISSUER });
  const { status, body } = await answerOf(`${API}/api/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  // 401 は jwt の点検 (親) が ✓ の後なので起きないはずだが、起きたら Windmill のトークンの話ではない。
  if (status === 401) return { ok: false, need: `issuer の新しい ${E2E_SUBJECT} のトークンが 401` };
  return readCanSubmit(status, body);
};

export const CHECKS: readonly (Check & { e2eOnly?: true })[] = [
  {
    name: "openfga",
    section: SECTIONS.prerequisites,
    where: `GET ${OPENFGA}/stores (鍵 dev-key)`,
    probe: async () => {
      const { status } = await answerOf(`${OPENFGA}/stores`, {
        headers: { authorization: "Bearer dev-key" },
      });
      if (status === 200) return { ok: true };
      if (status === undefined) {
        return {
          ok: false,
          need: "OpenFGA が答えない → cd ../capture-ledger && pnpm run stack:up",
        };
      }
      return { ok: false, need: `GET /stores → ${String(status)} (鍵が dev-key でない?)` };
    },
  },
  {
    name: "windmill",
    section: SECTIONS.bringUp,
    where: `${windmillUrl()}/api/version`,
    probe: () =>
      up(
        `${windmillUrl()}/api/version`,
        "Windmill が答えない → この repo で container-compose up -d",
      ),
  },
  {
    name: "workspace",
    section: SECTIONS.bringUp,
    where: `${windmillWorkspace()} に WINDMILL_TOKEN で入れるか`,
    needs: ["windmill"],
    probe: workspaceReady,
  },
  {
    name: "push",
    section: SECTIONS.bringUp,
    where: "script の中身が repo と同じか・flow と schedule が在るか",
    needs: ["workspace"],
    probe: pushed,
  },
  {
    name: "proto",
    section: SECTIONS.bringUp,
    where: "u/admin/browserhive_proto が repo の capture.proto と同じか",
    needs: ["workspace"],
    probe: protoMatches,
  },
  {
    name: "capture-ledger api",
    section: SECTIONS.bringUp,
    where: `${API}/healthz`,
    probe: () =>
      up(
        `${API}/healthz`,
        "capture-ledger の API が答えない → cd ../capture-ledger && pnpm run api",
      ),
  },
  {
    name: "oidc issuer",
    section: SECTIONS.bringUp,
    where: `${ISSUER}/.well-known/openid-configuration`,
    probe: () =>
      up(
        `${ISSUER}/.well-known/openid-configuration`,
        "issuer が答えない → cd ../capture-ledger && pnpm run oidc:issuer (動かし続ける)",
      ),
  },
  {
    name: "crawl route",
    section: SECTIONS.bringUp,
    where: `POST ${API}/api/crawls {} (名乗らずに 401 なら在る)`,
    needs: ["capture-ledger api"],
    // 本文を付けること。付けないと、名乗りを見る前に body の検査が 400 を返す (実測)。
    probe: async () => {
      const { status } = await answerOf(`${API}/api/crawls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (status === 401) return { ok: true };
      return {
        ok: false,
        need:
          `POST /api/crawls → ${String(status)}。404 なら route ごと無い → capture-ledger の .env に ` +
          "CAPTURE_LEDGER_CRAWL_WEBHOOK_URL と _TOKEN (windmill:bootstrap が出す 2 行) を書いて API を起こし直す",
      };
    },
  },
  {
    name: "jwt",
    section: SECTIONS.bringUp,
    where: `issuer のトークンで GET ${API}/api/archives`,
    needs: ["capture-ledger api", "oidc issuer"],
    probe: acceptsJwt,
  },
  {
    name: "変数",
    section: SECTIONS.handOver,
    where: VARIABLES.map((path) => path.replace("u/admin/", "")).join("・"),
    needs: ["workspace"],
    probe: variablesSet,
  },
  {
    name: "container→api",
    section: SECTIONS.handOver,
    where: "worker の中から、u/admin/waggle_api_url の /healthz",
    needs: ["変数", "capture-ledger api"],
    probe: containerReachesApi,
  },
  {
    name: "worker→browserhive",
    section: SECTIONS.handOver,
    where: "worker の中から、u/admin/browserhive_endpoints の口ごとに HTTP/2",
    needs: ["変数"],
    probe: workerReachesBrowserhive,
  },
  {
    name: "can_submit",
    section: SECTIONS.grant,
    where: `flow のトークンで GET ${API}/api/me (クロールを起こせるか)`,
    // jwt の後に訊く —— issuer を起こし直した後、jwt の新しいトークンが API に鍵を取り直させる。
    // 先に flow の古いトークンが着くと、同じ状態で ✓ と ✗ が入れ替わる (古いトークンは、API が
    // 取り直すまで通る)。
    needs: ["jwt", "変数", "openfga"],
    probe: flowCanSubmit,
  },
  {
    name: "capture-fixtures",
    section: SECTIONS.e2e,
    where: "capture-fixtures.capture-ledger:8080",
    probe: async () =>
      (await portOpen("capture-fixtures.capture-ledger", 8080))
        ? { ok: true }
        : {
            ok: false,
            need:
              "capture-fixtures が待っていない → " +
              "cd ../capture-ledger && container-compose --profile capture-fixtures up -d -b",
          },
    e2eOnly: true,
  },
  {
    name: `${E2E_SUBJECT} の許可`,
    section: SECTIONS.e2e,
    where: `issuer の ${E2E_SUBJECT} のトークンで GET ${API}/api/me`,
    needs: ["jwt", "openfga"],
    probe: e2eCanSubmit,
    e2eOnly: true,
  },
];

/** smoke からも呼ぶ。`e2e` のときだけ、e2e の試験が要るものも見る。 */
export const runDoctor = ({ e2e = false }: { e2e?: boolean } = {}): Promise<Result[]> =>
  runChecks(CHECKS.filter((check) => e2e || check.e2eOnly !== true));
