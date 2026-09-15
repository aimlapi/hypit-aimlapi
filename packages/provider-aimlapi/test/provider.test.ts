import assert from "node:assert/strict";
import test from "node:test";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import { sealGptImage2Request } from "@hypit/gpt-image";
import { sealNanoBananaRequest } from "@hypit/nano-banana";
import { sealSeedanceRequest } from "@hypit/seedance";
import type { BlobRef, EndpointStartContext } from "@hypit/endpoint-kit";
import { canonicalize } from "@hypit/endpoint-kit";
import { generationTypes } from "@hypit/generation";

import { aimlapiRouteForCapability, createAimlapiProvider } from "../src/index.js";

const GPT_IMAGE_2 = { module: { name: "@hypit/gpt-image", version: "1" }, name: "gpt-image-2" } as const;
const NANO_BANANA_PRO = { module: { name: "@hypit/nano-banana", version: "1" }, name: "nano-banana-pro" } as const;
const SEEDANCE_2 = { module: { name: "@hypit/seedance", version: "1" }, name: "seedance-2" } as const;

type Call = { path: string; headers: Record<string, string>; body?: unknown };

/** A gateway double: records every call, answers the documented shapes. */
function gateway(calls: Call[], options: { videoStatuses?: string[] } = {}) {
  const statuses = [...(options.videoStatuses ?? ["queued", "generating", "completed"])];
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (url.hostname === "cdn.aimlapi.com") {
      assert.equal(init?.headers, undefined, "asset downloads carry no account key");
      calls.push({ path: url.pathname, headers: {} });
      return url.pathname.endsWith(".mp4")
        ? new Response(new Uint8Array([7, 7, 7]), { headers: { "content-type": "video/mp4" } })
        : new Response(new Uint8Array([4, 5, 6]), { headers: { "content-type": "image/png" } });
    }
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    // A proxy prefix (`/aimlapi/v1/...`) still names the same gateway routes.
    const path = url.pathname.replace(/^\/aimlapi/u, "");
    calls.push({ path: path + url.search, headers, body });
    if (path === "/v1/images/generations") {
      return Response.json({ data: [{ url: "https://cdn.aimlapi.com/generations/out.png" }], meta: { usage: { usd_spent: 0.04 } } });
    }
    if (path === "/v2/video/generations" && init?.method === "POST") {
      return Response.json({ id: "gen-1", status: statuses.shift() ?? "queued" });
    }
    if (path === "/v2/video/generations") {
      const status = statuses.shift() ?? "completed";
      return Response.json(status === "completed"
        ? { id: "gen-1", status, video: { url: "https://cdn.aimlapi.com/generations/out.mp4" } }
        : status === "error" ? { id: "gen-1", status, error: { name: "ContentPolicy", message: "blocked" } }
        : { id: "gen-1", status });
    }
    throw new Error(`Unexpected call ${url.href}`);
  };
}

function provider(fetcher: typeof globalThis.fetch, baseUrl?: string) {
  return createAimlapiProvider({
    instance: "aimlapi.personal", pool: "aimlapi.personal",
    apiKey: { store: "os", key: "aimlapi.personal" },
    pollIntervalMs: 1, fetch: fetcher, ...(baseUrl === undefined ? {} : { baseUrl }),
  });
}

function contextFor(need: EndpointStartContext["need"], resources: MemoryResourceStore, onCheckpoint?: (value: unknown) => void): EndpointStartContext {
  return {
    need, command: { kind: "fulfill-need", id: "command:t", need }, operation: "operation:t",
    resources, credentials: { apiKey: { secret: "sk-test" } },
    checkpoint: async (value) => { onCheckpoint?.(value); },
  };
}

