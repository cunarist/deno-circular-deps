// Good example - no circular dependencies
import { hello } from "./mod-c.ts";

function main() {
  console.log(hello("World"));
}

if (import.meta.main) {
  main();
}
