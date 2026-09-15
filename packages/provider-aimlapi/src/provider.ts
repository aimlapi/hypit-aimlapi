import { canonicalize, defineEndpointPackage, wakeAfter } from "@hypit/endpoint-kit";
import type {
  AsyncEndpoint, BlobRef, CredentialRef, EndpointInvocationContext, EndpointOutcome, EndpointRequest,
  ImmediateEndpointHandler, ResourceStore,
} from "@hypit/endpoint-kit";
import { generationTypes, sealGeneratedImageSet, sealGeneratedVideoSet } from "@hypit/generation";
import type { GenerationRequest } from "@hypit/generation";

import { aimlapiRouteForCapability, aimlapiRoutes, capabilityKey, compileAimlapiRequest } from "./routes.js";
import type { AimlapiRoute } from "./routes.js";

export const providerModule = { name: "@hypit/provider-aimlapi", version: "1" } as const;

const DEFAULT_BASE_URL = "https://api.aimlapi.com";
const AIMLAPI_HOST = "api.aimlapi.com";

/**
 * Identify Hypit to the gateway. They mean something only on api.aimlapi.com,
 * so they are attached only when the configured base URL is that host — a
 * proxy or a look-alike host gets none of them.
 */
const ATTRIBUTION_HEADERS = {
  "X-AIMLAPI-Source": "agent/hypit",
  "X-AIMLAPI-Partner-ID": "part_PLACEHOLDER_HYPIT",
} as const;

export type CreateAimlapiProviderOptions = {
  readonly instance: string;
  readonly pool: string;
  readonly apiKey: CredentialRef;
  /** Defaults to https://api.aimlapi.com. A proxy in front of it keeps working without attribution. */
  readonly baseUrl?: string;
  readonly defaultConcurrency?: number;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly downloadTimeoutMs?: number;
  /**
   * Publish an attached artifact somewhere the gateway can fetch it and return
   * that URL. Without it, images and audio are sent inline as base64 data URLs,
   * which the gateway accepts; reference videos need a public URL and are
   * refused.
   */
  readonly publicAssetUrl?: (artifact: BlobRef, resources: ResourceStore) => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: unknown, what: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${what} is not an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
  assert(typeof value === "string" && value.length > 0, `${what} is missing`);
  return value;
}

function apiBase(value: string): { readonly base: string; readonly attributed: boolean } {
  const url = new URL(value);
  assert(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)),
    "AI/ML API base URL must be HTTPS or loopback HTTP");
  return { base: url.href.replace(/\/+$/u, ""), attributed: url.hostname.toLowerCase() === AIMLAPI_HOST };
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** The body the gateway sent back, or a readable failure when it did not accept the call. */
async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  const raw = await response.text();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  if (!response.ok) {
    const detail = parsed !== undefined ? object(parsed, what) : undefined;
    const message = typeof detail?.message === "string" ? detail.message
      : typeof (detail?.error as { message?: unknown } | undefined)?.message === "string" ? String((detail!.error as { message: string }).message)
      : raw.slice(0, 200);
    throw new Error(`AI/ML API ${what} returned HTTP ${response.status}: ${message}`);
  }
  assert(parsed !== undefined, `AI/ML API ${what} returned no JSON`);
  return object(parsed, what);
}

class AimlapiClient {
  constructor(
    private readonly base: string,
    private readonly attributed: boolean,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly requestTimeoutMs: number,
    private readonly downloadTimeoutMs: number,
  ) {}

  private headers(secret: string): Record<string, string> {
    return {
      authorization: `Bearer ${secret}`,
      ...(this.attributed ? ATTRIBUTION_HEADERS : {}),
    };
  }

  async post(path: string, secret: string, body: unknown, what: string): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${this.base}${path}`, {
      method: "POST",
      headers: { ...this.headers(secret), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    return await readJson(response, what);
  }

  async get(path: string, secret: string, what: string): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${this.base}${path}`, {
      headers: this.headers(secret),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    return await readJson(response, what);
  }

