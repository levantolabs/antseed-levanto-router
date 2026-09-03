export const ANTSEED_MODEL_CONTEXT_WINDOW = 280_000;
export const ANTSEED_MODEL_MAX_OUTPUT_TOKENS = 8_192;

export const WELL_KNOWN_SERVICE_API_PROTOCOLS = [
  'anthropic-messages',
  'openai-chat-completions',
  'openai-completions',
  'openai-responses',
  'openai-images',
  /**
   * Not an inference protocol -- a seller advertising a service on this
   * protocol is publishing a flat, non-metered price (e.g. a recurring
   * day-pass fee), not something servable via Provider.handleRequest.
   * Same pattern as 'openai-images' getting its own NetworkServiceOffer
   * `type`, one step further: this one isn't "content a model generates"
   * at all, so it's excluded from ModelHealthChecker's synthetic-completion
   * probing (see supportsHealthProbe) rather than probed like a real model.
   */
  'antseed-day-pass',
] as const;

export type ServiceApiProtocol = (typeof WELL_KNOWN_SERVICE_API_PROTOCOLS)[number];

const SERVICE_API_PROTOCOL_SET = new Set<string>(WELL_KNOWN_SERVICE_API_PROTOCOLS);

export function isKnownServiceApiProtocol(value: string): value is ServiceApiProtocol {
  return SERVICE_API_PROTOCOL_SET.has(value);
}
