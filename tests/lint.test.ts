import { assertEquals, assertStringIncludes } from "@std/assert";

import { parseConfigText } from "#imports";
import plugin from "#lint";
import { normalizePath, parentDir } from "#paths";

const FIXTURE = parentDir(normalizePath(import.meta.url)) + "/fixture";
const rules = await import("#lint");

/**
 * Runs the plugin against a source string as if it lived at the given path
 * inside the fixture project, and keeps only diagnostics of one rule.
 */
function lint(
  relativePath: string,
  source: string,
  rule: string,
): Deno.lint.Diagnostic[] {
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    `${FIXTURE}/${relativePath}`,
    source,
  );
  return diagnostics.filter((d) => d.id === `import-check/${rule}`);
}

/** Applies the reported fixes to the source, right to left. */
function applyFixes(
  source: string,
  diagnostics: Deno.lint.Diagnostic[],
): string {
  const fixes = diagnostics.flatMap((d) => d.fix ?? []);
  fixes.sort((a, b) => b.range[0] - a.range[0]);
  let result = source;
  for (const fix of fixes) {
    result = result.slice(0, fix.range[0]) + (fix.text ?? "") +
      result.slice(fix.range[1]);
  }
  return result;
}

Deno.test("no-parent-import replaces a parent import with its package export", () => {
  const source = `import { utils } from "../utils/mod.ts";\n`;
  const found = lint("src/components/mod.ts", source, "no-parent-import");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, `Use "#utils" instead`);
  assertEquals(applyFixes(source, found), `import { utils } from "#utils";\n`);
});

Deno.test("no-parent-import preserves the original quote style", () => {
  const source = `import { utils } from '../utils/mod.ts';\n`;
  const found = lint("src/components/mod.ts", source, "no-parent-import");

  assertEquals(applyFixes(source, found), `import { utils } from '#utils';\n`);
});

Deno.test("no-parent-import covers re-exports and dynamic imports", () => {
  const source = `export * from "../utils/mod.ts";\n` +
    `export { utils } from "../utils/mod.ts";\n` +
    `const mod = await import("../utils/mod.ts");\n`;
  const found = lint("src/components/mod.ts", source, "no-parent-import");

  assertEquals(found.length, 3);
});

Deno.test("no-parent-import reports without a fix when no entry matches", () => {
  const source = `import { thing } from "../unmapped/mod.ts";\n`;
  const found = lint("src/components/mod.ts", source, "no-parent-import");

  assertEquals(found.length, 1);
  assertEquals(found[0].fix ?? [], []);
  assertStringIncludes(found[0].hint ?? "", 'No "#" entry');
});

Deno.test("no-parent-import ignores same-folder and package imports", () => {
  const source = `import { internal } from "./internal.ts";\n` +
    `import { utils } from "#utils";\n` +
    `import { html } from "#lit";\n`;
  const found = lint("src/components/mod.ts", source, "no-parent-import");

  assertEquals(found.length, 0);
});

Deno.test("no-barrel-bypass rejects reaching past a module entry point", () => {
  const source = `import { internal } from "#components/internal.ts";\n`;
  const found = lint("src/app-store.ts", source, "no-barrel-bypass");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, `Import from "#components" instead`);
});

Deno.test("no-barrel-bypass allows the exact module specifier", () => {
  const source = `import { components } from "#components";\n`;
  const found = lint("src/app-store.ts", source, "no-barrel-bypass");

  assertEquals(found.length, 0);
});

Deno.test("enforce-layer-order rejects importing an earlier module", () => {
  const source = `import { components } from "#components";\n`;
  const found = lint("src/utils/mod.ts", source, "enforce-layer-order");

  assertEquals(found.length, 1);
  assertStringIncludes(
    found[0].message,
    `"#utils" must not import "#components"`,
  );
});

Deno.test("enforce-layer-order allows importing a later module", () => {
  const source = `import { utils } from "#utils";\n` +
    `import type { Thing } from "#types";\n`;
  const found = lint("src/components/mod.ts", source, "enforce-layer-order");

  assertEquals(found.length, 0);
});

