/** Starts the live service: the sessions in which people are on a resource together. */
import { Hocuspocus } from "@hocuspocus/server";
import { createServiceTokenSource } from "@texera/service-auth";
import { httpCatalog } from "./catalog.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { type Member, rooms } from "./rooms.ts";
import { serve } from "./server.ts";

const config = loadConfig();
const log = createLogger();
const tokens = createServiceTokenSource({
  tokenUrl: config.tokenUrl,
  clientId: config.serviceClientId,
  clientSecret: config.serviceClientSecret,
});
const rules = rooms({ catalog: httpCatalog({ baseUrl: config.catalogUrl, tokens }), log });
const hocuspocus = new Hocuspocus<Member>({
  extensions: [rules],
  debounce: config.saveAfter,
  maxDebounce: config.saveWithin,
  quiet: true,
});
const server = serve(hocuspocus, config.port);
setInterval(() => {
  void rules.recheck(hocuspocus);
  void rules.retry(hocuspocus);
}, config.recheckEvery);
log.info("listening", { port: server.port, catalog: config.catalogUrl });
