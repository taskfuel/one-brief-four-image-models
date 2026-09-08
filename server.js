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
    throw new Error(`gateway ${res.status}: ${detail}`);
  }
  return { data, cost };
}

/** Generate one image, then poll until the job finishes. */
async function generate(model, prompt) {
  if (budgetLeft() < MAX_USD_PER_IMAGE) {
    throw new Error(
      `daily budget of $${DAILY_BUDGET_USD.toFixed(2)} reached. Raise DAILY_BUDGET_USD to continue.`,
    );
  }

  // Paid. maxAmountUsd is a hard ceiling for this one call.
  const started = await gateway({
    url: `https://stablestudio.dev/api/generate/${model}/generate`,
    body: { prompt, aspectRatio: "1:1", imageSize: "1K" },
    maxAmountUsd: MAX_USD_PER_IMAGE,
  });

  spentToday += started.cost;

  const jobId = started.data?.jobId;
  if (!jobId) throw new Error(`no jobId in response: ${JSON.stringify(started.data).slice(0, 200)}`);

  // Polling the job is free. gpt-image-2 can take a few minutes.
  const deadline = Date.now() + 4 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));

    const poll = await gateway({
      url: `https://stablestudio.dev/api/jobs/${jobId}`,
      method: "GET",
      maxAmountUsd: 0.01,
    });

    const job = poll.data;
    if (job?.status === "completed" || job?.status === "succeeded") {
      return { url: findImageUrl(job.result), cost: started.cost };
    }
    if (job?.status === "failed" || job?.error) {
      throw new Error(job?.error || "generation failed");
    }
  }
  throw new Error("timed out after 4 minutes");
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

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const html = await readFile(new URL("./public/index.html", import.meta.url));
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(html);
  }

  if (req.method === "GET" && req.url === "/api/config") {
    return json(res, 200, { models: MODELS, hasKey: Boolean(KEY) });
  }

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

    try {
      const { url, cost } = await generate(model, prompt.trim());
      return json(res, 200, { model, url, cost });
    } catch (err) {
      return json(res, 200, { model, error: String(err.message || err) });
    }
  }

  res.writeHead(404);
  res.end("not found");
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
