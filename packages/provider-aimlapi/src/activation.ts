import {
  createRuntimeEndpointAdapterFacet,
  runtimeConfigCredentialRef,
  runtimeConfigExact,
  runtimeConfigObject,
  runtimeConfigPositiveInteger,
  runtimeConfigString,
} from "@hypit/runtime-kit";

import { createAimlapiProvider, providerModule } from "./provider.js";

const adapter = createRuntimeEndpointAdapterFacet({
  use: providerModule.name,
  activate(context) {
    if (context.pool === undefined) throw new Error("AI/ML API Provider Pool is required");
    const config = runtimeConfigObject(context.config, "AI/ML API");
    runtimeConfigExact(config, [
      "apiKey", "baseUrl", "defaultConcurrency", "pollIntervalMs", "requestTimeoutMs", "downloadTimeoutMs",
    ], "AI/ML API");
    const apiKey = runtimeConfigCredentialRef(config.apiKey, "AI/ML API apiKey");
    if (apiKey === undefined) throw new Error("AI/ML API requires apiKey");
    const optional = {
      baseUrl: runtimeConfigString(config.baseUrl, "AI/ML API baseUrl"),
      defaultConcurrency: runtimeConfigPositiveInteger(config.defaultConcurrency, "AI/ML API defaultConcurrency"),
      pollIntervalMs: runtimeConfigPositiveInteger(config.pollIntervalMs, "AI/ML API pollIntervalMs"),
      requestTimeoutMs: runtimeConfigPositiveInteger(config.requestTimeoutMs, "AI/ML API requestTimeoutMs"),
      downloadTimeoutMs: runtimeConfigPositiveInteger(config.downloadTimeoutMs, "AI/ML API downloadTimeoutMs"),
    };
    return {
      endpoint: createAimlapiProvider({
        instance: context.instance,
        pool: context.pool,
        apiKey,
        // Only settings the project actually wrote reach the Provider.
        ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
      }),
    };
  },
});

export default {
  format: "hypit.node-package@1" as const,
  hostFacets: [adapter],
};
