# Deno Circular Dependency Checker

A circular dependency detection tool for Deno projects

## Features

- 🔍 Detects circular dependencies in your Deno module graph
- 🚀 Fast analysis using `deno info` under the hood
- ⚡ Can be used in CI/CD pipelines and pre-commit hooks

## Usage

This tool is designed for terminal use.

```shell
deno run -A jsr:@cunarist/deno-circular-deps somefile.ts
```

The process exits with code 0 on success, and 1 on failure. This means you can easily use this in CI such as GitHub Actions.

## Output Example

✅ **No circular dependencies:**

```
📦 2 modules
📁 2 local modules
✅ No circular dependencies found
```

❌ **Circular dependencies found:**

```
📦 2 modules
📁 2 local modules
🚨 1 circular dependencies detected
■ C:/Users/username/Repositories/deno-circular-deps/examples/mod-b.ts ▶ C:/Users/username/Repositories/deno-circular-deps/examples/mod-d.ts ▶ C:/Users/username/Repositories/deno-circular-deps/examples/mod-b.ts
```

## How It Works

1. **Analysis**: Uses `deno info --json` to get the complete module dependency graph
2. **Detection**: Implements a depth-first search algorithm to detect cycles
3. **Reporting**: Provides clear, actionable feedback about circular dependencies
4. **Integration**: Exits with error code 1 if circular dependencies are found, making it perfect for CI/CD

## License

MIT
