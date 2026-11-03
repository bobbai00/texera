import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "../../gen/openapi/3.1.0/Texera.Catalog.openapi.yaml",
  output: { path: "src/gen" },
  plugins: [
    "@hey-api/typescript",
    "@hey-api/sdk",
    { name: "@hey-api/client-fetch", runtimeConfigPath: "./src/client-config.ts" },
    "@tanstack/react-query",
    "zod",
  ],
});
