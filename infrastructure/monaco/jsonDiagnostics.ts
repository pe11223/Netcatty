import type { Monaco } from '@monaco-editor/react';

/**
 * Config files opened in the built-in editor are routinely JSON-with-comments:
 * `appsettings.json`, `tsconfig.json` and friends are read by parsers that skip
 * `//` comments and tolerate trailing commas. Monaco's JSON service reports both
 * as syntax errors by default, so such a file lands covered in red squiggles
 * even though nothing is wrong with it.
 *
 * Keep syntax validation enabled and tolerate exactly the two constructs those
 * readers accept; real mistakes (missing quotes, stray brackets) still surface.
 */
export const configureJsonDiagnostics = (monaco: Monaco): void => {
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: true,
    comments: 'ignore',
    trailingCommas: 'ignore',
  });
};
