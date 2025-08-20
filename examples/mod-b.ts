// Bad example - with circular dependencies
import { greet } from "./mod-d.ts";

export function main() {
  console.log(greet("Test"));
}

if (import.meta.main) {
  main();
}
