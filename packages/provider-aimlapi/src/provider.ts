import type { EndpointCredential, EndpointInvocationContext, ImmediateEndpointHandler } from "@hypit/hypit/endpoint";
import { defineEndpoint } from "@hypit/hypit/endpoint";
import { EndpointResponseError, EndpointTransportError, withRequestDeadline } from "@hypit/hypit/endpoint/http";
import type { GenerationArtifactUrlResolver } from "@hypit/generation";
import type { BlobRef } from "@hypit/hypit/protocol";
import { credentialRef } from "@hypit/hypit/endpoint";
import type { CredentialRef, ResourceStore } from "@hypit/hypit/endpoint";
import { aimlApiRouteForCapability, aimlApiRoutes } from "./routes.js";
import { AimlApiHttpError, AimlApiServiceError } from "./errors.js";

export const aimlApiProviderModuleRef = { name: "@hypit/provider-aimlapi", version: "1" } as const;

/** The only origin that receives the AI/ML API key. */
export const AIMLAPI_BASE_URL = "https://api.aimlapi.com";
const AIMLAPI_HOST = "api.aimlapi.com";

export type CreateAimlApiProviderOptions = {
  readonly instance?: string;
  readonly pool?: string;
  readonly apiKey?: CredentialRef;
  readonly defaultConcurrency?: number;
  readonly actionLimits?: import("@hypit/hypit/endpoint").EndpointActionLimits;
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Publish a referenced Resource at an HTTP(S) URL AI/ML API can fetch. Without it, reference images
   * are sent inline as base64 data URLs, which AI/ML API's image endpoint accepts.
   */
  readonly publicAssetUrl?: (artifact: BlobRef, artifacts: ResourceStore, fields?: Readonly<Record<string, string | number | boolean>>) => Promise<string>;
};

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown, subject: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${subject} must be an object`);
  return value as Record<string, unknown>;
}
function apiKey(credentials: Readonly<Record<string, EndpointCredential>>): string {
  const value = credentials.apiKey?.secret;
  if (typeof value !== "string" || value.length === 0) {
    throw new AimlApiServiceError("AIMLAPI_CREDENTIAL_UNAVAILABLE",
      "AI/ML API apiKey credential is unavailable; store an AI/ML API key for this Endpoint");
  }
  return value;
}

/**
 * The key goes only to https://api.aimlapi.com. Redirects are refused rather than followed, so the
 * Authorization header never reaches another host.
 */
export function aimlApiRequestUrl(path: string): URL {
  const url = new URL(path, AIMLAPI_BASE_URL);
  assert(url.protocol === "https:" && url.hostname === AIMLAPI_HOST && url.port === "" && url.username === "" && url.password === "",
    `AI/ML API requests go only to ${AIMLAPI_BASE_URL}`);
  return url;
}

class AimlApiClient {
  constructor(readonly timeout: number, readonly fetcher: typeof globalThis.fetch) {}
  async json(path: string, key: string, init: RequestInit & { readonly model?: string } = {}): Promise<Record<string, unknown>> {
    const url = aimlApiRequestUrl(path);
    const { model, ...request } = init;
    return await withRequestDeadline(this.timeout, async ({ signal, wait }) => {
      const response = await wait(this.fetcher(url.href, {
        ...request, signal, redirect: "error", headers: { ...(request.headers ?? {}), authorization: `Bearer ${key}` },
      }));
      const text = await wait(response.text());
      if (!response.ok) {
        throw new AimlApiHttpError(response.status, response, text, {
          method: request.method ?? "GET", path, ...(model === undefined ? {} : { model }),
        });
      }
      let body: unknown;
      try { body = text.length === 0 ? {} : JSON.parse(text); } catch { throw new EndpointResponseError(`AI/ML API returned invalid JSON (${response.status})`); }
      return object(body, "AI/ML API response");
    }, () => new EndpointTransportError("AI/ML API request timed out", { timeout: true }));
  }
  /** Generated files are fetched without credentials. */
  async download(url: string): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
    return await withRequestDeadline(this.timeout, async ({ signal, wait }) => {
      const response = await wait(this.fetcher(url, { signal }));
      if (!response.ok) throw new AimlApiHttpError(response.status, response, "", { method: "GET", path: "generated file" });
      return { bytes: new Uint8Array(await wait(response.arrayBuffer())), mediaType: response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream" };
    });
  }
}

function resolverFor(context: EndpointInvocationContext, publicAssetUrl: CreateAimlApiProviderOptions["publicAssetUrl"]): GenerationArtifactUrlResolver {
  const resolved = new Map<string, Promise<string>>();
  return (artifact, fields) => {
    const existing = resolved.get(artifact.resource);
    if (existing !== undefined) return existing;
    const promise = (async () => {
      if (publicAssetUrl !== undefined) return await publicAssetUrl(artifact, context.resources, fields);
      assert(artifact.mediaType.startsWith("image/"), `AI/ML API takes image references, not ${artifact.mediaType}`);
      const bytes = await context.resources.get(artifact.resource);
      assert(bytes !== undefined && bytes.byteLength === artifact.size, `Reference Resource ${artifact.resource} is unavailable or has changed`);
      return `data:${artifact.mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
    })();
    resolved.set(artifact.resource, promise);
    return promise;
  };
}

