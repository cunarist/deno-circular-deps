/**
 * A CLI that finds circular dependencies in a Deno module graph.
 *
 * It builds the module graph for the entry points you pass and runs three
 * checks. It walks the graph depth first and prints every cycle it finds as a
 * path, rejects `#` aliases that share a target, then compares the aliases
 * declared in `deno.json` against the specifiers the graph actually imports
 * and prints the ones nothing reaches. Only local modules are traversed, so
 * remote and JSR dependencies are ignored.
 *
 * Pass every root the project has. An alias imported only by files outside the
 * graph is reported as unused, so leaving the tests out produces noise.
 *
 * The process exits with code 0 when both checks pass and 1 when either does
 * not, which makes it usable directly in CI or a pre-commit hook.
 *
 * @module
 */

import { Workspace } from "@deno/loader";

import { findImportsConfig } from "./imports.ts";
import {
  normalizePath,
  resolveFrom,
  toFileUrl,
  toRelativePath,
} from "./paths.ts";

/** One import in a module, as {@linkcode Workspace} reports it. */
interface Dependency {
  /** The specifier exactly as written in source, such as `#utils`. */
  specifier: string;
  /** Where the specifier resolved to, absent when resolution failed. */
  code?: {
    specifier: string;
  };
  /** Where an `@deno-types` or `@ts-types` annotation resolved to. */
  type?: {
    specifier: string;
  };
}

/** One node of the module graph. */
interface Module {
  kind?: string;
  specifier: string;
  dependencies?: Dependency[];
}

/** The subset of the loader's graph these checks read. */
interface ModuleGraph {
  modules: Module[];
}

/** Whether a module specifier points at a file on disk. */
function isLocal(specifier: string): boolean {
  return specifier.startsWith("file:");
}

/**
 * The main function that finds circular dependencies
 * in the given module graph.
 */
function findCycles(info: ModuleGraph): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  const moduleMap = new Map<string, Module>();
  for (const module of info.modules) {
    if (isLocal(module.specifier)) {
      moduleMap.set(normalizePath(module.specifier), module);
    }
  }

  function dfs(moduleSpecifier: string, path: string[]): void {
    const normalizedSpecifier = normalizePath(moduleSpecifier);

    if (recursionStack.has(normalizedSpecifier)) {
      const cycleStart = path.indexOf(normalizedSpecifier);
      if (cycleStart !== -1) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }

    if (visited.has(normalizedSpecifier)) {
      return;
    }

    visited.add(normalizedSpecifier);
    recursionStack.add(normalizedSpecifier);

    const module = moduleMap.get(normalizedSpecifier);
    if (module?.dependencies) {
      for (const dep of module.dependencies) {
        const targets: string[] = [];

        if (dep.code?.specifier) {
          targets.push(dep.code.specifier);
        }
        if (dep.type?.specifier) {
          targets.push(dep.type.specifier);
        }

        for (const target of targets) {
          const normalizedTarget = normalizePath(target);
          if (moduleMap.has(normalizedTarget)) {
            dfs(target, [...path, normalizedTarget]);
          }
        }
      }
    }

    recursionStack.delete(normalizedSpecifier);
  }

  for (const module of info.modules) {
    if (isLocal(module.specifier)) {
      const normalizedPath = normalizePath(module.specifier);
      if (!visited.has(normalizedPath)) {
        dfs(module.specifier, [normalizedPath]);
      }
    }
  }

  return cycles;
}

/**
 * Builds one graph covering every entry point.
 *
 * `@deno/loader` is Deno's own resolver compiled to Wasm, so the graph comes
 * from the same code `deno info` runs without spawning it as a subprocess.
 * That means no dependency on a `deno` binary being on `PATH`, and one graph
 * build for all entry points instead of one process each.
 *
 * The graph API is marked unstable, so its shape may change between patch
 * releases of the loader. The version range here is pinned tightly for that
 * reason.
 */
async function readGraph(files: string[]): Promise<ModuleGraph> {
  // Config discovery walks up from the working directory, matching what
  // `deno info` does when run in a project.
  using workspace = new Workspace();
  using loader = await workspace.createLoader();
  const diagnostics = await loader.addEntrypoints(
    files.map((file) =>
      toFileUrl(resolveFrom(normalizePath(Deno.cwd()), file))
    ),
  );
  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) {
      console.error(diagnostic.message);
    }
    Deno.exit(1);
  }
  return loader.getGraphUnstable() as ModuleGraph;
}

/**
 * Collects every `#` specifier as it was written in source. The graph
 * reports the raw text alongside the resolved path, so an alias can be
 * matched against the `imports` map without re-parsing any file.
 */
function usedAliases(info: ModuleGraph): Set<string> {
  const used = new Set<string>();
  for (const module of info.modules) {
    for (const dependency of module.dependencies ?? []) {
      if (dependency.specifier.startsWith("#")) {
        used.add(dependency.specifier);
      }
    }
  }
  return used;
}

