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

import { Component, Input, Output, EventEmitter } from "@angular/core";
import { ReActStep } from "../../../service/copilot/copilot-types";

/**
 * Reusable modal component for displaying ReActStep details.
 * Shows step identification, token usage, and tool calls.
 */
@Component({
  selector: "texera-react-step-detail-modal",
  templateUrl: "./react-step-detail-modal.component.html",
  styleUrls: ["./react-step-detail-modal.component.scss"],
})
export class ReActStepDetailModalComponent {
  @Input() visible: boolean = false;
  @Input() step: ReActStep | null = null;
  @Input() agentId: string | null = null;
  @Output() visibleChange = new EventEmitter<boolean>();

  public closeModal(): void {
    this.visible = false;
    this.visibleChange.emit(false);
  }

  public formatJson(data: any): string {
    return JSON.stringify(data, null, 2);
  }

  public getToolResult(step: ReActStep, toolCallIndex: number): any {
    if (!step.toolResults || toolCallIndex >= step.toolResults.length) {
      return null;
    }
    const toolResult = step.toolResults[toolCallIndex];
    return toolResult.output || toolResult.result || toolResult;
  }

  public getToolOperatorAccess(
    step: ReActStep,
    toolCallIndex: number
  ): { viewedOperatorIds: string[]; addedOperatorIds: string[]; modifiedOperatorIds: string[] } | null {
    if (!step.operatorAccess) {
      return null;
    }
    return step.operatorAccess.get(toolCallIndex) || null;
  }

  public hasOperatorAccess(step: ReActStep): boolean {
    return !!step.operatorAccess && step.operatorAccess.size > 0;
  }
}
