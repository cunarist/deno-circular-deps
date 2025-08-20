interface Dependency {
  specifier: string;
  code?: {
    specifier: string;
  };
  type?: {
    specifier: string;
  };
}

interface Module {
  kind?: string;
  local?: string;
  specifier: string;
  dependencies?: Dependency[];
}

interface DenoInfoJson {
  modules: Module[];
}

function normalizePath(path: string): string {
  if (!path) {
    return path;
  }
  if (path.startsWith("file:///")) {
    path = path.replace("file:///", "");
  }
  return path.replace(/\\/g, "/");
}

function findCycles(info: DenoInfoJson): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  const moduleMap = new Map<string, Module>();
  for (const module of info.modules) {
    if (module.local) {
      const normalizedPath = normalizePath(module.local);
      moduleMap.set(normalizedPath, module);
      const normalizedSpecifier = normalizePath(module.specifier);
      moduleMap.set(normalizedSpecifier, module);
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
    if (module.local) {
      const normalizedPath = normalizePath(module.local);
      if (!visited.has(normalizedPath)) {
        dfs(module.specifier, [normalizedPath]);
      }
    }
  }

  return cycles;
}

async function main() {
  const [file] = Deno.args;
  if (!file) {
    console.error("Usage: deno run -A main.ts <entry_file>");
    Deno.exit(1);
  }
  const cmd = new Deno.Command("deno", {
    args: ["info", file, "--json"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    const err = new TextDecoder().decode(stderr);
    console.error(err);
    Deno.exit(1);
  }
  const json: DenoInfoJson = JSON.parse(new TextDecoder().decode(stdout));

  const localModulesCount = json.modules.filter((m) => m.local).length;
  console.log(`${json.modules.length} modules`);
  console.log(`${localModulesCount} local modules`);

  const cycles = findCycles(json);
  const cyclesCount = cycles.length;
  if (cyclesCount === 0) {
    console.log("No circular dependencies found.");
  } else {
    console.log(`${cyclesCount} circular dependencies detected:`);
    for (const cycle of cycles) {
      const dimmedCycle = cycle.map((c) => `\x1b[2m${c}\x1b[22m`);
      console.log("\u{25a0} " + dimmedCycle.join(" \u{25b6} "));
    }
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
