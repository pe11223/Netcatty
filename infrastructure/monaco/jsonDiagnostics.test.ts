import assert from 'node:assert/strict';
import test from 'node:test';
import type { Monaco } from '@monaco-editor/react';
import { configureJsonDiagnostics } from './jsonDiagnostics';

const fakeMonaco = () => {
  const calls: unknown[] = [];
  const monaco = {
    languages: {
      json: {
        jsonDefaults: {
          setDiagnosticsOptions: (options: unknown) => calls.push(options),
        },
      },
    },
  } as unknown as Monaco;
  return { monaco, calls };
};

test('JSON diagnostics tolerate comments and trailing commas', () => {
  const { monaco, calls } = fakeMonaco();
  configureJsonDiagnostics(monaco);
  assert.deepEqual(calls, [
    {
      validate: true,
      allowComments: true,
      comments: 'ignore',
      trailingCommas: 'ignore',
    },
  ]);
});

test('JSON diagnostics keep syntax validation on', () => {
  const { monaco, calls } = fakeMonaco();
  configureJsonDiagnostics(monaco);
  const options = calls[0] as { validate?: boolean };
  assert.equal(options.validate, true);
});
