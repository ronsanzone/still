import { defineConfig } from "oxlint";
import generic from "./tools/oxlint/anti-slop/index.ts";
import effect from "./tools/oxlint/anti-slop/effect/index.ts";

export default defineConfig({
  ignorePatterns: [".agents/**", "tools/**", "dist/**"],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    {
      name: "anti-slop-effect",
      specifier: "./tools/oxlint/anti-slop/effect/index.ts",
    },
  ],
  rules: {
    "oxc/no-accumulating-spread": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "error",
    ...Object.fromEntries(
      Object.keys(generic.rules).map((name) => [`anti-slop/${name}`, "error"]),
    ),
    ...Object.fromEntries(
      Object.keys(effect.rules).map((name) => [
        `anti-slop-effect/${name}`,
        "error",
      ]),
    ),
  },
});