Deno.test("enforce-layer-order rejects a module importing its own entry point", () => {
  const source = `import { components } from "#components";\n`;
  const found = lint(
    "src/components/internal.ts",
    source,
    "enforce-layer-order",
  );

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, "must not import its own entry point");
});

Deno.test("enforce-layer-order treats a deep specifier as its owning module", () => {
  const source = `import { internal } from "#components/internal.ts";\n`;
  const found = lint("src/utils/mod.ts", source, "enforce-layer-order");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, `must not import "#components"`);
});

Deno.test("enforce-layer-order ignores files outside every declared module", () => {
  const source = `import { components } from "#components";\n`;
  const found = lint("scripts/build.ts", source, "enforce-layer-order");

  assertEquals(found.length, 0);
});

// Deno parses deno.json as JSONC regardless of its extension, so a real
// project's config may contain comments and trailing commas even though the
// fixture above is plain JSON.
Deno.test("config parsing tolerates JSONC comments and trailing commas", () => {
  const text = `{
  // A line comment.
  "imports": {
    "#utils": "./src/utils/mod.ts",
    /* A block comment. */
    "#types": "./src/types/mod.ts",
  },
}`;

  assertEquals(parseConfigText(text), {
    imports: {
      "#utils": "./src/utils/mod.ts",
      "#types": "./src/types/mod.ts",
    },
  });
});

Deno.test("config parsing leaves comment-like text inside strings alone", () => {
  const text = `{
  "imports": {
    "#a": "./src/a//b.ts",
    "#b": "./src/c/*d*/e.ts",
    "#c": "./src/quote\\"//x.ts"
  }
}`;

  assertEquals(parseConfigText(text), {
    imports: {
      "#a": "./src/a//b.ts",
      "#b": "./src/c/*d*/e.ts",
      "#c": './src/quote"//x.ts',
    },
  });
});

Deno.test("a JSONC config on disk is read end to end", () => {
  // Guards the wiring, not just the parser: a config with comments is written
  // to a temp project so this fails if the plugin ever calls JSON.parse.
  const dir = normalizePath(Deno.makeTempDirSync());
  Deno.mkdirSync(`${dir}/src/utils`, { recursive: true });
  Deno.writeTextFileSync(
    `${dir}/deno.json`,
    `{\n  // Layered bottom up.\n  "imports": {\n    "#utils": "./src/utils/mod.ts",\n  },\n}\n`,
  );

  const source = `import { utils } from "../utils/mod.ts";\n`;
  const found = Deno.lint.runPlugin(
    plugin,
    `${dir}/src/components/mod.ts`,
    source,
  ).filter((d) => d.id === "import-check/no-parent-import");

  assertEquals(found.length, 1);
  assertEquals(applyFixes(source, found), `import { utils } from "#utils";\n`);

  Deno.removeSync(dir, { recursive: true });
});

Deno.test("a file entry owns only itself, not its whole directory", () => {
  // "#app-store" maps to "./src/app-store.ts", so "src" must not become a
  // module directory that swallows every sibling.
  const source = `import { components } from "#components";\n`;
  const found = lint("src/utils/mod.ts", source, "enforce-layer-order");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, `"#utils" must not import`);
});

Deno.test("no-relative-bypass rejects reaching past a subfolder entry point", () => {
  const source = `import { internal } from "./components/internal.ts";\n`;
  const found = lint("src/mod.ts", source, "no-relative-bypass");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, `reaches past the entry point`);
  assertStringIncludes(found[0].hint ?? "", `"./components/mod.ts"`);
});

Deno.test("no-relative-bypass rejects descending more than one level", () => {
  const source = `import { deep } from "./src/components/mod.ts";\n`;
  const found = lint("mod.ts", source, "no-relative-bypass");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].hint ?? "", `"./src/mod.ts"`);
});

Deno.test("no-relative-bypass allows a sibling and a child entry point", () => {
  const source = `import { helper } from "./helper.ts";\n` +
    `import { components } from "./components/mod.ts";\n` +
    `import { legacy } from "./components/index.ts";\n`;
  const found = lint("src/mod.ts", source, "no-relative-bypass");

  assertEquals(found.length, 0);
});

