// src/upload/client.ts
import type { Results } from "../report/results";

export interface UploadTarget { url: string; project: string }
export interface UploadResult { runId: number; url: string; sent: number; skipped: number }
export class UploadError extends Error {}
export interface UploadOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
  retries?: number;
}

/** Strip trailing slashes from the base so a path prefix (a server mounted
 * under /momus) survives and no `//` appears in the joined URL. */
export function apiUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

/** Every distinct image hash the document references, across all three sides. */
function documentHashes(results: Results): Set<string> {
  const out = new Set<string>();
  for (const c of results.comparisons) {
    for (const img of [c.dev.image, c.prod.image, c.diff.image]) if (img) out.add(img.sha256);
  }
  return out;
}

export async function uploadResults(
  target: UploadTarget,
  results: Results,
  images: Map<string, Uint8Array>,
  opts: UploadOptions = {},
): Promise<UploadResult> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const concurrency = opts.concurrency ?? 4;
  const retries = opts.retries ?? 3;

  /** Retries only network errors and 5xx: a 4xx means the request itself is
   * wrong, and repeating it cannot help. Returns the response for any status
   * the caller wants to interpret itself (listed in `accept`). */
  async function request(method: string, path: string, init: RequestInit, accept: number[] = []): Promise<Response> {
    let lastErr = "";
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));
      let res: Response;
      try {
        res = await doFetch(apiUrl(target.url, path), { ...init, method });
      } catch (e) {
        lastErr = `network error: ${e instanceof Error ? e.message : String(e)}`;
        continue;
      }
      if (res.ok || accept.includes(res.status)) return res;
      const body = (await res.text().catch(() => "")).slice(0, 200);
      if (res.status >= 500) {
        lastErr = `HTTP ${res.status}: ${body}`;
        continue;
      }
      throw new UploadError(`${method} ${path}: HTTP ${res.status}: ${body}`);
    }
    throw new UploadError(`${method} ${path}: ${lastErr}`);
  }

  const readJson = async <T>(res: Response, method: string, path: string): Promise<T> => {
    try {
      return (await res.json()) as T;
    } catch {
      throw new UploadError(`${method} ${path}: response was not valid JSON`);
    }
  };

  let sent = 0;
  async function putAll(hashes: string[]): Promise<void> {
    const distinct = [...new Set(hashes)];
    for (const h of distinct) {
      if (!images.has(h)) throw new UploadError(`server asked for image ${h} but it is not available locally`);
    }
    let next = 0;
    const worker = async () => {
      while (next < distinct.length) {
        const h = distinct[next++]!;
        await request("PUT", `/api/images/${h}`, { headers: { "content-type": "image/png" }, body: images.get(h)! as unknown as BodyInit });
        sent++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, distinct.length) }, worker));
  }

  const runsPath = `/api/projects/${encodeURIComponent(target.project)}/runs`;
  const created = await readJson<{ runId: number; url: string; missing: string[] }>(
    await request("POST", runsPath, { headers: { "content-type": "application/json" }, body: JSON.stringify(results) }),
    "POST", runsPath,
  );
  await putAll(created.missing);

  const completePath = `/api/runs/${created.runId}/complete`;
  let res = await request("POST", completePath, {}, [409]);
  if (res.status === 409) {
    // Another writer or a lost PUT left holes; one top-up pass, then give up
    // rather than loop against a server that keeps losing images.
    const { missing } = await readJson<{ missing: string[] }>(res, "POST", completePath);
    await putAll(missing);
    res = await request("POST", completePath, {}, [409]);
    if (res.status === 409) throw new UploadError(`POST ${completePath}: HTTP 409: server still reports missing images`);
  }
  const done = await readJson<{ runId: number; url: string }>(res, "POST", completePath);
  return { runId: done.runId, url: done.url, sent, skipped: documentHashes(results).size - sent };
}
