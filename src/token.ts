#!/usr/bin/env bun
import { readFreshGrokApiKey } from "./oauth.ts";

try {
  process.stdout.write(`${readFreshGrokApiKey()}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
