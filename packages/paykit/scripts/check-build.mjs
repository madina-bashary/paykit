/**
 * Guards the two things about this build that are easy to break and silent
 * when broken.
 *
 * 1. `"use client"` must survive into the client bundle. tsup strips module
 *    directives, so it is re-added by a banner — and a banner is exactly the
 *    kind of thing a config change drops without anyone noticing until an App
 *    Router user files the issue.
 * 2. The server entry must stay server-only: no `"use client"`, and the
 *    `server-only` import intact.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const failures = [];

const read = (file) => {
  try {
    return readFileSync(join(dist, file), "utf8");
  } catch {
    failures.push(`${file} was not built`);
    return null;
  }
};

for (const file of ["index.js", "index.mjs"]) {
  const source = read(file);
  if (source === null) continue;
  const firstLine = source.split("\n", 1)[0].trim();
  if (!/^["']use client["'];?$/.test(firstLine)) {
    failures.push(`${file} must start with "use client" (got: ${firstLine.slice(0, 40)})`);
  }
}

for (const file of ["next/server.js", "next/server.mjs"]) {
  const source = read(file);
  if (source === null) continue;
  if (source.includes('"use client"') || source.includes("'use client'")) {
    failures.push(`${file} must not be marked "use client" — it holds secret keys`);
  }
  if (!source.includes("server-only")) {
    failures.push(`${file} lost its server-only import, the build-time tripwire`);
  }
}

for (const file of ["index.d.ts", "next/server.d.ts"]) {
  if (read(file) === null) continue;
}

if (failures.length > 0) {
  console.error("Build check failed:");
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('Build check passed: "use client" present, server entry clean.');
