/**
 * Windmill の run の引数を、flow の木ごと読む。
 *
 * 「値が Windmill の履歴に残っていない」を言うには、flow の job 1 つでは足りない —— for-loop の各回
 * (`flow_jobs`)、その中の段 (`cap` = crawl_host)、失敗の段まで、それぞれが自分の `args` を持つ。
 * `jobs_u/get/:id` の `flow_status.modules[]` を辿って全部集める。
 */
import { json } from "./stack.js";

export interface JobArgs {
  id: string;
  path: string | null;
  args: unknown;
}

interface Module {
  job?: string;
  flow_jobs?: string[];
}

interface Job {
  script_path?: string | null;
  args?: unknown;
  flow_status?: { modules?: Module[]; failure_module?: Module } | null;
}

export const jobArgsTree = async (
  rootId: string,
  { windmill, workspace, token }: { windmill: string; workspace: string; token: string },
): Promise<JobArgs[]> => {
  const headers = { authorization: `Bearer ${token}` };
  const seen = new Set<string>();
  const out: JobArgs[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const res = await fetch(`${windmill}/api/w/${workspace}/jobs_u/get/${id}`, { headers });
    if (!res.ok) throw new Error(`jobs_u/get/${id} → ${String(res.status)} ${await res.text()}`);
    const job = (await json(res)) as Job;
    out.push({ id, path: job.script_path ?? null, args: job.args });
    const modules = [
      ...(job.flow_status?.modules ?? []),
      ...(job.flow_status?.failure_module === undefined ? [] : [job.flow_status.failure_module]),
    ];
    for (const module of modules) {
      if (typeof module.job === "string") queue.push(module.job);
      for (const child of module.flow_jobs ?? []) queue.push(child);
    }
  }
  return out;
};