async function images(client: AimlApiClient, response: Record<string, unknown>, resources: ResourceStore): Promise<BlobRef[]> {
  assert(Array.isArray(response.data) && response.data.length > 0, "AI/ML API image response has no data");
  const blobs: BlobRef[] = [];
  for (const [index, item] of response.data.entries()) {
    const image = object(item, `AI/ML API image ${index + 1}`);
    if (typeof image.b64_json === "string" && image.b64_json.length > 0) {
      blobs.push(await resources.put(new Uint8Array(Buffer.from(image.b64_json, "base64")), "image/png"));
      continue;
    }
    if (typeof image.url !== "string" || !/^https:\/\//u.test(image.url)) throw new EndpointResponseError(`AI/ML API image ${index + 1} has no download URL`);
    const downloaded = await client.download(image.url);
    blobs.push(await resources.put(downloaded.bytes, downloaded.mediaType));
  }
  return blobs;
}

export function createAimlApiProvider(options: CreateAimlApiProviderOptions = {}) {
  const requestTimeoutMs = options.requestTimeoutMs ?? 300_000;
  assert(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0, "AI/ML API requestTimeoutMs must be a positive integer");
  const client = new AimlApiClient(requestTimeoutMs, options.fetch ?? globalThis.fetch);
  const imageEndpoint: ImmediateEndpointHandler = async (context) => {
    const route = aimlApiRouteForCapability(context.need.capability);
    assert(route !== undefined, "AI/ML API does not implement this exact capability");
    const request = route.prepare(context.need.constraints);
    await context.reportProgress?.({ phase: `Preparing AI/ML API request: ${request.model}` });
    const body = await request.compile(resolverFor(context, options.publicAssetUrl));
    await context.reportProgress?.({ phase: `Submitting AI/ML API request: ${request.model}` });
    const response = await client.json("/v1/images/generations", apiKey(context.credentials), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), model: request.model,
    });
    await context.reportProgress?.({ phase: "Receiving generated images" });
    return { value: route.packageResult(await images(client, response, context.resources)) };
  };
  return defineEndpoint({
    instance: options.instance ?? "aimlapi.default", pool: options.pool ?? options.instance ?? "aimlapi.default",
    pricing: { kind: "page", url: "https://aimlapi.com/ai-ml-api-pricing" },
    credentials: { apiKey: options.apiKey ?? credentialRef("local", "aimlapi.api-key") },
    credentialInputs: { apiKey: { label: "AI/ML API key" } },
    defaultConcurrency: options.defaultConcurrency ?? 4,
    ...(options.actionLimits === undefined ? {} : { actionLimits: options.actionLimits }),
    capabilities: aimlApiRoutes.map((route) => ({
      capability: route.capability, returns: route.returns, lifecycle: "immediate" as const, handler: imageEndpoint, capacity: route.capability.name, supports: route.supports,
    })),
  });
}
