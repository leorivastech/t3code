import { serveModEngine } from "./stdio.ts";

serveModEngine(
  process.stdin,
  (line) => process.stdout.write(line),
  () => process.exit(0),
);