Deno.test("entry points are recognized whatever the extension", () => {
  const source = `import { a } from "./components/mod.tsx";\n` +
    `import { b } from "./components/mod.js";\n` +
    `import { c } from "./components/mod.mts";\n`;
  const found = lint("src/mod.ts", source, "no-relative-bypass");

  assertEquals(found.length, 0);
});

Deno.test("no-relative-bypass ignores parent and package specifiers", () => {
  const source = `import { utils } from "../utils/deep/thing.ts";\n` +
    `import { html } from "npm:lit@3/directives/class-map.js";\n`;
  const found = lint("src/components/mod.ts", source, "no-relative-bypass");

  assertEquals(found.length, 0);
});

Deno.test("enforce-mod-file rejects a file named index.ts", () => {
  const source = `export const thing = 1;\n`;
  const found = lint("src/components/index.ts", source, "enforce-mod-file");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, `must be named "mod.ts"`);
});

Deno.test("enforce-mod-file catches index files of any extension", () => {
  const source = `import { a } from "./components/index.jsx";\n` +
    `import { b } from "./components/index.mts";\n`;
  const found = lint("src/index.js", source, "enforce-mod-file");

  // Two specifiers plus the file name itself.
  assertEquals(found.length, 3);
});

Deno.test("enforce-mod-file rejects specifiers pointing at an index file", () => {
  const source = `import { a } from "./components/index.ts";\n` +
    `import { b } from "#components/index.ts";\n`;
  const found = lint("src/mod.ts", source, "enforce-mod-file");

  assertEquals(found.length, 2);
  assertStringIncludes(found[0].message, "points at an index file");
});

Deno.test("enforce-mod-file leaves mod files and packages alone", () => {
  const source = `import { a } from "./components/mod.ts";\n` +
    `import { b } from "npm:some-pkg/index.ts";\n`;
  const found = lint("src/mod.ts", source, "enforce-mod-file");

  assertEquals(found.length, 0);
});

Deno.test("no-self-import covers every statically known dependency form", () => {
  const source = `import { a } from "./internal.ts";\n` +
    `export { b } from "./internal.ts";\n` +
    `export * from "./internal.ts";\n` +
    `const mod = await import("./internal.ts");\n` +
    `export type T = import("./internal.ts").T;\n`;
  const found = lint("src/components/internal.ts", source, "no-self-import");

  assertEquals(found.length, 5);
  assertStringIncludes(found[0].message, "imports the current file itself");
  assertStringIncludes(found[0].hint ?? "", "circular dependency");
});

Deno.test("no-self-import resolves exact and deep aliases", () => {
  const exact = lint(
    "src/components/mod.ts",
    `import { components } from "#components";\n`,
    "no-self-import",
  );
  const deep = lint(
    "src/components/internal.ts",
    `import { internal } from "#components/internal.ts?raw";\n`,
    "no-self-import",
  );

  assertEquals(exact.length, 1);
  assertEquals(deep.length, 1);
});

Deno.test("no-self-import leaves other modules alone", () => {
  const source = `import { helper } from "./helper.ts";\n` +
    `import { components } from "#components";\n` +
    `import { html } from "npm:lit";\n`;
  const found = lint("src/components/internal.ts", source, "no-self-import");

  assertEquals(found.length, 0);
});

Deno.test("no-wildcard-import requires explicit dependencies", () => {
  const source = `import * as internal from "./internal.ts";\n` +
    `import type * as types from "./types.ts";\n`;
  const found = lint("src/components/mod.ts", source, "no-wildcard-import");

  assertEquals(found.length, 2);
  assertStringIncludes(found[0].message, "Wildcard imports");
  assertStringIncludes(found[0].hint ?? "", "import { ... }");
});

Deno.test("no-wildcard-import allows explicit and side-effect imports", () => {
  const source = `import value from "./value.ts";\n` +
    `import { internal } from "./internal.ts";\n` +
    `import type { Types } from "./types.ts";\n` +
    `import "./setup.ts";\n`;
  const found = lint("src/components/mod.ts", source, "no-wildcard-import");

  assertEquals(found.length, 0);
});

