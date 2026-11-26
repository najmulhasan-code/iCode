import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Manifest {
  readonly contributes: {
    readonly configuration: {
      readonly properties: Readonly<Record<string, { readonly scope?: string }>>;
    };
  };
}

const manifest = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as Manifest;

describe('the extension manifest', () => {
  // These settings decide where a saved API key is sent. With the
  // application scope VS Code accepts them from the user's own settings
  // only, so a cloned repository cannot change them through its workspace
  // settings.
  it.each(['icode.provider', 'icode.model', 'icode.baseUrl'])(
    'does not let a workspace set %s',
    (name) => {
      expect(manifest.contributes.configuration.properties[name]?.scope).toBe('application');
    },
  );

  it('declares a scope for every setting, so a new one cannot be added without a decision', () => {
    for (const [name, property] of Object.entries(manifest.contributes.configuration.properties)) {
      expect(property.scope, name).toBeDefined();
    }
  });
});
