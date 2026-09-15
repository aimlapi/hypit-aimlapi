import type { BlobRef, CanonicalValue, CapabilityRef, ModuleRef } from "@hypit/endpoint-kit";
import type { GenerationMediaValue, GenerationRequest } from "@hypit/generation";

/**
 * What AI/ML API accepts for each Hypit capability this Provider implements.
 *
 * AI/ML API is one OpenAI-compatible gateway in front of many labs' models,
 * and it publishes each model's request schema at
 * https://api.aimlapi.com/docs-json?model=<id>. The shapes below are those
 * schemas as of 2026-09-15; the enums are the gateway's, not Hypit's, so the
 * `supports` checks say exactly which port values the gateway refuses.
 *
 * Images come back synchronously from POST /v1/images/generations; videos are
 * jobs: POST /v2/video/generations returns an id that GET
 * /v2/video/generations?generation_id=<id> reports on until `completed` or
 * `error`.
 */

const SEEDANCE: ModuleRef = { name: "@hypit/seedance", version: "1" };
const GPT_IMAGE: ModuleRef = { name: "@hypit/gpt-image", version: "1" };
const NANO_BANANA: ModuleRef = { name: "@hypit/nano-banana", version: "1" };
const MINIMAX: ModuleRef = { name: "@hypit/minimax-h3", version: "1" };
const GROK: ModuleRef = { name: "@hypit/grok-imagine", version: "1" };

export type AimlapiWireRequest = {
  readonly model: string;
  readonly path: "/v1/images/generations" | "/v2/video/generations";
  readonly body: Readonly<Record<string, CanonicalValue>>;
};

/** Turn one attached artifact into something the gateway accepts in a URL field. */
export type AimlapiMediaResolver = (artifact: BlobRef) => Promise<string>;

export type AimlapiRoute = {
  readonly capability: CapabilityRef;
  readonly result: "image" | "video";
  /** Every port the route reads; anything else on a request is refused, not dropped. */
  readonly ports: readonly string[];
  /** Reject a request whose port values this gateway's schema does not take. */
  readonly supports: (request: GenerationRequest) => string | undefined;
  readonly compile: (request: GenerationRequest, resolve: AimlapiMediaResolver) => Promise<AimlapiWireRequest>;
};

function scalar(request: GenerationRequest, port: string): string | number | boolean | undefined {
  const value = request.ports[port]?.[0];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function media(request: GenerationRequest, port: string): readonly GenerationMediaValue[] {
  return (request.ports[port] ?? []).filter(
    (value): value is GenerationMediaValue => typeof value === "object" && value !== null && "artifact" in value,
  );
}

function present(request: GenerationRequest, port: string): boolean {
  return (request.ports[port]?.length ?? 0) > 0;
}

async function urls(items: readonly GenerationMediaValue[], resolve: AimlapiMediaResolver): Promise<string[]> {
  return await Promise.all(items.map((item) => resolve(item.artifact)));
}

/** Ports the route never reads are refused rather than silently dropped. */
function unknownPorts(request: GenerationRequest, known: readonly string[]): string | undefined {
  const extra = Object.keys(request.ports).filter((port) => !known.includes(port));
  return extra.length === 0 ? undefined : `AI/ML API does not take ${extra.sort().join(", ")} for this model`;
}

function oneOf(request: GenerationRequest, port: string, allowed: readonly string[], label: string): string | undefined {
  const value = scalar(request, port);
  if (value === undefined) return undefined;
  return allowed.includes(String(value)) ? undefined : `AI/ML API offers ${label} ${allowed.join(", ")}; ${port} ${String(value)} is not among them`;
}

function firstReason(...reasons: readonly (string | undefined)[]): string | undefined {
  return reasons.find((reason) => reason !== undefined);
}

// ---------------------------------------------------------------------------
// GPT Image 2 — POST /v1/images/generations, model openai/gpt-image-2.
// The gateway takes a pixel `size`, not an aspect ratio plus a tier, and it
// serves one 1K tier. Reference images go through /v1/images/edits, which this
// Provider does not implement yet, so the images port is refused.

const GPT_IMAGE_SIZES: Readonly<Record<string, string>> = {
  "auto": "auto",
  "1:1": "1024x1024",
  "2:3": "1024x1536",
  "3:4": "1024x1536",
  "9:16": "1024x1536",
  "3:2": "1536x1024",
  "4:3": "1536x1024",
  "16:9": "1536x1024",
};

const GPT_IMAGE_PORTS = ["prompt", "aspectRatio", "resolution", "background", "images"] as const;

const gptImage2: AimlapiRoute = {
  capability: { module: GPT_IMAGE, name: "gpt-image-2" },
  result: "image",
  ports: GPT_IMAGE_PORTS,
  supports: (request) => firstReason(
    unknownPorts(request, GPT_IMAGE_PORTS),
    present(request, "images") ? "AI/ML API reference images for GPT Image 2 go through image edits, which this Provider does not implement" : undefined,
    oneOf(request, "resolution", ["1K"], "GPT Image 2 at"),
    oneOf(request, "aspectRatio", Object.keys(GPT_IMAGE_SIZES), "GPT Image 2 sizes for"),
  ),
  compile: async (request) => ({
    model: "openai/gpt-image-2",
    path: "/v1/images/generations",
    body: {
      model: "openai/gpt-image-2",
      prompt: String(scalar(request, "prompt")),
      size: GPT_IMAGE_SIZES[String(scalar(request, "aspectRatio") ?? "auto")]!,
      ...(scalar(request, "background") === undefined ? {} : { background: String(scalar(request, "background")) }),
      response_format: "url",
    },
  }),
};

// ---------------------------------------------------------------------------
// Nano Banana 2 / Pro — POST /v1/images/generations. Reference images are
// accepted inline as base64 in `image_urls`; Pro routes them to its edit model.

const NANO_BANANA_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "3:2", "2:3", "5:4", "4:5"] as const;

