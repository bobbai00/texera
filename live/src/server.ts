/**
 * The live service's one endpoint: a WebSocket at /live/sessions, under the prefix the gateway
 * routes here. Each
 * connection is handed to Hocuspocus, which speaks the Yjs sync and awareness protocols and
 * calls the rules in rooms.ts. The person's token travels in the protocol's first message, not
 * in a header, since a browser cannot set one on a WebSocket.
 */
import type { Hocuspocus } from "@hocuspocus/server";
import type { Member } from "./rooms.ts";

type Peer = ReturnType<Hocuspocus<Member>["handleConnection"]>;

export function serve(hocuspocus: Hocuspocus<Member>, port: number) {
  return Bun.serve<{ request: Request; peer?: Peer }>({
    port,
    fetch(request, server) {
      const { pathname } = new URL(request.url);
      if (pathname === "/live/health") return new Response("ok");
      if (pathname === "/live/sessions" && server.upgrade(request, { data: { request } })) return undefined;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        socket.data.peer = hocuspocus.handleConnection(socket, socket.data.request);
      },
      message(socket, message) {
        socket.data.peer?.handleMessage(
          typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message),
        );
      },
      close(socket, code, reason) {
        socket.data.peer?.handleClose({ code, reason } as CloseEvent);
      },
      pong(socket) {
        socket.data.peer?.touch();
      },
    },
  });
}
