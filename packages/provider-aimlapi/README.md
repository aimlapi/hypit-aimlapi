# `@hypit/provider-aimlapi`

Optional Provider, not installed with Hypit. Install in the video project:

```bash
npm install @hypit/provider-aimlapi
```

Hypit Runtime Provider for an [AI/ML API](https://aimlapi.com) account. Each capability posts the
model's documented fields to `POST https://api.aimlapi.com/v1/images/generations` with an
`Authorization: Bearer` header, downloads each returned image `url` (or decodes `b64_json`) and stores
the files in the current Build. The request is synchronous, so the capabilities are immediate.

| Capability | AI/ML API model |
| --- | --- |
| `@hypit/nano-banana@1#nano-banana-2` | `nano-banana-2` |
| `@hypit/nano-banana@1#nano-banana-pro` | `google/nano-banana-pro`, or `google/nano-banana-pro-edit` with reference images |

AI/ML API offers further image, video and audio models
([catalog](https://api.aimlapi.com/v1/models?include=all), [docs](https://docs.aimlapi.com)); this
Provider maps only models the Distribution already describes whose AI/ML API request matches the
Hypit ports exactly.

Service limits this Provider reports as unsupported before submitting:

- Nano Banana 2 renders `auto`, `21:9`, `1:1`, `4:3`, `3:2`, `2:3`, `5:4`, `4:5`, `3:4`, `16:9` and
  `9:16`.
- Nano Banana Pro renders `1:1`, `9:16`, `16:9`, `3:4` and `4:3`. With reference images it uses
  the edit model, which also takes `auto` (framing from the reference) and at most 5 images.
- `output-format` has no AI/ML API field and is not sent.

Reference images are sent inline as base64 data URLs unless the embedding caller supplies
`publicAssetUrl`.

Runtime Profile example:

```json
{
  "format": "hypit.runtime-local@1",
  "dataRoot": ".hypit/runtimes/local",
  "credentials": {
    "local": {
      "use": "@hypit/credential-store-local"
    }
  },
  "endpoints": {
    "aimlapi.default": {
      "use": "@hypit/provider-aimlapi",
      "pool": "aimlapi.default",
      "config": {
        "apiKey": { "store": "local", "key": "aimlapi.api-key" },
        "defaultConcurrency": 3
      }
    }
  },
  "bindings": {}
}
```

Store the API key with `hypit auth login aimlapi.default --runtime hypit.runtime.json`, or point
`apiKey` at `{ "store": "env", "key": "AIMLAPI_API_KEY" }` with `@hypit/credential-store-env`.
Keys are created at https://aimlapi.com/app/keys.

The service address is fixed: the configuration takes no `baseUrl`, the key is sent only to
`https://api.aimlapi.com`, redirects from it are refused rather than followed, and generated files
are downloaded without the key. Optional `requestTimeoutMs` and `actionLimits` bound single HTTP
calls and action concurrency. HTTP failures keep AI/ML API's error code, message and request id, with
any URL in the message redacted.
