import { EndpointServiceError } from "@hypit/hypit/endpoint";
import { EndpointHttpError, retryAfterMs } from "@hypit/hypit/endpoint/http";

/** AI/ML API's `{ statusCode, message, error }` and `{ error: { code, message } }` envelopes, kept at the service boundary. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// Responses may mention a signed asset URL. Keep the reason, not its access capability.
export function safeAimlApiReason(value: string): string {
  return value.replace(/https?:\/\/\S+/giu, "[redacted-url]");
}

export class AimlApiServiceError extends EndpointServiceError {}

export class AimlApiHttpError extends EndpointHttpError {
  constructor(status: number, response: { readonly headers: Headers }, bodyText: string,
    request: { readonly method: string; readonly path: string; readonly model?: string }) {
    let body: Record<string, unknown> | undefined;
    try { body = record(JSON.parse(bodyText)); } catch { /* Non-JSON gateway failures still have HTTP evidence. */ }
    const error = record(body?.error);
    const code = text(error?.code) ?? text(body?.code) ?? "AIMLAPI_HTTP_ERROR";
    const message = Array.isArray(body?.message) ? body.message.filter((item) => typeof item === "string").join("; ") : body?.message;
    const reason = text(error?.message) ?? text(message)
      ?? (body === undefined ? text(bodyText.slice(0, 2000)) : undefined);
    const requestId = text(body?.requestId) ?? text(response.headers.get("x-request-id"));
    const facts = [
      `AI/ML API HTTP ${status}`, code, `${request.method} ${request.path}`,
      ...(request.model === undefined ? [] : [`model=${request.model}`]),
      ...(requestId === undefined ? [] : [`request=${requestId}`]),
    ];
    super(code, `${facts.join("; ")}${reason === undefined ? "" : `: ${safeAimlApiReason(reason)}`}`,
      status, retryAfterMs(response.headers));
  }
}
