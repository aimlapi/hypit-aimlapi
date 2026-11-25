import {
  createRuntimeEndpointAdapterFacet,
  runtimeConfigCredentialRef,
  runtimeConfigActionLimits,
  runtimeConfigExact,
  runtimeConfigObject,
  runtimeConfigPositiveInteger,
} from "@hypit/runtime-local/extension";

import { createAimlApiProvider } from "./provider.js";

/**
 * The service address is fixed to https://api.aimlapi.com: the Profile names only the key's
 * CredentialRef, so the key cannot be pointed at another host.
 */
const adapter = createRuntimeEndpointAdapterFacet({
  use: "@hypit/provider-aimlapi",
  activate(context) {
    if (context.pool === undefined) throw new Error("AI/ML API Provider Pool is required");
    const config = runtimeConfigObject(context.config, "AI/ML API");
    runtimeConfigExact(config, ["apiKey", "defaultConcurrency", "actionLimits", "requestTimeoutMs"], "AI/ML API");
    const apiKey = runtimeConfigCredentialRef(config.apiKey, "AI/ML API apiKey");
    if (apiKey === undefined) throw new Error("AI/ML API apiKey CredentialRef is required");
    const actionLimits = runtimeConfigActionLimits(config.actionLimits);
    const defaultConcurrency = runtimeConfigPositiveInteger(config.defaultConcurrency, "AI/ML API defaultConcurrency");
    const requestTimeoutMs = runtimeConfigPositiveInteger(config.requestTimeoutMs, "AI/ML API requestTimeoutMs");
    return {
      endpoint: createAimlApiProvider({
        instance: context.instance,
        pool: context.pool,
        apiKey,
        ...(defaultConcurrency === undefined ? {} : { defaultConcurrency }),
        ...(actionLimits === undefined ? {} : { actionLimits }),
        ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      }),
    };
  },
});

export const hypitPackage = {
  format: "hypit.package@1" as const,
  facets: [adapter],
};

export default hypitPackage;
