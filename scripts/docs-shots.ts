/**
 * docs のスクリーンショットを撮り直す。
 *
 * docs-site/src/assets/windmill-ui/ の PNG は全部この script の生成物で、
 * 手で撮った絵は 1 枚も無い。スクリーンショットは UI の書き写しで、
 * **書き写しは腐る** —— だから撮影条件 (版・viewport・ルート・前提) を
 * shots-manifest.json に台帳化し、check-doc-refs が「compose の Windmill の
 * pin と manifest の版が一致すること」を CI で検める。compose を上げたら
 * この script を回し直すこと。
 *
 * 前提 (無いと途中で止まる):
 *   1. スタックが起動していること (container-compose up -d)
 *   2. workspace crawler が bootstrap 済みで、run 履歴に次の 2 本があること:
 *        - f/waggle/crawl_level の成功
 *        - report_level の失敗 (内容は履歴次第。今日の実物は POST /pages → 500)
 *      無ければ quickstart の手順で 1 本流す。失敗は waggle_api_url を一時的に
 *      曲げると再現できる (2026-09-11 に実際に起きた形)。run の ID は API から
 *      拾うので直書きは無い。
 *
 *   pnpm run docs:shots                # CI では走らせない —— 実機が要る
 *
 * 実装で分かった UI の癖 (2026-09-11、CE v1.806.0 実測):
 *   - workspace は URL に入らない (「/w/crawler/runs」は SPA が 404 を返す)。
 *     選択は localStorage に保存されるので、cookie では固定できない ——
 *     /user/workspaces で「crawler」を **クリックして** から各ルートへ行く
 *   - networkidle だけでは SPA の白い絵が撮れる。ルートごとに「その画面に
 *     しか出ない文字列」を待つ
 *
 * 07 (crawl_host が proto の resource を見つけられない失敗) と 13 (Resources の States タブ) は
 * BrowserHive v12 で proto の配布が無くなったので撮らない。番号は詰めない —— docs の
 * import と manifest が名前で結び付いているので、詰めると全部を書き換えることになる。
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer, { type Page } from "puppeteer";
import { repoRoot } from "./env.js";

// **`import.meta.url` から辿らない。** この script は `dist/scripts/` から走るので、
// そこから 1 つ上は `dist/` —— PNG を `dist/docs-site/...` に書こうとして ENOENT で
// 落ちた (TypeScript 化のあと最初に撮り直した 2026-09-12 に実測)。他の script と
// 同じく、`pnpm run` の cwd = repo root を使う。
const ROOT = repoRoot();
const OUT = resolve(ROOT, "docs-site/src/assets/windmill-ui");
const BASE = process.env["WINDMILL_URL"] ?? "http://127.0.0.1:8000";
const EMAIL = process.env["WINDMILL_EMAIL"] ?? "admin@windmill.dev";
const PASSWORD = process.env["WINDMILL_PASSWORD"] ?? "changeme";
const WORKSPACE = "crawler";
const VIEWPORT = { width: 1360, height: 850, deviceScaleFactor: 1 };

/** compose の pin。manifest はここから写す —— 手書きすると版の検査が嘘になる。 */
const composePin = () => {
  const compose = readFileSync(resolve(ROOT, "docker-compose.yml"), "utf8");
  const m = /windmill-labs\/windmill:(\d+\.\d+\.\d+)/.exec(compose);
  if (!m) throw new Error("docker-compose.yml に windmill の pin が見つからない");
  return m[1];
};

const login = async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const token = await res.text();
  if (!res.ok || token === "") throw new Error(`login が失敗: ${String(res.status)}`);
  return token;
};

/** Windmill の job 一覧のうち、この script が見る分だけ。 */
interface CompletedJob {
  id: string;
  script_path?: string;
  success?: boolean;
}

/** 教材にする 3 本の run の ID。撮影の前提が揃っているかの検査でもある。 */
interface TeachingRuns {
  /** crawl_level の成功 */
  flowOk: string;
  /** report_level の失敗 */
  reportFail: string;
  /** report_level の成功 (段の詳細を見せる用) */
  stepOk: string;
}

