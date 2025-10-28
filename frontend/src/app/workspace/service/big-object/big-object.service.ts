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
import { WorkflowWebsocketService } from "../workflow-websocket/workflow-websocket.service";
import { BigObjectEvent, BigObjectUpdateEvent } from "../../types/workflow-websocket.interface";
import { Observable, Subject } from "rxjs";
import { ExecutionState } from "../../types/execute-workflow.interface";

export interface BigObjectStatus {
  operatorId: string;
  status: "uploading" | "retrieving" | null;
  timestamp: number;
  uri?: string;
}

@Injectable({
  providedIn: "root",
})
export class BigObjectService {
  private operatorStatuses: Map<string, BigObjectStatus> = new Map();
  private statusUpdateStream = new Subject<Map<string, BigObjectStatus>>();

  constructor(private workflowWebsocketService: WorkflowWebsocketService) {
    this.registerBigObjectUpdateEventHandler();
    this.registerAutoClearStatuses();
  }

  private registerBigObjectUpdateEventHandler() {
    this.workflowWebsocketService
      .subscribeToEvent("BigObjectUpdateEvent")
      .subscribe((event: BigObjectUpdateEvent) => {
        event.events.forEach((bigObjectEvent: BigObjectEvent) => {
          // Debug: log the actual eventType value
          console.log("BigObjectEvent received:", bigObjectEvent);

          // Handle both string and potential enum number formats
          const isCreate =
            bigObjectEvent.eventType === "CREATE" ||
            bigObjectEvent.eventType === 0 ||
            (bigObjectEvent.eventType as any) === "CREATE";

          const status: BigObjectStatus = {
            operatorId: bigObjectEvent.operatorId,
            status: isCreate ? "uploading" : "retrieving",
            timestamp: bigObjectEvent.timestamp.seconds * 1000 + bigObjectEvent.timestamp.nanos / 1000000,
            uri: bigObjectEvent.uri,
          };

          this.operatorStatuses.set(bigObjectEvent.operatorId, status);
        });

        this.statusUpdateStream.next(new Map(this.operatorStatuses));
      });
  }

  private registerAutoClearStatuses() {
    this.workflowWebsocketService.subscribeToEvent("WorkflowStateEvent").subscribe(event => {
      if (event.state === ExecutionState.Initializing) {
        this.operatorStatuses.clear();
        this.statusUpdateStream.next(new Map(this.operatorStatuses));
      }
    });
  }

  public getOperatorStatus(operatorId: string): BigObjectStatus | undefined {
    return this.operatorStatuses.get(operatorId);
  }

  public hasStatus(operatorId: string): boolean {
    return this.operatorStatuses.has(operatorId);
  }

  public getStatusUpdateStream(): Observable<Map<string, BigObjectStatus>> {
    return this.statusUpdateStream.asObservable();
  }

  public clearOperatorStatus(operatorId: string): void {
    this.operatorStatuses.delete(operatorId);
    this.statusUpdateStream.next(new Map(this.operatorStatuses));
  }

  public getAllStatuses(): Map<string, BigObjectStatus> {
    return new Map(this.operatorStatuses);
  }
}
