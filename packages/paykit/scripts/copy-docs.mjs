// The README and LICENSE live at the repo root so there is one copy to edit.
// npm needs them inside the package tarball, so pull them in at pack time.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkg, "..", "..");

for (const file of ["README.md", "LICENSE"]) {
  copyFileSync(join(root, file), join(pkg, file));
  console.log(`copied ${file}`);
}