/** 教材の run を API から探す。ID を直書きすると再撮影のたびに嘘になる。 */
const findTeachingRuns = async (token: string): Promise<TeachingRuns> => {
  const res = await fetch(`${BASE}/api/w/${WORKSPACE}/jobs/completed/list?per_page=100`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const rows = (await res.json()) as CompletedJob[];
  const picks: Partial<TeachingRuns> = {};
  for (const j of rows) {
    const p = j.script_path ?? "";
    if (p === "f/waggle/crawl_level" && j.success && !picks.flowOk) picks.flowOk = j.id;
    if (p.endsWith("report_level") && !j.success && !picks.reportFail) picks.reportFail = j.id;
    if (p.endsWith("report_level") && j.success && !picks.stepOk) picks.stepOk = j.id;
  }
  for (const key of ["flowOk", "reportFail", "stepOk"] as const) {
    if (picks[key] === undefined) {
      throw new Error(
        `run 履歴に ${key} が無い —— このファイル冒頭の「前提」を見て作ってから撮り直すこと`,
      );
    }
  }
  // 上のループが 3 つとも揃っていることを確かめた後。型はそれを追えないので
  // ここだけ言い切る —— 検査を通り抜けた時点で Partial ではない。
  return picks as TeachingRuns;
};

/**
 * 描画の証拠を待つ。networkidle だけでは SPA の白い絵が撮れる (実測) ので、
 * 「その画面にしか出ない文字列」が現れるまで待つ。
 */
const waitForText = async (page: Page, text: string): Promise<void> => {
  await page.waitForFunction(
    (t: string) => document.body !== null && document.body.innerText.includes(t),
    { timeout: 30_000 },
    text,
  );
  // 文字が出た後も一覧・グラフの描画が続く。固定の短い settle を置く。
  await new Promise((r) => setTimeout(r, 1500));
};

/**
 * `text` を含む要素まで scroll する。run 詳細のエラーパネルや flow の段グラフは
 * fold の下に居るので、ヘッダだけの絵にならないように目印まで下げる。
 */
const scrollToText = async (page: Page, text: string): Promise<void> => {
  await page.evaluate((t: string) => {
    const all = [...document.querySelectorAll<HTMLElement>("div, span, p, pre, h2, h3")];
    const el = all.find(
      (e) => e.childElementCount === 0 && e.innerText !== undefined && e.innerText.includes(t),
    );
    if (el !== undefined) el.scrollIntoView({ block: "center" });
  }, text);
  await new Promise((r) => setTimeout(r, 800));
};

/** innerText が `text` から始まる button / link をクリックする。 */
const clickByText = async (page: Page, text: string): Promise<void> => {
  const clicked = await page.evaluate((t: string) => {
    const el = [...document.querySelectorAll<HTMLElement>("button, a, div[role=button]")].find(
      (e) => e.innerText !== undefined && e.innerText.trim().startsWith(t),
    );
    if (el === undefined) return false;
    el.click();
    return true;
  }, text);
  if (!clicked) throw new Error(`「${text}」というボタンが見つからない`);
};

const main = async () => {
  const token = await login();
  const runs = await findTeachingRuns(token);
  mkdirSync(OUT, { recursive: true });

  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  const shoot = async (file: string): Promise<void> => {
    await page.screenshot({ path: `${OUT}/${file}` });
    console.log(file);
  };

  // ① ログイン画面だけは未認証で撮る
  await page.goto(`${BASE}/user/login`, { waitUntil: "networkidle2" });
  await waitForText(page, "Log in to Windmill");
  await shoot("01-login.png");

  // 以降は cookie で認証する。UI は token cookie を読む
  await browser.setCookie({ name: "token", value: token, domain: "127.0.0.1", path: "/" });

  // ② workspace の選択画面。ここで crawler をクリックすると localStorage に
  //    保存され、以降のルートが workspace 抜きの URL で開けるようになる
  await page.goto(`${BASE}/user/workspaces`, { waitUntil: "networkidle2" });
  await waitForText(page, "Select a workspace");
  await shoot("02-workspaces.png");
  await clickByText(page, WORKSPACE);
  await waitForText(page, "Home");

  // ③ ホーム (workspace 選択直後の遷移先 = "/")
  await waitForText(page, "waggle");
  await shoot("03-home.png");

  const shots = [
    { file: "04-runs-list.png", route: "/runs", wait: "crawl_level" },
    // run 詳細はヘッダだけだと何も教えない。flow は段グラフまで、失敗は
    // エラーパネルまで scroll してから撮る
    {
      file: "05-run-flow.png",
      route: `/run/${runs.flowOk}`,
      wait: "crawl_host",
      scrollTo: "crawl_host",
    },
    { file: "06-run-step.png", route: `/run/${runs.stepOk}`, wait: "report_level" },
    {
      file: "08-run-error-report.png",
      route: `/run/${runs.reportFail}`,
      wait: "Failed after",
      scrollTo: "Result",
    },
    {
      file: "09-flow-detail.png",
      route: "/flows/get/f%2Fwaggle%2Fcrawl_level",
      wait: "crawl_host",
    },
    {
      file: "10-script-form.png",
      route: "/scripts/get/f%2Fwaggle%2Fcrawl_host",
      wait: "crawl_host",
    },
    { file: "11-schedules.png", route: "/schedules", wait: "trigger_crawl" },
    { file: "12-variables.png", route: "/variables", wait: "waggle_token" },
    // 手で 1 回起こす入口。Run のフォームは get ページの中に居る
    {
      file: "14-trigger-script.png",
      route: "/scripts/get/f%2Fwaggle%2Ftrigger_crawl",
      wait: "trigger_crawl",
    },
  ];

  for (const s of shots) {
    await page.goto(`${BASE}${s.route}`, { waitUntil: "networkidle2" });
    await waitForText(page, s.wait);
    if (s.scrollTo !== undefined) await scrollToText(page, s.scrollTo);
    await shoot(s.file);
  }

  await browser.close();

  const manifest = {
    windmillVersion: composePin(),
    viewport: VIEWPORT,
    takenAt: new Date().toISOString(),
    prerequisites: [
      "スタックが起動していること",
      "run 履歴に crawl_level の成功が 1 本あること",
      "run 履歴に report_level の失敗が 1 本あること",
    ],
    shots: ["01-login.png", "02-workspaces.png", "03-home.png", ...shots.map((s) => s.file)],
  };
  writeFileSync(`${OUT}/shots-manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`shots-manifest.json (windmill ${manifest.windmillVersion})`);
};

await main();
