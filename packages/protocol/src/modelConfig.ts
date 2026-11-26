/** Request: choose the model the core uses for the chat requests that follow. */
export const SET_MODEL_METHOD = 'model/set';

export const MODEL_PROVIDERS = ['anthropic', 'openai-compatible'] as const;

/** The API format the model is reached through. */
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface SetModelParams {
  readonly provider: ModelProvider;
  /**
   * The credential for the provider. It travels only in this message and the
   * core keeps it in memory.
   */
  readonly apiKey: string;
  /** Model id as the provider names it. Required where the provider has no default. */
  readonly model?: string;
  /** Address of the API, for another host or a local server. */
  readonly baseUrl?: string;
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value !== '');
}

export function isSetModelParams(value: unknown): value is SetModelParams {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const params = value as Record<string, unknown>;
  return (
    typeof params.provider === 'string' &&
    (MODEL_PROVIDERS as readonly string[]).includes(params.provider) &&
    typeof params.apiKey === 'string' &&
    params.apiKey !== '' &&
    isOptionalText(params.model) &&
    isOptionalText(params.baseUrl)
  );
}
