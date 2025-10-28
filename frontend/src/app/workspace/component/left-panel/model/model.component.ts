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

import { Component, OnInit } from "@angular/core";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { BigObjectService, BigObjectStatus } from "../../../service/big-object/big-object.service";
import { JointUIService } from "../../../service/joint-ui/joint-ui.service";
import { WorkflowActionService } from "../../../service/workflow-graph/model/workflow-action.service";

interface OperatorStatus {
  operatorId: string;
  status: "producing" | "consuming";
}

interface ModelStats {
  inferenceSpeed: number;
  f1Score: string;
}

interface Column {
  name: string;
  type: string;
}

interface BigObjectCard {
  index: number;
  uri: string;
  operators: OperatorStatus[];
  timestamp: number;
  stats: ModelStats;
  inputColumns: Column[];
  featureColumns: Column[];
}

@UntilDestroy()
@Component({
  selector: "texera-model",
  templateUrl: "./model.component.html",
  styleUrls: ["./model.component.scss"],
})
export class ModelComponent implements OnInit {
  bigObjects: BigObjectCard[] = [];
  hoveredObjectUri: string | null = null;

  constructor(
    private bigObjectService: BigObjectService,
    private jointUIService: JointUIService,
    private workflowActionService: WorkflowActionService
  ) {}

  ngOnInit(): void {
    this.bigObjectService
      .getStatusUpdateStream()
      .pipe(untilDestroyed(this))
      .subscribe(statusMap => {
        // Group by URI
        const uriMap = new Map<string, OperatorStatus[]>();

        statusMap.forEach(status => {
          const uri = status.uri || "";
          if (!uriMap.has(uri)) {
            uriMap.set(uri, []);
          }
          uriMap.get(uri)!.push({
            operatorId: status.operatorId,
            status: status.status!,
          });
        });

        // Convert to array with indices and generate dummy stats
        this.bigObjects = Array.from(uriMap.entries()).map(([uri, operators], index) => ({
          index: index + 1,
          uri,
          operators,
          timestamp: Math.max(
            ...operators.map(op => {
              const status = statusMap.get(op.operatorId);
              return status ? status.timestamp : 0;
            })
          ),
          stats: this.generateDummyStats(),
          inputColumns: this.generateDummyColumns("input"),
          featureColumns: this.generateDummyColumns("feature"),
        }));
      });
  }

  onCardHover(object: BigObjectCard): void {
    this.hoveredObjectUri = object.uri;
    const paper = this.workflowActionService.getJointGraphWrapper().getMainJointPaper();
    if (paper) {
      // Show status on all operators involved with this object
      object.operators.forEach(op => {
        this.jointUIService.changeBigObjectStatus(paper, op.operatorId, op.status);
      });
    }
  }

  onCardLeave(object: BigObjectCard): void {
    this.hoveredObjectUri = null;
    const paper = this.workflowActionService.getJointGraphWrapper().getMainJointPaper();
    if (paper) {
      // Clear status from all operators
      object.operators.forEach(op => {
        this.jointUIService.changeBigObjectStatus(paper, op.operatorId, null);
      });
    }
  }

  private generateDummyStats(): ModelStats {
    // Generate random inference speed between 100 and 10000 tuples/second
    const inferenceSpeed = Math.floor(Math.random() * 9900) + 100;

    // Generate random F1 score between 0.75 and 0.99
    const f1Score = (Math.random() * 0.24 + 0.75).toFixed(3);

    return {
      inferenceSpeed,
      f1Score,
    };
  }

  private generateDummyColumns(prefix: string): Column[] {
    const types = ["Integer", "String", "Float", "Boolean", "Date"];
    const columnCount = Math.floor(Math.random() * 5) + 3; // 3-7 columns

    return Array.from({ length: columnCount }, (_, i) => ({
      name: `${prefix}_col_${i + 1}`,
      type: types[Math.floor(Math.random() * types.length)],
    }));
  }
}
