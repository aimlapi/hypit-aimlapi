# @hypit/provider-aimlapi

A Provider that runs Hypit's generation Models on [AI/ML API](https://aimlapi.com) — one OpenAI-compatible gateway, one key, the same models Hypit already names.

## Capabilities

| Hypit capability | Gateway model | Lifecycle |
| --- | --- | --- |
| `@hypit/gpt-image@1#gpt-image-2` | `openai/gpt-image-2` | immediate (`POST /v1/images/generations`) |
| `@hypit/nano-banana@1#nano-banana-2` | `google/nano-banana-2` | immediate |
| `@hypit/nano-banana@1#nano-banana-pro` | `google/nano-banana-pro`, `-edit` with references | immediate |
| `@hypit/seedance@1#seedance-2` | `bytedance/seedance-2-0` | asynchronous (`POST /v2/video/generations`, polled) |
| `@hypit/seedance@1#seedance-2-fast` | `bytedance/seedance-2-0-fast` | asynchronous |
| `@hypit/seedance@1#seedance-2-mini` | `bytedance/seedance-2-0-mini` | asynchronous |
| `@hypit/seedance@1#seedance-2.5` | `bytedance/seedance-2-5` | asynchronous |
| `@hypit/minimax-h3@1#minimax-h3` | `minimax/h3` | asynchronous |
| `@hypit/grok-imagine@1#grok-imagine-video` | `x-ai/grok-imagine-video` | asynchronous |

Each route's `supports` names exactly what the gateway's published request schema (`https://api.aimlapi.com/docs-json?model=<id>`) refuses — a 4K tier on GPT Image 2, `1080p` on Seedance 2 Mini, web search on Seedance, a port the model does not have — so a Profile knows before submitting. Ports the gateway has no field for are refused rather than silently dropped.

## Attaching media

Reference images and audio are sent inline as base64 data URLs, which the gateway accepts. Reference videos need a public URL: give the Provider a `publicAssetUrl` callback that publishes an artifact and returns its address, or the request is refused before anything is submitted.

## Configure

Merge into the project's chosen Profile:

```json
{
  "endpoints": {
    "aimlapi.personal": {
      "use": "@hypit/provider-aimlapi",
      "config": { "apiKey": { "store": "os", "key": "aimlapi.personal" } }
    }
  },
  "bindings": {
    "@hypit/gpt-image@1#gpt-image-2": "aimlapi.personal",
    "@hypit/seedance@1#seedance-2": "aimlapi.personal"
  }
}
```

Optional config: `baseUrl` (default `https://api.aimlapi.com`), `defaultConcurrency` (2), `pollIntervalMs` (10000), `requestTimeoutMs` (120000), `downloadTimeoutMs` (300000).

Then `hypit auth login aimlapi.personal` stores the key from [aimlapi.com/app/keys](https://aimlapi.com/app/keys). Prices are on [aimlapi.com/pricing](https://aimlapi.com/pricing); the gateway reports `meta.usage.usd_spent` on each reply.

Requests to `api.aimlapi.com` carry `X-AIMLAPI-Source: agent/hypit` and an `X-AIMLAPI-Partner-ID`, which tell the gateway the traffic comes from Hypit. They are attached only for that host; a `baseUrl` pointing at a proxy or another gateway sends neither.

## Not yet

- GPT Image 2 with reference images (`/v1/images/edits`).
- Seedream, MiniMax H3 at 768P (that is `minimax/h3-max` on the gateway), Grok Imagine Video 1.5 preview.
- Speech: the gateway's TTS models are not the ones Hypit's speech Models name.
