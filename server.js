// One brief, four image models, four prices.
//
// Every paid call goes through the TaskFuel gateway, which pays the upstream
// and bills your prepaid balance. You need one key, not four provider accounts.
// Docs: https://app.taskfuel.ai/building-apps.md

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const PORT = process.env.PORT || 3000;
const KEY = process.env.TASKFUEL_API_KEY;
const GATEWAY = "https://app.taskfuel.ai/v1/call";

// The four models the blog post gave the same brief to.
const MODELS = ["grok", "nano-banana", "gpt-image-2", "nano-banana-pro"];

// Guardrails. The key can spend the whole balance and nobody is watching at
// call time, so the limits live in the code. See "Spending safely" in
// https://app.taskfuel.ai/building-apps.md
const MAX_USD_PER_IMAGE = Number(process.env.MAX_USD_PER_IMAGE || 0.25);
const DAILY_BUDGET_USD = Number(process.env.DAILY_BUDGET_USD || 2.5);

// The gateway allows 60 requests/minute per key. Four models polling at once
// have to share that, so 8s each leaves plenty of room.
const POLL_INTERVAL_MS = 8000;

let spentToday = 0;
let budgetDay = new Date().toISOString().slice(0, 10);

function budgetLeft() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDay) {
    budgetDay = today;
    spentToday = 0;
  }
  return DAILY_BUDGET_USD - spentToday;
}

/** POST through the gateway. Returns the upstream body plus what it charged. */
async function gateway({ url, method = "POST", body, maxAmountUsd }) {
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, method, body, maxAmountUsd }),
  });

  const cost = Number(res.headers.get("x-taskfuel-cost") || 0);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const detail = data?.error || data?.message || text.slice(0, 200);
    const err = new Error(`gateway ${res.status}: ${detail}`);
    err.status = res.status;
    // The gateway tells you how long to wait. Honour it rather than guessing.
    err.retryAfterSeconds = Number(data?.retry_after_seconds) || 10;
    throw err;
  }
  return { data, cost };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Generate one image, then poll until the job finishes. */
async function generate(model, prompt) {
  if (budgetLeft() < MAX_USD_PER_IMAGE) {
    throw new Error(
      `daily budget of $${DAILY_BUDGET_USD.toFixed(2)} reached. Raise DAILY_BUDGET_USD to continue.`,
    );
  }

  // Paid. maxAmountUsd is a hard ceiling for this one call.
  // A 429 here is free (the gateway rate-limits before it pays), so retrying
  // costs nothing.
  let started;
  for (let attempt = 0; ; attempt++) {
    try {
      started = await gateway({
        url: `https://stablestudio.dev/api/generate/${model}/generate`,
        // Both spellings on purpose. The spec documents camelCase with a "1:1"
        // default, but a real job came back recording aspect_ratio 16:9, so
        // the camelCase key was ignored and the square brief was not honoured.
        // Sending both means whichever one it reads gets the right value.
        body: {
          prompt,
          aspectRatio: "1:1",
          aspect_ratio: "1:1",
          imageSize: "1K",
          image_size: "1K",
        },
        maxAmountUsd: MAX_USD_PER_IMAGE,
      });
      break;
    } catch (err) {
      if (err.status !== 429 || attempt >= 3) throw err;
      await sleep(err.retryAfterSeconds * 1000);
    }
  }

  spentToday += started.cost;

  const jobId = started.data?.jobId;
  if (!jobId) throw new Error(`no jobId in response: ${JSON.stringify(started.data).slice(0, 200)}`);

  // This image is now paid for, so from here a rate limit must never be
  // allowed to throw the result away: back off and keep polling instead.
  //
  // The gateway allows 60 requests per minute per key. Four models polling at
  // once means the interval has to leave room for all of them, so 8s gives
  // 4 x 7.5 = 30/min and keeps headroom for the generate calls.
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let job;
    try {
      const poll = await gateway({
        url: `https://stablestudio.dev/api/jobs/${jobId}`,
        method: "GET",
        maxAmountUsd: 0.01,
      });
      job = poll.data;
    } catch (err) {
      if (err.status === 429) {
        await sleep(err.retryAfterSeconds * 1000);
        continue;
      }
      throw err;
    }

    if (job?.status === "failed" || job?.status === "error" || job?.error) {
      throw new Error(job?.error || "generation failed");
    }
    // Don't match on the status string. The spec doesn't pin its values (the
    // live one is "complete", not the "completed" you would guess), so treat
    // a URL turning up in the result as the finish line instead.
    const url = findImageUrl(job?.result);
    if (url) return { url, cost: started.cost };
  }
  throw new Error(`timed out after 5 minutes. Paid $${started.cost.toFixed(2)}, job ${jobId}`);
}

