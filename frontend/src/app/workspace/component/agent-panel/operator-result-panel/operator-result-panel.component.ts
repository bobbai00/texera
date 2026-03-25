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

import { Component, Input } from "@angular/core";
import { OperatorResultSummary } from "../../../service/copilot/texera-copilot-manager.service";

@Component({
  selector: "texera-operator-result-panel",
  templateUrl: "operator-result-panel.component.html",
  styleUrls: ["operator-result-panel.component.scss"],
})
export class OperatorResultPanelComponent {
  @Input() operatorId: string = "";
  @Input() summary!: OperatorResultSummary;

  get stateColor(): string {
    switch (this.summary?.state) {
      case "Completed":
        return "#52c41a";
      case "Running":
        return "#fa8c16";
      case "Paused":
        return "#722ed1";
      default:
        return "#8c8c8c";
    }
  }

  get hasError(): boolean {
    return !!this.summary?.error;
  }

  get hasWarnings(): boolean {
    return !!this.summary?.warnings && this.summary.warnings.length > 0;
  }

  get outputShape(): string {
    if (this.summary?.outputColumns !== undefined) {
      return `${this.summary.outputTuples} rows x ${this.summary.outputColumns} cols`;
    }
    return `${this.summary?.outputTuples ?? 0} rows`;
  }

  get inputPortShapeLabels(): { portIndex: number; label: string }[] {
    if (!this.summary?.inputPortShapes) return [];
    return this.summary.inputPortShapes.map(s => ({
      portIndex: s.portIndex,
      label: `${s.rows} rows x ${s.columns} cols`,
    }));
  }

  get totalRowCount(): number | undefined {
    return this.summary?.totalRowCount;
  }
}
