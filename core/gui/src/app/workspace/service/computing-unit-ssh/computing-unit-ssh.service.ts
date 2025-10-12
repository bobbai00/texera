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
import { AuthService } from "../../../common/service/user/auth.service";
import { getWebsocketUrl } from "src/app/common/util/url";
import { GuiConfigService } from "../../../common/service/gui-config.service";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { AttachAddon } from "@xterm/addon-attach";

@Injectable({
  providedIn: "root",
})
export class ComputingUnitSshService {
  private static readonly SSH_WEBSOCKET_ENDPOINT = "wsapi/cu-ssh";

  private websocket?: WebSocket;
  private terminal?: Terminal;
  private fitAddon?: FitAddon;
  private attachAddon?: AttachAddon;
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
   * Open SSH connection to a computing unit using ttyd
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

    // Build WebSocket URL for ttyd
    // ttyd uses a simpler protocol - just raw WebSocket
    const websocketUrl =
      getWebsocketUrl(ComputingUnitSshService.SSH_WEBSOCKET_ENDPOINT, "") +
      "?uid=" +
      uid +
      "&cuid=" +
      cuid +
      (AuthService.getAccessToken() !== null
        ? "&access-token=" + AuthService.getAccessToken()
        : "");

    console.log("Connecting to ttyd WebSocket:", websocketUrl);

    try {
      // Create native WebSocket connection for ttyd
      this.websocket = new WebSocket(websocketUrl);

      // ttyd uses a binary protocol, so we need to use the AttachAddon
      this.attachAddon = new AttachAddon(this.websocket);
      this.terminal.loadAddon(this.attachAddon);

      // Handle WebSocket events
      this.websocket.onopen = () => {
        console.log("ttyd WebSocket connected");
        this.updateConnectionStatus(true);

        // Send initial terminal size to ttyd
        // ttyd expects: '1' (resize command) + JSON with cols and rows
        if (this.fitAddon) {
          const { cols, rows } = this.fitAddon.proposeDimensions() || { cols: 80, rows: 24 };
          const resizeMessage = JSON.stringify({ cols, rows });
          // ttyd protocol: '1' prefix for resize command
          this.websocket?.send('1' + resizeMessage);
        }
      };

      this.websocket.onerror = (error) => {
        console.error("ttyd WebSocket error:", error);
        this.errorSubject.next("Terminal connection error");
        this.updateConnectionStatus(false);
      };

      this.websocket.onclose = () => {
        console.log("ttyd WebSocket closed");
        this.updateConnectionStatus(false);

        // Clean up AttachAddon
        if (this.attachAddon) {
          this.attachAddon.dispose();
          this.attachAddon = undefined;
        }
      };

      // Handle terminal resize for ttyd
      this.terminal.onResize((size: { cols: number; rows: number }) => {
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
          // ttyd resize protocol
          const resizeMessage = JSON.stringify({ cols: size.cols, rows: size.rows });
          this.websocket.send('1' + resizeMessage);
        }
      });

    } catch (error) {
      console.error("Failed to connect to ttyd:", error);
      this.errorSubject.next("Failed to establish terminal connection");
      this.updateConnectionStatus(false);
    }
  }

  /**
   * Close SSH connection
   */
  public closeConnection(): void {
    // Clean up AttachAddon first
    if (this.attachAddon) {
      this.attachAddon.dispose();
      this.attachAddon = undefined;
    }

    // Close WebSocket
    if (this.websocket) {
      if (this.websocket.readyState === WebSocket.OPEN) {
        this.websocket.close();
      }
      this.websocket = undefined;
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
   * Send command to terminal (for programmatic input)
   */
  public sendCommand(command: string): void {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      // Send raw data to ttyd
      this.websocket.send(command);
    }
  }

  /**
   * Resize terminal
   */
  public resizeTerminal(cols: number, rows: number): void {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      // ttyd resize protocol: '1' + JSON
      const resizeMessage = JSON.stringify({ cols, rows });
      this.websocket.send('1' + resizeMessage);
    }
  }
}