  /** Generated media is served from the gateway's CDN without the account key. */
  async download(url: string, prefix: "image/" | "video/"): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const parsed = new URL(url);
    assert(parsed.protocol === "https:", "AI/ML API returned a non-HTTPS asset URL");
    const response = await this.fetcher(parsed.href, { signal: AbortSignal.timeout(this.downloadTimeoutMs) });
    assert(response.ok, `AI/ML API asset download returned HTTP ${response.status}`);
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    assert(mediaType.startsWith(prefix), `AI/ML API returned ${mediaType || "an untyped asset"} where ${prefix}* was expected`);
    return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType };
  }
}

function secretOf(credentials: Readonly<Record<string, { secret: string }>>): string {
  return text(credentials.apiKey?.secret, "AI/ML API key");
}

function routeFor(request: EndpointRequest): AimlapiRoute {
  const route = aimlapiRouteForCapability(request.capability);
  assert(route !== undefined, "AI/ML API does not implement this exact capability");
  return route;
}

function supports(request: EndpointRequest) {
  const route = routeFor(request);
  const generation = request.constraints as unknown as GenerationRequest;
  const pending = request.pendingInputs?.find((slot) => !route.ports.includes(slot.input));
  const reason = route.supports(generation)
    ?? (pending === undefined ? undefined : `AI/ML API does not take ${pending.input} for this model`);
  return reason === undefined ? { status: "supported" as const } : { status: "unsupported" as const, reason };
}

function resolver(
  context: EndpointInvocationContext,
  publicAssetUrl: CreateAimlapiProviderOptions["publicAssetUrl"],
) {
  return async (artifact: BlobRef): Promise<string> => {
    if (publicAssetUrl !== undefined) return await publicAssetUrl(artifact, context.resources);
    assert(!artifact.mediaType.startsWith("video/"),
      "AI/ML API takes reference videos by public URL only; configure publicAssetUrl to attach one");
    const bytes = await context.resources.get(artifact.resource);
    assert(bytes !== undefined, `Attached ${artifact.mediaType} artifact is unavailable`);
    return `data:${artifact.mediaType};base64,${bytesToBase64(bytes)}`;
  };
}

function packaged(route: AimlapiRoute, artifacts: readonly BlobRef[]) {
  return {
    kind: "inline" as const,
    value: canonicalize(route.result === "image"
      ? sealGeneratedImageSet({ images: artifacts })
      : sealGeneratedVideoSet({ videos: artifacts })),
  };
}

/** Both `video: { url }` and `video: [{ url }]` occur in the gateway's job replies. */
function videoUrls(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return items.map((item) => text(object(item, "AI/ML API video").url, "AI/ML API video URL"));
}

