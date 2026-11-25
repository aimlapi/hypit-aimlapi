import assert from "node:assert/strict";
import test from "node:test";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/executor";
import { assertMappingCoversPorts } from "@hypit/generation";
import type { CanonicalValue } from "@hypit/protocol";
import { nanoBananaEndpoints, nanoBananaPorts, sealNanoBananaRequest } from "@hypit/nano-banana";
import { createVideoDistribution } from "@hypit/video";

import hypitPackage from "../src/activation.js";
import { aimlApiMappings } from "../src/mapping.js";
import { aimlApiRequestUrl, createAimlApiProvider } from "../src/provider.js";
import { aimlApiRouteForCapability } from "../src/routes.js";

const KEY = "test-aimlapi-key";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const route = (name: string) => aimlApiRouteForCapability({ module: { name: "@hypit/nano-banana", version: "1" }, name })!;
const constraints = (request: unknown) => request as CanonicalValue;

type Call = { readonly url: string; readonly init: RequestInit | undefined };
function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  return new Headers(init?.headers).get(name) ?? undefined;
}

async function generate(fetch: typeof globalThis.fetch, ports: Record<string, readonly unknown[]>, model: "nano-banana-2" | "nano-banana-pro" = "nano-banana-2") {
  const registry = new EndpointRegistry();
  await createAimlApiProvider({ fetch }).install(registry);
  const endpoint = model === "nano-banana-2" ? nanoBananaEndpoints.v2! : nanoBananaEndpoints.pro!;
  const need = {
    id: "need:aimlapi", capability: endpoint.capability, returns: endpoint.returns,
    constraints: constraints(sealNanoBananaRequest(model, ports as never)), result: "record:aimlapi",
  };
  const resolution = registry.resolve(need);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "immediate");
  const resources = new MemoryResourceStore();
  return await resolution.registration.handler({
    command: { kind: "fulfill-need", id: "command:aimlapi", need }, need, resources,
    credentials: { apiKey: { secret: KEY } },
  });
}

test("every AI/ML API mapping covers its model's ports", () => {
  for (const mapping of aimlApiMappings) {
    assertMappingCoversPorts(nanoBananaPorts[mapping.capability.name as keyof typeof nanoBananaPorts], mapping);
  }
});

test("Nano Banana Pro switches to the edit model when reference images are present", async () => {
  const pro = route("nano-banana-pro");
  const text = sealNanoBananaRequest("nano-banana-pro", { prompt: ["a fox"], aspectRatio: ["16:9"], resolution: ["2K"], outputFormat: ["png"] });
  assert.deepEqual(await pro.prepare(constraints(text)).compile(async () => "unused"), {
    model: "google/nano-banana-pro", prompt: "a fox", aspect_ratio: "16:9", resolution: "2K",
  });
  const image = { kind: "blob" as const, resource: "res_aiml_1" as const, size: 3, mediaType: "image/png" };
  const edit = sealNanoBananaRequest("nano-banana-pro", { prompt: ["make it red"], aspectRatio: ["auto"], resolution: ["1K"], outputFormat: ["png"],
    images: [{ role: "image", artifact: image }] });
  assert.deepEqual(await pro.prepare(constraints(edit)).compile(async () => "https://example.test/ref.png"), {
    model: "google/nano-banana-pro-edit", prompt: "make it red", image_urls: ["https://example.test/ref.png"], resolution: "1K",
  });
  const wide = sealNanoBananaRequest("nano-banana-pro", { ...text.ports, aspectRatio: ["21:9"] });
  assert.equal(pro.supports({ capability: pro.capability, returns: pro.returns, constraints: constraints(wide) }).status, "unsupported");
});

test("the key goes as a Bearer header only to api.aimlapi.com, and generated files are fetched without it", async () => {
  const calls: Call[] = [];
  const result = await generate(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://api.aimlapi.com/v1/images/generations") {
      return Response.json({ data: [{ url: "https://cdn.aimlapi.com/generations/a.png" }] });
    }
    return new Response(PNG, { headers: { "content-type": "image/png" } });
  }, { prompt: ["a fox"], aspectRatio: ["1:1"], resolution: ["1K"], outputFormat: ["png"] });
  assert.equal(result.value.kind, "inline");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://api.aimlapi.com/v1/images/generations");
  assert.equal(headerValue(calls[0]!.init, "authorization"), `Bearer ${KEY}`);
  assert.equal(calls[0]!.init?.redirect, "error");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    model: "nano-banana-2", prompt: "a fox", aspect_ratio: "1:1", resolution: "1K",
  });
  assert.equal(calls[1]!.url, "https://cdn.aimlapi.com/generations/a.png");
  assert.equal(headerValue(calls[1]!.init, "authorization"), undefined);
  assert.ok(!JSON.stringify(calls[1]!.init ?? {}).includes(KEY));
});

test("a redirect from api.aimlapi.com is refused instead of carrying the key to another host", async () => {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (new URL(url).hostname !== "api.aimlapi.com") return Response.json({ data: [] });
    // A followed redirect would repeat the request, headers included, at the Location host.
    if (init?.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
    return await fetch("https://evil.example/v1/images/generations", init);
  };
  const result = await generate(fetch, { prompt: ["a fox"], aspectRatio: ["1:1"], resolution: ["1K"], outputFormat: ["png"] }).catch((error: unknown) => error);
  assert.ok(result instanceof Error);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]!.url).hostname, "api.aimlapi.com");
  assert.ok(calls.every((call) => new URL(call.url).hostname === "api.aimlapi.com"));
});

test("request URLs are pinned to the exact api.aimlapi.com origin", () => {
  assert.equal(aimlApiRequestUrl("/v1/images/generations").href, "https://api.aimlapi.com/v1/images/generations");
  for (const path of ["https://api.aimlapi.com.evil.example/v1", "//evil.example/v1", "https://evil.example/v1",
    "http://api.aimlapi.com/v1", "https://api.aimlapi.com:8443/v1", "https://user:pw@api.aimlapi.com/v1"]) {
    assert.throws(() => aimlApiRequestUrl(path), /api\.aimlapi\.com/u, path);
  }
});

test("activation takes only a CredentialRef for the key and no base URL", async () => {
  const facet = hypitPackage.facets[0]!;
  assert.deepEqual(facet.offers, ["@hypit/provider-aimlapi"]);
  const implementation = facet.implementation as { activate: (context: unknown) => Promise<{ endpoint: { instance: { id: string } } }> | { endpoint: { instance: { id: string } } } };
  const base = { hostStateRoot: "/tmp/h", dataRoot: "/tmp/d", instance: "aimlapi.default", pool: "aimlapi.default" };
  const activation = await implementation.activate({ ...base, config: { apiKey: { store: "env", key: "AIMLAPI_API_KEY" } } });
  assert.equal(activation.endpoint.instance.id, "aimlapi.default");
  await assert.rejects(async () => await implementation.activate({ ...base, config: { apiKey: "sk-plaintext" } }));
  await assert.rejects(async () => await implementation.activate({ ...base, config: {
    apiKey: { store: "env", key: "AIMLAPI_API_KEY" }, baseUrl: "https://evil.example",
  } }));
  await assert.rejects(async () => await implementation.activate({ ...base, config: {} }), /CredentialRef is required/u);
});

test("the starter Runtime Profile does not select AI/ML API", () => {
  const profile = JSON.stringify(createVideoDistribution().initialRuntimeProfile);
  assert.ok(!profile.includes("aimlapi"));
});