Deno.test("no-duplicate-import-source reports every repeated source", () => {
  const source = `import { a } from "#utils";\n` +
    `import type { Utils } from "#utils";\n` +
    `import "#utils";\n`;
  const found = lint("src/mod.ts", source, "no-duplicate-import-source");

  assertEquals(found.length, 2);
  assertStringIncludes(found[0].message, `"#utils" is duplicated`);
  assertStringIncludes(found[0].hint ?? "", "Combine imports");
});

Deno.test("no-duplicate-import-source keeps a type-only and a bare import", () => {
  const source = `import type { Utils } from "#utils";\n` +
    `import "#utils";\n`;
  const found = lint("src/mod.ts", source, "no-duplicate-import-source");

  assertEquals(found.length, 0);
});

Deno.test("no-duplicate-import-source compares exact static sources", () => {
  const source = `import { a } from "#utils";\n` +
    `import { b } from "#components";\n` +
    `export { c } from "#utils";\n` +
    `const mod = await import("#utils");\n`;
  const found = lint("src/mod.ts", source, "no-duplicate-import-source");

  assertEquals(found.length, 0);
});

Deno.test("enforce-import-order requires blank lines between groups", () => {
  const source = `import { a } from "npm:zod";\n` +
    `import { b } from "#components";\n`;
  const found = lint("src/mod.ts", source, "enforce-import-order");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, "A blank line must separate");
});

Deno.test("enforce-import-order rejects a group out of place", () => {
  const source = `import { b } from "./helper.ts";\n\n` +
    `import { a } from "npm:zod";\n`;
  const found = lint("src/mod.ts", source, "enforce-import-order");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, "package imports must come before");
});

Deno.test("enforce-import-order rejects a blank line inside a group", () => {
  const source = `import { a } from "#app-store";\n\n` +
    `import { b } from "#components";\n`;
  const found = lint("src/mod.ts", source, "enforce-import-order");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, "must not be split by a blank line");
});

Deno.test("enforce-import-order sorts within a group by code point", () => {
  const source = `import { b } from "#components";\n` +
    `import { a } from "#app-store";\n`;
  const found = lint("src/mod.ts", source, "enforce-import-order");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, `"#app-store" must come before`);
});

Deno.test("enforce-import-order accepts and rewrites a full three-group block", () => {
  const source = `import { c } from "./helper.ts";\n` +
    `import { b } from "#components";\n` +
    `import { a } from "npm:zod";\n`;
  const found = lint("src/mod.ts", source, "enforce-import-order");

  assertEquals(
    applyFixes(source, found),
    `import { a } from "npm:zod";\n\n` +
      `import { b } from "#components";\n\n` +
      `import { c } from "./helper.ts";\n`,
  );
});

Deno.test("enforce-import-order leaves a correct block alone", () => {
  const source = `import { a } from "@std/assert";\n` +
    `import { z } from "npm:zod";\n\n` +
    `import { b } from "#components";\n\n` +
    `import { c } from "./helper.ts";\n`;
  const found = lint("src/mod.ts", source, "enforce-import-order");

  assertEquals(found.length, 0);
});

Deno.test("enforce-import-order reports without a fix when comments would be lost", () => {
  const source = `import { b } from "#components";\n` +
    `// Why this import exists.\n` +
    `import { a } from "#app-store";\n`;
  const found = lint("src/mod.ts", source, "enforce-import-order");

  assertEquals(found.length, 1);
  assertEquals(found[0].fix ?? [], []);
});

Deno.test("enforce-import-order sorts names inside the braces", () => {
  const source = `import { normalizePath, baseName } from "#paths";\n`;
  const found = lint("src/mod.ts", source, "enforce-import-order");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, `"baseName" must come before`);
  assertEquals(
    applyFixes(source, found),
    `import { baseName, normalizePath } from "#paths";\n`,
  );
});

Deno.test("enforce-import-order ignores case and type modifiers when sorting", () => {
  const source = `import { zeta, Alpha, type Beta } from "#paths";\n`;
  const found = lint("src/mod.ts", source, "enforce-import-order");

  assertEquals(
    applyFixes(source, found),
    `import { Alpha, type Beta, zeta } from "#paths";\n`,
  );
});

