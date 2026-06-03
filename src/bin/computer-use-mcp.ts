#!/usr/bin/env node
import { runComputerUseMcpServer } from "../index.js";

runComputerUseMcpServer().catch((error) => {
  console.error(
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exit(1);
});