function nanoBanana(name: "nano-banana-2" | "nano-banana-pro"): AimlapiRoute {
  const textModel = name === "nano-banana-2" ? "google/nano-banana-2" : "google/nano-banana-pro";
  const editModel = name === "nano-banana-2" ? "google/nano-banana-2" : "google/nano-banana-pro-edit";
  const ports = ["prompt", "images", "aspectRatio", "resolution", "outputFormat"];
  return {
    capability: { module: NANO_BANANA, name },
    result: "image",
    ports,
    supports: (request) => firstReason(
      unknownPorts(request, ports),
      oneOf(request, "aspectRatio", NANO_BANANA_RATIOS, `${name} ratios`),
      oneOf(request, "resolution", ["1K", "2K", "4K"], `${name} tiers`),
    ),
    compile: async (request, resolve) => {
      const references = media(request, "images");
      const model = references.length > 0 ? editModel : textModel;
      return {
        model,
        path: "/v1/images/generations",
        body: {
          model,
          prompt: String(scalar(request, "prompt")),
          ...(scalar(request, "aspectRatio") === undefined ? {} : { aspect_ratio: String(scalar(request, "aspectRatio")) }),
          ...(scalar(request, "resolution") === undefined ? {} : { resolution: String(scalar(request, "resolution")) }),
          ...(references.length > 0 ? { image_urls: await urls(references, resolve) } : {}),
          // outputFormat: the gateway chooses the container; the port is accepted and not forwarded.
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Seedance 2 family — POST /v2/video/generations. Each Hypit name is one
// gateway model; the gateway's resolution enum narrows per model.

const SEEDANCE_MODELS = {
  "seedance-2": { model: "bytedance/seedance-2-0", resolutions: ["480p", "720p", "1080p", "4k"] },
  "seedance-2-fast": { model: "bytedance/seedance-2-0-fast", resolutions: ["480p", "720p"] },
  "seedance-2-mini": { model: "bytedance/seedance-2-0-mini", resolutions: ["480p", "720p"] },
  "seedance-2.5": { model: "bytedance/seedance-2-5", resolutions: ["480p", "720p"] },
} as const;

function seedance(name: keyof typeof SEEDANCE_MODELS): AimlapiRoute {
  const { model, resolutions } = SEEDANCE_MODELS[name];
  const ports = ["prompt", "referenceImage", "referenceVideo", "referenceAudio", "firstFrame", "lastFrame",
    "resolution", "aspectRatio", "duration", "generateAudio", "webSearch"];
  return {
    capability: { module: SEEDANCE, name },
    result: "video",
    ports,
    supports: (request) => firstReason(
      unknownPorts(request, ports),
      oneOf(request, "resolution", resolutions, `${name} resolutions`),
      oneOf(request, "aspectRatio", ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], `${name} ratios`),
      scalar(request, "webSearch") === true ? "AI/ML API does not expose web search for Seedance" : undefined,
    ),
    compile: async (request, resolve) => {
      const first = media(request, "firstFrame"), last = media(request, "lastFrame");
      const images = media(request, "referenceImage"), videos = media(request, "referenceVideo"), audios = media(request, "referenceAudio");
      return {
        model,
        path: "/v2/video/generations",
        body: {
          model,
          prompt: String(scalar(request, "prompt")),
          resolution: String(scalar(request, "resolution")),
          aspect_ratio: String(scalar(request, "aspectRatio")),
          duration: Number(scalar(request, "duration")),
          generate_audio: scalar(request, "generateAudio") === true,
          ...(first.length > 0 ? { image_url: await resolve(first[0]!.artifact) } : {}),
          ...(last.length > 0 ? { last_image_url: await resolve(last[0]!.artifact) } : {}),
          ...(images.length > 0 ? { image_urls: await urls(images, resolve) } : {}),
          ...(videos.length > 0 ? { video_urls: await urls(videos, resolve) } : {}),
          ...(audios.length > 0 ? { audio_urls: await urls(audios, resolve) } : {}),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// MiniMax H3 — POST /v2/video/generations, model minimax/h3. The gateway's H3
// serves 2K only; the 768P tier is its h3-max sibling, which this Provider
// does not route to.

const MINIMAX_PORTS = ["prompt", "duration", "resolution", "aspectRatio", "referenceImage", "referenceVideo",
  "referenceAudio", "firstFrame", "lastFrame"] as const;

const minimaxH3: AimlapiRoute = {
  capability: { module: MINIMAX, name: "minimax-h3" },
  result: "video",
  ports: MINIMAX_PORTS,
  supports: (request) => firstReason(
    unknownPorts(request, MINIMAX_PORTS),
    oneOf(request, "resolution", ["2K"], "MiniMax H3 at"),
    oneOf(request, "aspectRatio", ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], "MiniMax H3 ratios"),
  ),
  compile: async (request, resolve) => {
    const first = media(request, "firstFrame"), last = media(request, "lastFrame");
    const images = media(request, "referenceImage"), videos = media(request, "referenceVideo"), audios = media(request, "referenceAudio");
    return {
      model: "minimax/h3",
      path: "/v2/video/generations",
      body: {
        model: "minimax/h3",
        prompt: String(scalar(request, "prompt")),
        duration: Number(scalar(request, "duration")),
        resolution: "2K",
        ...(scalar(request, "aspectRatio") === undefined ? {} : { ratio: String(scalar(request, "aspectRatio")) }),
        ...(first.length > 0 ? { image_url: await resolve(first[0]!.artifact) } : {}),
        ...(last.length > 0 ? { last_image_url: await resolve(last[0]!.artifact) } : {}),
        ...(images.length > 0 ? { reference_image_urls: await urls(images, resolve) } : {}),
        ...(videos.length > 0 ? { video_urls: await urls(videos, resolve) } : {}),
        ...(audios.length > 0 ? { audio_urls: await urls(audios, resolve) } : {}),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Grok Imagine Video — POST /v2/video/generations, model x-ai/grok-imagine-video.
// One image animates (image_url); further images are references.

const GROK_PORTS = ["prompt", "aspectRatio", "resolution", "duration", "images"] as const;

const grokImagineVideo: AimlapiRoute = {
  capability: { module: GROK, name: "grok-imagine-video" },
  result: "video",
  ports: GROK_PORTS,
  supports: (request) => firstReason(
    unknownPorts(request, GROK_PORTS),
    oneOf(request, "resolution", ["480p", "720p"], "Grok Imagine Video at"),
    oneOf(request, "aspectRatio", ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], "Grok Imagine Video ratios"),
  ),
  compile: async (request, resolve) => {
    const images = media(request, "images");
    const [animate, ...references] = await urls(images, resolve);
    return {
      model: "x-ai/grok-imagine-video",
      path: "/v2/video/generations",
      body: {
        model: "x-ai/grok-imagine-video",
        prompt: String(scalar(request, "prompt")),
        duration: Number(scalar(request, "duration")),
        resolution: String(scalar(request, "resolution")),
        aspect_ratio: String(scalar(request, "aspectRatio")),
        ...(animate === undefined ? {} : { image_url: animate }),
        ...(references.length > 0 ? { reference_images: references } : {}),
      },
    };
  },
};

export const aimlapiRoutes: readonly AimlapiRoute[] = [
  gptImage2,
  nanoBanana("nano-banana-2"),
  nanoBanana("nano-banana-pro"),
  seedance("seedance-2"),
  seedance("seedance-2-fast"),
  seedance("seedance-2-mini"),
  seedance("seedance-2.5"),
  minimaxH3,
  grokImagineVideo,
];

export function capabilityKey(ref: CapabilityRef): string {
  return `${ref.module.name}@${ref.module.version}#${ref.name}`;
}

const byCapability = new Map(aimlapiRoutes.map((route) => [capabilityKey(route.capability), route]));

export function aimlapiRouteForCapability(capability: CapabilityRef): AimlapiRoute | undefined {
  return byCapability.get(capabilityKey(capability));
}

/** The route's wire request, after the route's own support check. */
export async function compileAimlapiRequest(
  route: AimlapiRoute,
  request: GenerationRequest,
  resolve: AimlapiMediaResolver,
): Promise<AimlapiWireRequest> {
  const reason = route.supports(request);
  if (reason !== undefined) throw new Error(reason);
  return await route.compile(request, resolve);
}