Deno.test("enforce-import-order keeps a multi-line member list broken", () => {
  const source = `import {\n  zeta,\n  alpha,\n} from "#paths";\n`;
  const found = lint("src/mod.ts", source, "enforce-import-order");

  assertEquals(
    applyFixes(source, found),
    `import {\n  alpha,\n  zeta,\n} from "#paths";\n`,
  );
});

Deno.test("enforce-import-order leaves default and namespace bindings in place", () => {
  const source = `import plugin, { zebra, apple } from "#lint";\n`;
  const found = lint("src/mod.ts", source, "enforce-import-order");

  assertEquals(
    applyFixes(source, found),
    `import plugin, { apple, zebra } from "#lint";\n`,
  );
});

Deno.test("enforce-import-order accepts sorted names", () => {
  const source = `import { alpha, type Beta, zeta } from "#paths";\n`;
  const found = lint("src/mod.ts", source, "enforce-import-order");

  assertEquals(found.length, 0);
});

Deno.test("enforce-layer-order catches a relative import of the own entry point", () => {
  const source = `import { x } from "./mod.ts";\n`;
  const found = lint(
    "src/components/internal.ts",
    source,
    "enforce-layer-order",
  );

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, "must not import its own entry point");
  assertStringIncludes(found[0].message, "Import the sibling file directly");
});

Deno.test("prefer-alias-import rewrites a path that has an alias", () => {
  const source = `import { c } from "./components/mod.ts";\n`;
  const found = lint("src/mod.ts", source, "prefer-alias-import");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, `declared as "#components"`);
  assertEquals(
    applyFixes(source, found),
    `import { c } from "#components";\n`,
  );
});

Deno.test("prefer-alias-import leaves same-folder siblings alone", () => {
  // Every other rule recommends this form, and a lint plugin loaded by path
  // cannot use aliases at all.
  const source = `import { s } from "./app-store.ts";\n`;
  const found = lint("src/mod.ts", source, "prefer-alias-import");

  assertEquals(found.length, 0);
});

Deno.test("prefer-alias-import ignores paths with no declared entry", () => {
  const source = `import { u } from "./unmapped/mod.ts";\n`;
  const found = lint("src/mod.ts", source, "prefer-alias-import");

  assertEquals(found.length, 0);
});

Deno.test('the CLI reports unused "#" imports', async () => {
  // End to end on purpose: the entry point is passed the way a user types it,
  // as a relative path, which is what the config lookup has to cope with.
  const dir = normalizePath(Deno.makeTempDirSync());
  Deno.writeTextFileSync(
    `${dir}/deno.json`,
    `{ "imports": { "#used": "./used.ts", "#unused": "./unused.ts" } }\n`,
  );
  Deno.writeTextFileSync(`${dir}/used.ts`, `export const a = 1;\n`);
  Deno.writeTextFileSync(`${dir}/unused.ts`, `export const b = 2;\n`);
  Deno.writeTextFileSync(
    `${dir}/main.ts`,
    `import { a } from "#used";\n\nexport const c = a;\n`,
  );

  const cli = parentDir(parentDir(normalizePath(import.meta.url))) +
    "/src/mod.ts";
  const { code, stdout } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", cli, "main.ts"],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const output = new TextDecoder().decode(stdout);

  assertEquals(code, 1);
  assertStringIncludes(output, `1 unused "#" internal import alias`);
  assertStringIncludes(output, "#unused");
  assertEquals(output.includes("#used\u{1b}"), false);

  Deno.removeSync(dir, { recursive: true });
});

