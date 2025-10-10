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

import { Injectable } from "@angular/core";
import { BehaviorSubject, Observable, Subject, Subscription } from "rxjs";
import { webSocket, WebSocketSubject } from "rxjs/webSocket";
import { AuthService } from "../../../common/service/user/auth.service";
import { getWebsocketUrl } from "src/app/common/util/url";
import { GuiConfigService } from "../../../common/service/gui-config.service";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { AttachAddon } from "@xterm/addon-attach";

interface SSHMessage {
  type: "data" | "resize" | "error" | "connected" | "disconnected";
  data?: string;
  cols?: number;
  rows?: number;
  error?: string;
}

@Injectable({
  providedIn: "root",
})
export class ComputingUnitSshService {
  private static readonly SSH_WEBSOCKET_ENDPOINT = "wsapi/cu-ssh";

  private websocket?: WebSocketSubject<SSHMessage>;
  private terminal?: Terminal;
  private fitAddon?: FitAddon;
  private attachAddon?: AttachAddon;
  private wsSubscription?: Subscription;
  private readonly connectionStatusSubject = new BehaviorSubject<boolean>(false);
  private readonly errorSubject = new Subject<string>();

  constructor(private config: GuiConfigService) {}

  /**
   * Get connection status stream
   */
  public getConnectionStatusStream(): Observable<boolean> {
    return this.connectionStatusSubject.asObservable();
  }

  /**
   * Get error stream
   */
  public getErrorStream(): Observable<string> {
    return this.errorSubject.asObservable();
  }

  /**
   * Check if connected
   */
  public get isConnected(): boolean {
    return this.connectionStatusSubject.value;
  }

  /**
   * Open SSH connection to a computing unit
   */
  public openSSHConnection(
    terminal: Terminal,
    fitAddon: FitAddon,
    uid: number,
    cuid: number
  ): void {
    this.closeConnection();

    this.terminal = terminal;
    this.fitAddon = fitAddon;

    // Build WebSocket URL with parameters
    const websocketUrl =
      getWebsocketUrl(ComputingUnitSshService.SSH_WEBSOCKET_ENDPOINT, "") +
      "?uid=" +
      uid +
      "&cuid=" +
      cuid +
      (AuthService.getAccessToken() !== null
        ? "&access-token=" + AuthService.getAccessToken()
        : "");

    console.log("SSH WebSocket URL:", websocketUrl);

    // Create WebSocket connection
    this.websocket = webSocket<SSHMessage>({
      url: websocketUrl,
      deserializer: msg => JSON.parse(msg.data),
      serializer: msg => JSON.stringify(msg),
    });

    // Subscribe to WebSocket messages
    this.wsSubscription = this.websocket.subscribe({
      next: (message: SSHMessage) => {
        this.handleSSHMessage(message);
      },
      error: (error: any) => {
        console.error("SSH WebSocket error:", error);
        this.errorSubject.next("SSH connection error: " + error.message);
        this.updateConnectionStatus(false);
      },
      complete: () => {
        console.log("SSH WebSocket connection closed");
        this.updateConnectionStatus(false);
      },
    });

    // Handle terminal input
    this.terminal.onData((data: string) => {
      if (this.websocket && this.isConnected) {
        this.websocket.next({
          type: "data",
          data: data,
        });
      }
    });

    // Handle terminal resize
    this.terminal.onResize((size: { cols: number; rows: number }) => {
      if (this.websocket && this.isConnected) {
        this.websocket.next({
          type: "resize",
          cols: size.cols,
          rows: size.rows,
        });
      }
    });

    // Send initial terminal size
    if (this.fitAddon) {
      const { cols, rows } = this.fitAddon.proposeDimensions() || { cols: 80, rows: 24 };
      setTimeout(() => {
        if (this.websocket) {
          this.websocket.next({
            type: "resize",
            cols: cols,
            rows: rows,
          });
        }
      }, 100);
    }
  }

  /**
   * Handle incoming SSH messages
   */
  private handleSSHMessage(message: SSHMessage): void {
    switch (message.type) {
      case "data":
        if (this.terminal && message.data) {
          this.terminal.write(message.data);
        }
        break;

      case "connected":
        console.log("SSH connection established");
        this.updateConnectionStatus(true);
        if (this.terminal) {
          this.terminal.writeln("\r\n*** SSH Connection Established ***\r\n");
        }
        break;

      case "disconnected":
        console.log("SSH connection closed");
        this.updateConnectionStatus(false);
        if (this.terminal) {
          this.terminal.writeln("\r\n*** SSH Connection Closed ***\r\n");
        }
        break;

      case "error":
        console.error("SSH error:", message.error);
        this.errorSubject.next(message.error || "Unknown SSH error");
        if (this.terminal && message.error) {
          this.terminal.writeln(`\r\n*** Error: ${message.error} ***\r\n`);
        }
        break;

      default:
        console.warn("Unknown SSH message type:", message);
    }
  }

  /**
   * Close SSH connection
   */
  public closeConnection(): void {
    if (this.wsSubscription) {
      this.wsSubscription.unsubscribe();
      this.wsSubscription = undefined;
    }

    if (this.websocket) {
      this.websocket.complete();
      this.websocket = undefined;
    }

    if (this.attachAddon) {
      this.attachAddon.dispose();
      this.attachAddon = undefined;
    }

    this.terminal = undefined;
    this.fitAddon = undefined;
    this.updateConnectionStatus(false);
  }

  /**
   * Update connection status
   */
  private updateConnectionStatus(connected: boolean): void {
    if (this.isConnected !== connected) {
      this.connectionStatusSubject.next(connected);
    }
  }

  /**
   * Send command to SSH session
   */
  public sendCommand(command: string): void {
    if (this.websocket && this.isConnected) {
      this.websocket.next({
        type: "data",
        data: command,
      });
    }
  }

  /**
   * Resize terminal
   */
  public resizeTerminal(cols: number, rows: number): void {
    if (this.websocket && this.isConnected) {
      this.websocket.next({
        type: "resize",
        cols: cols,
        rows: rows,
      });
    }
  }
}