test("GPT Image 2 is answered in one call, with the gateway's pixel size and attribution on its own host", async () => {
  const calls: Call[] = [];
  const resources = new MemoryResourceStore();
  const pkg = provider(gateway(calls));
  const registry = new EndpointRegistry(); await pkg.install(registry);
  const constraints = canonicalize(sealGptImage2Request({ prompt: ["A portrait"], aspectRatio: ["9:16"], resolution: ["1K"] }));
  const need = { id: "need:t", capability: GPT_IMAGE_2, returns: generationTypes.imageSet, constraints, result: "record:t" } as const;
  const resolution = registry.resolve(need);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "immediate");
  const fulfilled = await resolution.registration.handler(contextFor(need, resources));
  assert.equal(fulfilled.value.kind, "inline");
  const images = (fulfilled.value.value as unknown as { images: BlobRef[] }).images;
  assert.equal(images.length, 1);
  assert.equal(images[0]!.mediaType, "image/png");
  assert.deepEqual(await resources.get(images[0]!.resource), new Uint8Array([4, 5, 6]));

  const submit = calls[0]!;
  assert.equal(submit.path, "/v1/images/generations");
  assert.deepEqual(submit.body, { model: "openai/gpt-image-2", prompt: "A portrait", size: "1024x1536", response_format: "url" });
  assert.equal(submit.headers.authorization, "Bearer sk-test");
  assert.equal(submit.headers["x-aimlapi-source"], "agent/hypit");
  assert.ok(submit.headers["x-aimlapi-partner-id"]);
  assert.equal(calls[1]!.path, "/generations/out.png");
});

test("a proxy in front of the gateway gets the request but not the attribution headers", async () => {
  const calls: Call[] = [];
  const pkg = provider(gateway(calls), "https://proxy.example/aimlapi");
  const registry = new EndpointRegistry(); await pkg.install(registry);
  const constraints = canonicalize(sealGptImage2Request({ prompt: ["A portrait"], aspectRatio: ["1:1"], resolution: ["1K"] }));
  const need = { id: "need:t", capability: GPT_IMAGE_2, returns: generationTypes.imageSet, constraints, result: "record:t" } as const;
  const resolution = registry.resolve(need);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "immediate");
  await resolution.registration.handler(contextFor(need, new MemoryResourceStore()));
  assert.equal(calls[0]!.path, "/v1/images/generations");
  assert.equal(calls[0]!.headers.authorization, "Bearer sk-test");
  assert.equal(calls[0]!.headers["x-aimlapi-source"], undefined);
  assert.equal(calls[0]!.headers["x-aimlapi-partner-id"], undefined);
});

test("reference images ride inline as base64 and pick the edit model", async () => {
  const calls: Call[] = [];
  const resources = new MemoryResourceStore();
  const source = await resources.put(new Uint8Array([1, 2, 3]), "image/png");
  const pkg = provider(gateway(calls));
  const registry = new EndpointRegistry(); await pkg.install(registry);
  const constraints = canonicalize(sealNanoBananaRequest("nano-banana-pro", {
    prompt: ["Make it night"], aspectRatio: ["16:9"], resolution: ["2K"], outputFormat: ["png"],
    images: [{ role: "image", artifact: source }],
  }));
  const need = { id: "need:t", capability: NANO_BANANA_PRO, returns: generationTypes.imageSet, constraints, result: "record:t" } as const;
  const resolution = registry.resolve(need);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "immediate");
  await resolution.registration.handler(contextFor(need, resources));
  assert.deepEqual(calls[0]!.body, {
    model: "google/nano-banana-pro-edit", prompt: "Make it night", aspect_ratio: "16:9", resolution: "2K",
    image_urls: ["data:image/png;base64,AQID"],
  });
});

test("Seedance 2 is a job: submit, poll until completed, collect the video", async () => {
  const calls: Call[] = [];
  const resources = new MemoryResourceStore();
  const frame = await resources.put(new Uint8Array([9]), "image/jpeg");
  let checkpoint: unknown;
  const pkg = provider(gateway(calls));
  const registry = new EndpointRegistry(); await pkg.install(registry);
  const constraints = canonicalize(sealSeedanceRequest("seedance-2", {
    prompt: ["A hedgehog"], resolution: ["1080p"], aspectRatio: ["9:16"], duration: [8], generateAudio: [true], webSearch: [false],
    firstFrame: [{ role: "image", artifact: frame }],
  }));
  const need = { id: "need:t", capability: SEEDANCE_2, returns: generationTypes.videoSet, constraints, result: "record:t" } as const;
  const resolution = registry.resolve(need);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "asynchronous");
  const endpoint = resolution.registration.endpoint;
  const context = contextFor(need, resources, (value) => { checkpoint = value; });

  const start = await endpoint.start(context);
  assert.equal(start.status, "pending");
  assert.deepEqual(checkpoint, { handle: { id: "gen-1", route: "@hypit/seedance@1#seedance-2" }, receipt: { id: "gen-1" } });
  assert.deepEqual(calls[0]!.body, {
    model: "bytedance/seedance-2-0", prompt: "A hedgehog", resolution: "1080p", aspect_ratio: "9:16", duration: 8,
    generate_audio: true, image_url: "data:image/jpeg;base64,CQ==",
  });

  const generating = await endpoint.poll({ ...context, handle: start.handle });
  assert.equal(generating.status, "pending");
  assert.equal(calls[1]!.path, "/v2/video/generations?generation_id=gen-1");
  const ready = await endpoint.poll({ ...context, handle: start.handle });
  assert.equal(ready.status, "ready");
  const collected = await endpoint.collect!({ ...context, handle: ready.handle });
  assert.equal(collected.status, "completed");
  assert.equal(collected.result.value.kind, "inline");
  const videos = (collected.result.value.value as unknown as { videos: BlobRef[] }).videos;
  assert.equal(videos[0]!.mediaType, "video/mp4");
  assert.deepEqual(await resources.get(videos[0]!.resource), new Uint8Array([7, 7, 7]));
  assert.deepEqual(calls.map((call) => call.path), [
    "/v2/video/generations", "/v2/video/generations?generation_id=gen-1", "/v2/video/generations?generation_id=gen-1", "/generations/out.mp4",
  ]);
});

