# Image bench

One brief, four image models, four prices.

Type a brief once. It goes to `grok`, `nano-banana`, `gpt-image-2` and
`nano-banana-pro` at the same time, and you get four takes back with what each
one actually charged. Around 48 cents for the set.

| model | price per image |
|---|---|
| `grok` | $0.07 |
| `nano-banana` | $0.07 |
| `nano-banana-pro` | $0.13 |
| `gpt-image-2` | $0.21 |

Quoted 2026-09-08 at `1:1` and `1K`. Prices are set by the provider and can
change, and they depend on the arguments you send, so a bigger `imageSize` costs
more. The app shows you what each call actually cost, which is the only number
that is ever authoritative.

The point is not a cheaper subscription. It is a wider bench. Nobody can tell you
in advance which model reads your brief the way you meant it, so ask four and
pick the one you like.

## Run it

1. **Fork this Repl.**
2. **Get a key** at [app.taskfuel.ai](https://app.taskfuel.ai/?utm_source=replit&utm_medium=referral&utm_campaign=2026-09-replit-templates&utm_content=one-brief-four-image-models).
   The first $5 is on the house, which is about 10 runs of this app.
3. **Open the Secrets tab** in the left sidebar. Add a secret named
   `TASKFUEL_API_KEY` and paste your key as the value.
4. **Hit Run.**

That is the whole setup. No provider accounts, no per-model API keys, no
subscription to cancel.

## How it works

Every paid call goes to one endpoint:

```js
await fetch("https://app.taskfuel.ai/v1/call", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.TASKFUEL_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    url: "https://stablestudio.dev/api/generate/nano-banana/generate",
    method: "POST",
    body: { prompt, aspectRatio: "1:1", imageSize: "1K" },
    maxAmountUsd: 0.25,
  }),
});
```

TaskFuel pays the provider's HTTP-402 charge from your prepaid balance and passes
the response straight back. The response headers tell you what it cost
(`x-taskfuel-cost`) and what is left (`x-taskfuel-balance`).

Generation is asynchronous: the first call returns a `jobId`, and
[`server.js`](server.js) polls a free status endpoint until the image is ready.

## Spending safely

The key can spend your whole balance, and nothing is watching at call time, so
the limits live in the code:

| Setting | Default | What it does |
|---|---|---|
| `MAX_USD_PER_IMAGE` | `0.25` | Hard ceiling on any single image. The gateway rejects anything above it. |
| `DAILY_BUDGET_USD` | `2.50` | Stops generating once the day's spend hits this. |

Both are optional secrets you can change without touching the code.

If you make this public and let strangers use it, they are spending *your*
balance. Keep the budget low, or make each visitor bring their own key.

## Make it yours

- **Swap the models.** Edit `MODELS` in [`server.js`](server.js). The full list
  is at [stablestudio.dev](https://stablestudio.dev/openapi.json), and there are
  video models and an image-to-SVG endpoint in there too.
- **Change the shape.** `aspectRatio` takes `16:9`, `9:16`, `4:3` and more.
  `imageSize` goes up to `4K`.
- **Find something else entirely.** `GET https://app.taskfuel.ai/v1/discover?q=...`
  searches every provider in the catalog. There are around 90 of them, covering
  search, market data, email, phone calls and more.

Full guide for wiring an app to the gateway:
[app.taskfuel.ai/building-apps.md](https://app.taskfuel.ai/building-apps.md)

## Running outside Replit

```bash
cp .env.example .env   # then put your real key in it
node --env-file=.env server.js
```

Needs Node 20 or newer. There are no dependencies to install.
