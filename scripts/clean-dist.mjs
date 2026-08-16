import fs from "node:fs";
import path from "node:path";

const dist = path.resolve("dist");
if (path.basename(dist) !== "dist" || path.dirname(dist) === path.parse(dist).root) throw new Error(`Refusing to clean unsafe build path: ${dist}`);
fs.rmSync(dist, { recursive: true, force: true });