/**
 * Reports `#` entries that no module in the graph imports. An exact entry
 * counts as used only when written exactly, while a trailing-slash entry
 * counts as used by any specifier that begins with it.
 */
function findUnusedAliases(fromFile: string, used: Set<string>): string[] {
  const config = findImportsConfig(fromFile);
  if (config === null) {
    return [];
  }

  const unused: string[] = [];
  for (const entry of config.entries) {
    if (!used.has(entry.specifier)) {
      unused.push(entry.specifier);
    }
  }
  for (const prefix of config.prefixes) {
    const reached = [...used].some((specifier) =>
      specifier.startsWith(prefix.specifier)
    );
    if (!reached) {
      unused.push(prefix.specifier);
    }
  }
  return unused;
}

interface DuplicateAliasTarget {
  /** Target path relative to the config directory. */
  target: string;
  /** Alias specifiers that all point at the target. */
  specifiers: string[];
}

/**
 * Groups exact and trailing-slash `#` aliases that resolve to the same target.
 * The two kinds cannot collide because prefix targets end in a slash.
 */
function findDuplicateAliasTargets(
  fromFile: string,
): DuplicateAliasTarget[] {
  const config = findImportsConfig(fromFile);
  if (config === null) {
    return [];
  }

  const byTarget = new Map<string, string[]>();
  for (const entry of config.entries) {
    const specifiers = byTarget.get(entry.target) ?? [];
    specifiers.push(entry.specifier);
    byTarget.set(entry.target, specifiers);
  }
  for (const prefix of config.prefixes) {
    const specifiers = byTarget.get(prefix.target) ?? [];
    specifiers.push(prefix.specifier);
    byTarget.set(prefix.target, specifiers);
  }

  const duplicates: DuplicateAliasTarget[] = [];
  for (const [target, specifiers] of byTarget) {
    if (specifiers.length < 2) {
      continue;
    }
    duplicates.push({
      target: toRelativePath(target, config.configDir),
      specifiers,
    });
  }
  return duplicates;
}

async function main() {
  const files = Deno.args;
  if (files.length === 0) {
    console.error("Error: Pass at least one entry point");
    Deno.exit(1);
  }
  for (const file of files) {
    try {
      await Deno.stat(file);
    } catch {
      console.error(
        `Error: File '${file}' does not exist or is not accessible`,
      );
      Deno.exit(1);
    }
  }

  // Every entry point contributes to one graph, so a module reachable from
  // the tests but not from the app still counts as reached.
  const json = await readGraph(files);

  const localModulesCount = json.modules.filter((m) => isLocal(m.specifier))
    .length;
  console.log(`\u{1f4e6} ${json.modules.length} modules`);
  console.log(`\u{1f4c1} ${localModulesCount} local modules`);

  let failed = false;

  const cycles = findCycles(json);
  if (cycles.length === 0) {
    console.log("\u{2705} No circular dependencies found");
  } else {
    const currentDir = normalizePath(Deno.cwd());
    console.log(`\u{1f6a8} ${cycles.length} circular dependencies detected`);
    for (const cycle of cycles) {
      const relativeCycle = cycle.map((c) => toRelativePath(c, currentDir));
      const dimmedCycle = relativeCycle.map((c) => `\x1b[2m${c}\x1b[22m`);
      console.log("\u{25a0} " + dimmedCycle.join(" \u{25b6} "));
    }
    failed = true;
  }

  // The config is found by walking up from a file, so the entry point has to
  // be absolute. A bare "src/mod.ts" would walk up from "src" and stop.
  const entryPath = resolveFrom(normalizePath(Deno.cwd()), files[0]);

  const duplicateTargets = findDuplicateAliasTargets(entryPath);
  if (duplicateTargets.length === 0) {
    console.log('\u{2705} Every "#" internal import alias has a unique target');
  } else {
    const plural = duplicateTargets.length === 1 ? "target" : "targets";
    console.log(
      `\u{1f6a8} ${duplicateTargets.length} duplicate "#" internal import alias ${plural} in deno.json`,
    );
    for (const duplicate of duplicateTargets) {
      console.log(
        `\u{25a0} ${
          duplicate.specifiers.join(", ")
        } \u{25b6} \x1b[2m${duplicate.target}\x1b[22m`,
      );
    }
    failed = true;
  }

  const unused = findUnusedAliases(entryPath, usedAliases(json));
  if (unused.length === 0) {
    console.log('\u{2705} Every "#" internal import alias is used');
  } else {
    const plural = unused.length === 1 ? "alias" : "aliases";
    console.log(
      `\u{1f6a8} ${unused.length} unused "#" internal import ${plural} in deno.json`,
    );
    for (const specifier of unused) {
      console.log(`\u{25a0} \x1b[2m${specifier}\x1b[22m`);
    }
    failed = true;
  }

  if (failed) {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
