/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Help with code while it is written: what a name is, what fits where the cursor is, and what is wrong. It is
// asked of a language server, over the Language Server Protocol. For Python that is the Pyright language service
// the Angular app uses too (pyright-language-service/); the client is CodeMirror's own, on one socket for all the
// code a person opens. Where no language server answers, code is written without the help.

import { languageServerExtensions, LSPClient, type Transport } from "@codemirror/lsp-client";
import type { Extension } from "@codemirror/state";
import { useEffect, useState } from "react";
import type { CodeLanguage } from "@/lib/workflow/code";

/** Where a language's server is reached on the app's own host, and how it names the language and its files. */
const servers: Partial<Record<CodeLanguage, { path: string; fileExtension: string }>> = {
  python: { path: "/python-language-server", fileExtension: "py" },
};

/** The client of each language's server, connected once for the whole app. Undefined when no server answers. */
const clients = new Map<CodeLanguage, Promise<LSPClient | undefined>>();

function clientOf(language: CodeLanguage): Promise<LSPClient | undefined> {
  const server = servers[language];
  if (!server) return Promise.resolve(undefined);
  let client = clients.get(language);
  if (!client) {
    client = connect(server.path, () => clients.delete(language));
    clients.set(language, client);
  }
  return client;
}

/** Connects to a language server. `onClose` is called when the connection ends, so that the next editor tries anew. */
function connect(path: string, onClose: () => void): Promise<LSPClient | undefined> {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new Promise(resolve => {
    const socket = new WebSocket(url);
    const handlers = new Set<(message: string) => void>();
    // The protocol's messages are JSON, one in each frame of the socket.
    const transport: Transport = {
      send: message => socket.send(message),
      subscribe: handler => handlers.add(handler),
      unsubscribe: handler => handlers.delete(handler),
    };
    const client = new LSPClient({
      extensions: languageServerExtensions(),
      // What the server writes into its own log stays out of the browser's console.
      notificationHandlers: { "window/logMessage": () => true },
    });
    socket.addEventListener("message", ({ data }) => {
      for (const handler of handlers) handler(data as string);
    });
    socket.addEventListener("open", () => resolve(client.connect(transport)));
    socket.addEventListener("close", () => {
      client.disconnect();
      onClose();
      // A socket that closes before it opened is a server that is not there.
      resolve(undefined);
    });
  });
}

/**
 * What the code editor needs to ask a language server about one piece of code, named so that the server can
 * tell it from the others. Undefined until a server answers, and for a language that has none.
 */
export function useLanguageHelp(language: CodeLanguage, name: string): Extension | undefined {
  const [help, setHelp] = useState<Extension>();
  useEffect(() => {
    let wanted = true;
    void clientOf(language).then(client => {
      if (wanted && client) setHelp(client.plugin(`file:///${name}.${servers[language]!.fileExtension}`, language));
    });
    return () => {
      wanted = false;
    };
  }, [language, name]);
  return help;
}
