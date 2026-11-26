import { MODEL_PROVIDERS, type ModelProvider } from '@icode/protocol';
import * as vscode from 'vscode';

/** The model the user has chosen in the settings. The key is not a setting. */
export interface ModelSettings {
  readonly provider: ModelProvider;
  readonly model?: string;
  readonly baseUrl?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Reads the model settings from the user's own settings only.
 *
 * These settings decide where a saved API key is sent. A workspace is
 * content that may come from someone else, for example a cloned repository,
 * so a value set by a workspace or a folder is never used. The manifest
 * declares the same settings with the `application` scope, which stops VS
 * Code from accepting them there in the first place.
 */
export function readModelSettings(): ModelSettings {
  const config = vscode.workspace.getConfiguration('icode');
  const user = (name: string): unknown => config.inspect<unknown>(name)?.globalValue;
  const chosen = user('provider');
  const provider = MODEL_PROVIDERS.find((known) => known === chosen) ?? 'anthropic';
  const model = text(user('model'));
  const baseUrl = text(user('baseUrl'));
  return {
    provider,
    ...(model === undefined ? {} : { model }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}

/** Name under which the key of a provider is kept in VS Code's secret storage. */
export function secretName(provider: ModelProvider): string {
  return `icode.apiKey.${provider}`;
}
