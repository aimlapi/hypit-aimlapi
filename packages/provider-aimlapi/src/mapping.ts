import type { ModuleRef } from "@hypit/hypit/protocol";
import type { GenerationWireMapping } from "@hypit/generation";

const NANO_BANANA: ModuleRef = { name: "@hypit/nano-banana", version: "1" };

/**
 * AI/ML API image models and the `POST /v1/images/generations` fields each documents
 * (https://api.aimlapi.com/docs-json?model=…&endpoint=openai%2Fimage-generations). The route model is
 * the AI/ML API model id. `output_format` has no AI/ML API field and is removed by routes.ts.
 */
export const aimlApiMappings: readonly GenerationWireMapping[] = [
  {
    capability: { module: NANO_BANANA, name: "nano-banana-2" }, result: "image", routes: [{ model: "nano-banana-2" }],
    fields: {
      prompt: { as: "value", field: "prompt" },
      images: { as: "urlArray", field: "image_urls" },
      aspectRatio: { as: "value", field: "aspect_ratio" },
      resolution: { as: "value", field: "resolution" },
      outputFormat: { as: "value", field: "output_format" },
    },
  },
  {
    capability: { module: NANO_BANANA, name: "nano-banana-pro" }, result: "image",
    routes: [
      { model: "google/nano-banana-pro-edit", whenPresent: ["images"] },
      { model: "google/nano-banana-pro" },
    ],
    fields: {
      prompt: { as: "value", field: "prompt" },
      images: { as: "urlArray", field: "image_urls" },
      aspectRatio: { as: "value", field: "aspect_ratio" },
      resolution: { as: "value", field: "resolution" },
      outputFormat: { as: "value", field: "output_format" },
    },
  },
];
