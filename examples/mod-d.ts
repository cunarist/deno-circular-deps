// Creates circular dependency with mod-b
import { main as runMain } from "./mod-b.ts";

export function greet(name: string): string {
  // This creates a circular dependency
  if (name === "circular") {
    runMain();
  }
  return `Greetings ${name}!`;
}