Deno.test('the CLI reports "#" aliases that share a target', async () => {
  const dir = normalizePath(Deno.makeTempDirSync());
  Deno.writeTextFileSync(
    `${dir}/deno.json`,
    `{ "imports": {
      "#first": "./shared.ts",
      "#second": "./shared.ts",
      "#one/": "./lib/",
      "#two/": "./lib/"
    } }\n`,
  );
  Deno.writeTextFileSync(`${dir}/shared.ts`, `export const value = 1;\n`);
  Deno.mkdirSync(`${dir}/lib`);
  Deno.writeTextFileSync(`${dir}/lib/value.ts`, `export const value = 2;\n`);
  Deno.writeTextFileSync(
    `${dir}/main.ts`,
    `import { value as first } from "#first";\n` +
      `import { value as one } from "#one/value.ts";\n` +
      `import { value as second } from "#second";\n` +
      `import { value as two } from "#two/value.ts";\n\n` +
      `export const values = [first, one, second, two];\n`,
  );

  const cli = parentDir(parentDir(normalizePath(import.meta.url))) +
    "/src/mod.ts";
  const { code, stdout } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", cli, "main.ts"],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const output = new TextDecoder().decode(stdout);

  assertEquals(code, 1);
  assertStringIncludes(output, `2 duplicate "#" internal import alias targets`);
  assertStringIncludes(output, "#first, #second");
  assertStringIncludes(output, "#one/, #two/");
  assertStringIncludes(output, "./shared.ts");
  assertStringIncludes(output, "./lib/");
  assertStringIncludes(
    output,
    `Every "#" internal import alias is used`,
  );

  Deno.removeSync(dir, { recursive: true });
});

Deno.test("no-absolute-import rejects a leading slash", () => {
  const source = `import { c } from "/src/components/internal.ts";\n`;
  const found = lint("src/utils/mod.ts", source, "no-absolute-import");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, "is an absolute path");
});

Deno.test("no-absolute-import leaves relative and package specifiers alone", () => {
  const source = `import { a } from "./internal.ts";\n` +
    `import { b } from "#types";\n` +
    `import { c } from "npm:lit@3";\n`;
  const found = lint("src/components/mod.ts", source, "no-absolute-import");

  assertEquals(found.length, 0);
});

Deno.test("rules see a type-level import expression", () => {
  // `type T = import("...")` reaches another module without an import
  // statement, so it must not become a way around the layer order.
  const source = `type T = import("#components").Thing;\nexport type U = T;\n`;
  const found = lint("src/utils/mod.ts", source, "enforce-layer-order");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, `must not import "#components"`);
});

Deno.test("a type-level import of the own entry point is caught", () => {
  const source = `type T = import("./mod.ts").Thing;\nexport type U = T;\n`;
  const found = lint(
    "src/components/internal.ts",
    source,
    "enforce-layer-order",
  );

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, "must not import its own entry point");
});

Deno.test("no-absolute-import rejects a file URL", () => {
  // "C:/..." needs no case of its own: Deno rejects it as an unknown scheme,
  // so it can never resolve in the first place.
  const source = `import { t } from "file:///C:/project/src/thing.ts";\n`;
  const found = lint("src/utils/mod.ts", source, "no-absolute-import");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, "is an absolute path");
});

Deno.test("a backtick specifier is read like a quoted one", () => {
  const source =
    "const m = await import(`#components`);\nexport const x = m;\n";
  const found = lint("src/utils/mod.ts", source, "enforce-layer-order");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, `must not import "#components"`);
});

Deno.test("a backtick specifier is rewritten as a quoted one", () => {
  const source = "const m = await import(`../utils/mod.ts`);\n";
  const found = lint("src/components/mod.ts", source, "no-parent-import");

  assertEquals(found.length, 1);
  assertEquals(
    applyFixes(source, found),
    `const m = await import("#utils");\n`,
  );
});

Deno.test("a substituted backtick specifier stays unreadable", () => {
  // Nothing can be concluded about it, so reporting would be a guess.
  const source = "const n = 'components';\n" +
    "const m = await import(`#${n}`);\nexport const x = m;\n";
  const found = lint("src/utils/mod.ts", source, "enforce-layer-order");

  assertEquals(found.length, 0);
});

Deno.test("every rule is exported and registered under the same name", () => {
  // The named exports are the composition API, so a rule must never be
  // registered in the default plugin without also being exported.
  const exported = Object.entries(rules).filter(([, value]) =>
    typeof (value as Deno.lint.Rule)?.create === "function"
  );
  const registered = Object.values(plugin.rules);

  assertEquals(exported.length, registered.length);
  for (const [, rule] of exported) {
    assertEquals(registered.includes(rule as Deno.lint.Rule), true);
  }
});
