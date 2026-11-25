import {
  compileWireRequest,
  selectWireModelForRequest,
  generationTypes,
  sealGeneratedImageSet,
} from "@hypit/generation";
import type { GenerationArtifactUrlResolver, GenerationRequest, GenerationWireMapping } from "@hypit/generation";
import { canonicalize } from "@hypit/hypit/protocol";
import type { BlobRef, CapabilityRef, CanonicalValue, StoredValue, TypeRef } from "@hypit/hypit/protocol";
import type { EndpointRequest, EndpointSupport } from "@hypit/hypit/endpoint";
import { aimlApiMappings } from "./mapping.js";

export type AimlApiPreparedRequest = {
  /** AI/ML API model id sent as `model`. */
  readonly model: string;
  readonly compile: (resolve: GenerationArtifactUrlResolver) => Promise<Record<string, unknown>>;
};

export type AimlApiRoute = GenerationWireMapping & {
  readonly key: string;
  readonly returns: TypeRef;
  readonly supports: (request: EndpointRequest) => EndpointSupport;
  readonly prepare: (constraints: CanonicalValue) => AimlApiPreparedRequest;
  readonly packageResult: (artifacts: readonly BlobRef[]) => StoredValue;
};

function scalar(request: GenerationRequest, port: string): string | number | boolean | undefined {
  const value = request.ports[port]?.[0];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}
function count(request: GenerationRequest, port: string): number {
  return request.ports[port]?.length ?? 0;
}

/** Aspect ratios each AI/ML API model documents. */
const NANO_BANANA_2_RATIOS = ["auto", "21:9", "1:1", "4:3", "3:2", "2:3", "5:4", "4:5", "3:4", "16:9", "9:16"];
const NANO_BANANA_PRO_RATIOS = ["1:1", "9:16", "16:9", "3:4", "4:3"];
const NANO_BANANA_PRO_EDIT_IMAGES = 5;

/** AI/ML API's documented input ranges for each mapped model, checked before any reference is resolved. */
function rejection(mapping: GenerationWireMapping, request: GenerationRequest): string | undefined {
  const { name } = mapping.capability;
  const ratio = String(scalar(request, "aspectRatio"));
  if (name === "nano-banana-2" && !NANO_BANANA_2_RATIOS.includes(ratio)) {
    return `AI/ML API Nano Banana 2 does not render ${ratio}`;
  }
  if (name === "nano-banana-pro") {
    const edit = count(request, "images") > 0;
    if (edit && count(request, "images") > NANO_BANANA_PRO_EDIT_IMAGES) {
      return `AI/ML API Nano Banana Pro edits at most ${NANO_BANANA_PRO_EDIT_IMAGES} images`;
    }
    // The edit model takes the framing from the reference when no ratio is given; text-to-image needs one.
    if (!(edit && ratio === "auto") && !NANO_BANANA_PRO_RATIOS.includes(ratio)) {
      return `AI/ML API Nano Banana Pro does not render ${ratio}`;
    }
  }
  return undefined;
}

/** Fields the model package requires that AI/ML API does not take. */
function normalize(input: Record<string, unknown>): Record<string, unknown> {
  delete input.output_format;
  if (input.aspect_ratio === "auto" && input.image_urls !== undefined) delete input.aspect_ratio;
  return input;
}

function capabilityKey(capability: CapabilityRef): string {
  return `${capability.module.name}@${capability.module.version}#${capability.name}`;
}

export const aimlApiRoutes: readonly AimlApiRoute[] = aimlApiMappings.map((mapping) => ({
  ...mapping,
  key: capabilityKey(mapping.capability),
  returns: generationTypes.imageSet,
  supports: (request) => {
    const reason = rejection(mapping, request.constraints as unknown as GenerationRequest);
    return reason === undefined ? { status: "supported" } : { status: "unsupported", reason };
  },
  prepare: (constraints) => {
    const request = constraints as unknown as GenerationRequest;
    const reason = rejection(mapping, request);
    if (reason !== undefined) throw new Error(reason);
    const model = selectWireModelForRequest(mapping, request);
    return {
      model,
      compile: async (resolve) => ({
        model,
        ...normalize((await compileWireRequest(mapping, request, resolve)).input as Record<string, unknown>),
      }),
    };
  },
  packageResult: (artifacts) => ({ kind: "inline", value: canonicalize(sealGeneratedImageSet({ images: artifacts })) }),
}));

const byCapability = new Map(aimlApiRoutes.map((route) => [route.key, route]));

export function aimlApiRouteForCapability(capability: CapabilityRef): AimlApiRoute | undefined {
  return byCapability.get(capabilityKey(capability));
}
