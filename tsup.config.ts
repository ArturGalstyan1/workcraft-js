import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    resolve: true,
  },
  treeshake: false, // This might help preserve all exports
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: "dist",
});
