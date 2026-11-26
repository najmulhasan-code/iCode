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

export function readModelSettings(): ModelSettings {
  const config = vscode.workspace.getConfiguration('icode');
  const chosen = config.get<unknown>('provider');
  const provider = MODEL_PROVIDERS.find((known) => known === chosen) ?? 'anthropic';
  const model = text(config.get<unknown>('model'));
  const baseUrl = text(config.get<unknown>('baseUrl'));
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
