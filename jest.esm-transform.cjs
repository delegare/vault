// Jest transformer for ESM-only dependencies that live in node_modules.
//
// Some deps ship as pure ESM (e.g. jose@6 — `"type": "module"`, ESM-only
// exports). Jest runs on CommonJS, so those files must be transpiled to CJS
// before they can be `require`d. ts-jest — which handles our project's .ts —
// deliberately refuses to compile anything inside node_modules, so it cannot do
// this. We therefore route node_modules JavaScript through this lightweight
// transpile-only transformer.
//
// Wiring (see package.json "jest"):
//   • "^.+\\.tsx?$"            -> ts-jest      (project TS: type-checked + jest.mock hoisting)
//   • "^.+\\.(js|jsx|cjs|mjs)$" -> this file    (node_modules ESM: transpile only)
//   • transformIgnorePatterns allowlists which node_modules deps reach here.
const ts = require('typescript');

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(sourceText, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        allowJs: true,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
      fileName: sourcePath,
    });
    return { code: outputText };
  },
};
