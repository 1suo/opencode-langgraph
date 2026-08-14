import fs from "node:fs";
import path from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solid from "babel-preset-solid";

const sourceFile = path.resolve("src/opencode/tui.tsx");
const outputFile = path.resolve("dist/src/opencode/tui.js");
const source = fs.readFileSync(sourceFile, "utf8");
const result = await transformAsync(source, {
  filename: sourceFile,
  configFile: false,
  babelrc: false,
  sourceMaps: true,
  sourceFileName: path.relative(path.dirname(outputFile), sourceFile),
  presets: [[solid, { moduleName: "@opentui/solid", generate: "universal" }], typescript],
});

if (!result?.code || result.code.includes("_jsx(") || !result.code.includes("createComponent")) {
  throw new Error("The OpenCode TUI was not compiled with the Solid transform");
}

fs.writeFileSync(outputFile, `${result.code}\n//# sourceMappingURL=tui.js.map\n`);
fs.writeFileSync(`${outputFile}.map`, JSON.stringify(result.map));