test("a failed job is reported with the gateway's own error", async () => {
  const calls: Call[] = [];
  const pkg = provider(gateway(calls, { videoStatuses: ["queued", "error"] }));
  const registry = new EndpointRegistry(); await pkg.install(registry);
  const constraints = canonicalize(sealSeedanceRequest("seedance-2-mini", {
    prompt: ["A hedgehog"], resolution: ["720p"], aspectRatio: ["16:9"], duration: [5], generateAudio: [false], webSearch: [false],
  }));
  const need = { id: "need:t", capability: { ...SEEDANCE_2, name: "seedance-2-mini" }, returns: generationTypes.videoSet, constraints, result: "record:t" } as const;
  const resolution = registry.resolve(need);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "asynchronous");
  const endpoint = resolution.registration.endpoint;
  const context = contextFor(need, new MemoryResourceStore());
  const start = await endpoint.start(context);
  assert.equal(start.status, "pending");
  const failed = await endpoint.poll({ ...context, handle: start.handle });
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.failure, { code: "ContentPolicy", message: "blocked" });
});

test("support says what the gateway refuses, port by port", () => {
  const gpt = aimlapiRouteForCapability(GPT_IMAGE_2)!;
  assert.equal(gpt.supports({ ports: { prompt: ["x"], aspectRatio: ["1:1"], resolution: ["1K"] } }), undefined);
  assert.match(gpt.supports({ ports: { prompt: ["x"], aspectRatio: ["1:1"], resolution: ["4K"] } })!, /GPT Image 2 at 1K/u);
  assert.match(gpt.supports({ ports: { prompt: ["x"], aspectRatio: ["21:9"], resolution: ["1K"] } })!, /21:9/u);
  const seedance = aimlapiRouteForCapability(SEEDANCE_2)!;
  assert.match(seedance.supports({ ports: { prompt: ["x"], webSearch: [true] } })!, /web search/u);
  const mini = aimlapiRouteForCapability({ ...SEEDANCE_2, name: "seedance-2-mini" })!;
  assert.match(mini.supports({ ports: { prompt: ["x"], resolution: ["1080p"] } })!, /480p, 720p/u);
  assert.match(gpt.supports({ ports: { prompt: ["x"], seed: [1] } })!, /does not take seed/u);
});

test("a reference video needs a public URL unless the project publishes assets", async () => {
  const calls: Call[] = [];
  const resources = new MemoryResourceStore();
  const clip = await resources.put(new Uint8Array([1]), "video/mp4");
  const pkg = provider(gateway(calls));
  const registry = new EndpointRegistry(); await pkg.install(registry);
  const constraints = canonicalize(sealSeedanceRequest("seedance-2", {
    prompt: ["A hedgehog"], resolution: ["720p"], aspectRatio: ["16:9"], duration: [5], generateAudio: [false], webSearch: [false],
    referenceVideo: [{ role: "video", artifact: clip }],
  }));
  const need = { id: "need:t", capability: SEEDANCE_2, returns: generationTypes.videoSet, constraints, result: "record:t" } as const;
  const resolution = registry.resolve(need);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "asynchronous");
  const endpoint = resolution.registration.endpoint;
  await assert.rejects(async () => { await endpoint.start(contextFor(need, resources)); }, /public URL only/u);
  assert.equal(calls.length, 0, "nothing is submitted when an input cannot be attached");
});