/** The result shape is not pinned in the spec, so go looking for a URL. */
function findImageUrl(result) {
  if (!result) return null;
  if (typeof result === "string" && result.startsWith("http")) return result;
  if (Array.isArray(result)) {
    for (const item of result) {
      const found = findImageUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof result === "object") {
    for (const key of ["url", "imageUrl", "image_url", "output", "images", "data"]) {
      if (key in result) {
        const found = findImageUrl(result[key]);
        if (found) return found;
      }
    }
    for (const value of Object.values(result)) {
      const found = findImageUrl(value);
      if (found) return found;
    }
  }
  return null;
}

// In-memory job state, keyed by a local id. Lost on restart, which is fine:
// the browser just reports the job as gone and you run it again.
const jobs = new Map();

function sweepJobs() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) if (job.startedAt < cutoff) jobs.delete(id);
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function handle(req, res) {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const html = await readFile(new URL("./public/index.html", import.meta.url));
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(html);
  }

  if (req.method === "GET" && req.url === "/api/config") {
    return json(res, 200, { models: MODELS, hasKey: Boolean(KEY) });
  }

  // Start a generation and return immediately. Holding the request open for
  // the whole job does not survive a hosting proxy: Replit cuts it off after
  // its own timeout and hands the browser an HTML error page, which is what
  // "Unexpected token '<'" in the console actually is.
  if (req.method === "POST" && req.url === "/api/generate") {
    if (!KEY) {
      return json(res, 500, {
        error: "No TASKFUEL_API_KEY set. Add it in the Secrets tab, then hit Run again.",
      });
    }

    let payload = "";
    for await (const chunk of req) payload += chunk;

    let prompt, model;
    try {
      ({ prompt, model } = JSON.parse(payload));
    } catch {
      return json(res, 400, { error: "bad JSON" });
    }

    if (!prompt?.trim()) return json(res, 400, { error: "prompt is required" });
    if (!MODELS.includes(model)) return json(res, 400, { error: `unknown model: ${model}` });

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    jobs.set(id, { model, status: "working", startedAt: Date.now() });
    sweepJobs();

    // Deliberately not awaited. The browser polls /api/job/<id> instead.
    generate(model, prompt.trim())
      .then(({ url, cost }) => jobs.set(id, { model, status: "done", url, cost, startedAt: Date.now() }))
      .catch((err) =>
        jobs.set(id, { model, status: "error", error: String(err.message || err), startedAt: Date.now() }),
      );

    return json(res, 200, { id, model });
  }

  if (req.method === "GET" && req.url.startsWith("/api/job/")) {
    const job = jobs.get(req.url.slice("/api/job/".length));
    if (!job) return json(res, 404, { error: "unknown job" });
    return json(res, 200, job);
  }

  res.writeHead(404);
  res.end("not found");
}

// A generation takes minutes, so people reload the page while one is still in
// flight. That aborts the request, and an aborted request whose body is being
// read rejects. Unhandled, it takes the whole server down, so every path out
// of `handle` has to be caught here.
const server = createServer((req, res) => {
  req.on("error", () => {});
  res.on("error", () => {});

  handle(req, res).catch((err) => {
    if (err?.code === "ECONNRESET" || err?.message === "aborted") return; // client went away
    console.error("request failed:", err?.message || err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  });
});

server.on("clientError", (_err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

// Last line of defence. A demo that dies on a stray socket error is worse than
// one that logs it and keeps serving.
process.on("unhandledRejection", (err) => {
  console.error("unhandled rejection:", err?.message || err);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Image bench running on port ${PORT}`);
  if (!KEY) {
    console.log("  No TASKFUEL_API_KEY yet. Add one in the Secrets tab.");
    console.log("  Get a key at https://app.taskfuel.ai (first $5 is free).\n");
  } else {
    console.log(`  Budget: $${DAILY_BUDGET_USD.toFixed(2)}/day, $${MAX_USD_PER_IMAGE.toFixed(2)} max per image\n`);
  }
});
