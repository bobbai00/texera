import { defineConfig } from "@hey-api/openapi-ts";

// The contract, minus the one route that streams: `GET /resources/{rid}/events` sends
// server-sent events, which the query plugin cannot type (its options read `.data` from a
// stream). That route's client is written by hand in packages/kinds/src/watch.ts against the
// same document; everything else is generated.
const STREAMS = ["/catalog/v1/resources/{rid}/events"];
const spec = Bun.YAML.parse(await Bun.file(new URL("../../gen/openapi/3.1.0/Texera.Catalog.openapi.yaml", import.meta.url)).text()) as { paths: Record<string, unknown> };
for (const path of STREAMS) delete spec.paths[path];

export default defineConfig({
  input: spec,
  output: { path: "src/gen" },
  plugins: [
    "@hey-api/typescript",
    "@hey-api/sdk",
    { name: "@hey-api/client-fetch", runtimeConfigPath: "./src/client-config.ts" },
    "@tanstack/react-query",
    "zod",
  ],
});
