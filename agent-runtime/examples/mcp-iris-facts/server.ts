/**
 * A small third-party MCP server for the dev stack: facts about iris species and a length
 * converter, over Streamable HTTP at http://localhost:23010/mcp. It stands in for any external
 * MCP server a lab registers in the catalog and binds to an agent template.
 *
 *   bun agent-runtime/examples/mcp-iris-facts/server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const FACTS: Record<string, { commonName: string; nativeRange: string; flower: string }> = {
  setosa: { commonName: "bristle-pointed iris", nativeRange: "Alaska, northern Canada and northeast Asia", flower: "violet to purple, with short petals" },
  versicolor: { commonName: "harlequin blueflag", nativeRange: "eastern North America", flower: "blue-violet with yellow and white veins" },
  virginica: { commonName: "Virginia iris", nativeRange: "the eastern United States, along wetlands", flower: "lavender to violet, the largest of the three" },
};

const TO_CM: Record<string, number> = { mm: 0.1, cm: 1, m: 100, in: 2.54, inch: 2.54, inches: 2.54 };

function server(): McpServer {
  const s = new McpServer({ name: "iris-facts", version: "1.0.0" });
  s.registerTool(
    "species_facts",
    {
      description: "Facts about an iris species: common name, native range and flower appearance. Accepts names like setosa or Iris-setosa.",
      inputSchema: { species: z.string() },
    },
    async ({ species }) => {
      const key = species.toLowerCase().replace(/^iris[-_ ]?/, "");
      const fact = FACTS[key];
      const text = fact ? JSON.stringify({ species: key, ...fact }) : `unknown species ${species}; known: ${Object.keys(FACTS).join(", ")}`;
      return { content: [{ type: "text", text }], isError: !fact };
    },
  );
  s.registerTool(
    "convert_length",
    {
      description: "Convert a length between mm, cm, m and inches.",
      inputSchema: { value: z.number(), from: z.string(), to: z.string() },
    },
    async ({ value, from, to }) => {
      const f = TO_CM[from.toLowerCase()];
      const t = TO_CM[to.toLowerCase()];
      if (!f || !t) return { content: [{ type: "text", text: `unsupported unit; use one of ${Object.keys(TO_CM).join(", ")}` }], isError: true };
      const result = (value * f) / t;
      return { content: [{ type: "text", text: JSON.stringify({ value, from, to, result: Math.round(result * 10000) / 10000 }) }] };
    },
  );
  return s;
}

const port = Number(process.env.PORT ?? 23010);
Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
    // Stateless: a fresh server and transport per request.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server().connect(transport);
    return transport.handleRequest(req);
  },
});
console.log(`iris-facts MCP server on http://localhost:${port}/mcp`);