export function createAimlapiProvider(options: CreateAimlapiProviderOptions) {
  const { base, attributed } = apiBase(options.baseUrl ?? DEFAULT_BASE_URL);
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const client = new AimlapiClient(
    base, attributed, options.fetch ?? globalThis.fetch,
    options.requestTimeoutMs ?? 120_000, options.downloadTimeoutMs ?? 300_000,
  );

  // Images are answered in the same call, so the image capabilities are immediate.
  const imageHandler: ImmediateEndpointHandler = async (context) => {
    const route = routeFor(context.need);
    assert(route.result === "image", "AI/ML API image handler received a non-image capability");
    const secret = secretOf(context.credentials);
    const wire = await compileAimlapiRequest(route, context.need.constraints as unknown as GenerationRequest,
      resolver(context, options.publicAssetUrl));
    await context.reportProgress?.({ phase: `Generating with ${wire.model}` });
    const reply = await client.post(wire.path, secret, wire.body, `image generation (${wire.model})`);
    const data = reply.data;
    assert(Array.isArray(data) && data.length > 0, "AI/ML API returned no image");
    const artifacts: BlobRef[] = [];
    for (const item of data) {
      const image = object(item, "AI/ML API image");
      if (typeof image.url === "string") {
        const downloaded = await client.download(image.url, "image/");
        artifacts.push(await context.resources.put(downloaded.bytes, downloaded.mediaType));
      } else {
        const encoded = text(image.b64_json, "AI/ML API image payload");
        artifacts.push(await context.resources.put(new Uint8Array(Buffer.from(encoded, "base64")), "image/png"));
      }
    }
    return { value: packaged(route, artifacts) };
  };

  // Videos are jobs: submit, wake to poll, collect the finished file.
  const videoEndpoint: AsyncEndpoint = {
    async start(context) {
      const route = routeFor(context.need);
      assert(route.result === "video", "AI/ML API video endpoint received a non-video capability");
      const secret = secretOf(context.credentials);
      const wire = await compileAimlapiRequest(route, context.need.constraints as unknown as GenerationRequest,
        resolver(context, options.publicAssetUrl));
      const reply = await client.post(wire.path, secret, wire.body, `video generation (${wire.model})`);
      const id = text(reply.id, "AI/ML API generation id");
      const handle = { id, route: capabilityKey(route.capability) };
      const receipt = { id };
      await context.checkpoint?.({ handle, receipt });
      if (reply.status === "completed") return { status: "ready", handle: canonicalize({ ...handle, urls: videoUrls(reply.video) }), receipt };
      return { ...wakeAfter(canonicalize(handle), pollIntervalMs, Date.now(), { phase: String(reply.status ?? "queued") }), receipt };
    },
    async poll(context) {
      const handle = object(context.handle, "AI/ML API handle");
      const id = text(handle.id, "AI/ML API generation id");
      const reply = await client.get(`/v2/video/generations?generation_id=${encodeURIComponent(id)}`,
        secretOf(context.credentials), "video status");
      const status = String(reply.status ?? "");
      if (status === "queued" || status === "generating") {
        return wakeAfter(context.handle, pollIntervalMs, Date.now(), { phase: status });
      }
      if (status === "error") {
        const error = reply.error === null || reply.error === undefined ? undefined : object(reply.error, "AI/ML API error");
        return { status: "failed", failure: {
          code: typeof error?.name === "string" ? error.name : "AIMLAPI_GENERATION_FAILED",
          message: typeof error?.message === "string" ? error.message : "AI/ML API reported the generation failed",
        } };
      }
      assert(status === "completed", `AI/ML API returned an unknown generation status ${status || "(empty)"}`);
      return { status: "ready", handle: canonicalize({ ...handle, urls: videoUrls(reply.video) }) };
    },
    async collect(context): Promise<EndpointOutcome> {
      const handle = object(context.handle, "AI/ML API handle");
      const route = routeFor(context.need);
      assert(handle.route === capabilityKey(route.capability), "AI/ML API collection route differs");
      const urls = handle.urls;
      assert(Array.isArray(urls) && urls.length > 0, "AI/ML API generation completed without a video URL");
      const artifacts: BlobRef[] = [];
      for (const url of urls) {
        const downloaded = await client.download(text(url, "AI/ML API video URL"), "video/");
        artifacts.push(await context.resources.put(downloaded.bytes, downloaded.mediaType));
      }
      return { status: "completed", result: { value: packaged(route, artifacts) } };
    },
  };

  return defineEndpointPackage({
    module: providerModule,
    facet: "aimlapi",
    instance: options.instance,
    pool: options.pool,
    credentials: { apiKey: options.apiKey },
    credentialInputs: { apiKey: { label: "AI/ML API key (https://aimlapi.com/app/keys)" } },
    defaultConcurrency: options.defaultConcurrency ?? 2,
    actionLimits: { submit: { concurrency: 2 }, poll: { concurrency: 8 }, collect: { concurrency: 2 } },
    pricing: { kind: "page", url: "https://aimlapi.com/pricing" },
    capabilities: aimlapiRoutes.map((route) => route.result === "image"
      ? { capability: route.capability, returns: generationTypes.imageSet, lifecycle: "immediate" as const, supports, handler: imageHandler }
      : { capability: route.capability, returns: generationTypes.videoSet, lifecycle: "asynchronous" as const, supports, endpoint: videoEndpoint }),
  });
}
