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
  tupleCount: number;
}

interface Column {
  name: string;
  type: string;
}

interface BigObjectCard {
  index: number;
  name: string;
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
    // Initialize with hardcoded demo data
    this.initializeHardcodedModels();

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

        // If we have real data, use it. Otherwise keep the hardcoded data
        if (uriMap.size > 0) {
          // Convert to array with indices and generate dummy stats
          this.bigObjects = Array.from(uriMap.entries()).map(([uri, operators], index) => {
            // Check if this model contains the specific operator ID
            const hasSpecificOperator = operators.some(
              op => op.operatorId === "PythonUDFV2-operator-facb5950-eebd-444d-b883-298bf1460d95"
            );

            return {
              index: index + 1,
              name: hasSpecificOperator ? "Model 1" : "Model 2",
              uri,
              operators,
              timestamp: Math.max(
                ...operators.map(op => {
                  const status = statusMap.get(op.operatorId);
                  return status ? status.timestamp : 0;
                })
              ),
              stats: this.generateHardcodedStats(hasSpecificOperator),
              inputColumns: this.getHardcodedInputColumns(),
              featureColumns: this.getHardcodedFeatureColumns(),
            };
          });
        }
      });
  }

  private initializeHardcodedModels(): void {
    // Create hardcoded demo models for testing
    this.bigObjects = [
      {
        index: 1,
        name: "Model 1",
        uri: "s3://models/fraud-detector-v1",
        operators: [
          {
            operatorId: "PythonUDFV2-operator-facb5950-eebd-444d-b883-298bf1460d95",
            status: "producing" as const,
          },
          {
            operatorId: "PythonUDFV2-operator-8a0d0e7b-5f3a-49bb-b3ac-e61ef9c9ea9f",
            status: "consuming" as const,
          },
        ],
        timestamp: Date.now(),
        stats: this.generateHardcodedStats(true),
        inputColumns: this.getHardcodedInputColumns(),
        featureColumns: this.getHardcodedFeatureColumns(),
      },
      {
        index: 2,
        name: "Model 2",
        uri: "s3://models/fraud-detector-v2",
        operators: [
          {
            operatorId: "PythonUDFV2-operator-8525a233-339f-430a-8166-373c38b75ac8",
            status: "producing" as const,
          },
          {
            operatorId: "PythonUDFV2-operator-3b7c9d2a-1234-5678-9abc-def012345678",
            status: "consuming" as const,
          },
        ],
        timestamp: Date.now(),
        stats: this.generateHardcodedStats(false),
        inputColumns: this.getHardcodedInputColumns(),
        featureColumns: this.getHardcodedFeatureColumns(),
      },
    ];
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

  private generateHardcodedStats(isModel1: boolean): ModelStats {
    // Hardcoded F1 scores based on model type
    const f1Score = isModel1 ? "0.032" : "0.685";

    // Generate tuple count: 3333 + random variance (-200 to +200)
    const tupleCountVariance = Math.floor(Math.random() * 401) - 200; // -200 to 200
    const tupleCount = 3333 + tupleCountVariance;

    // Generate inference speed: 3333 + random variance (-50 to +50)
    const speedVariance = Math.floor(Math.random() * 101) - 50; // -50 to 50
    const inferenceSpeed = 3333 + speedVariance;

    return {
      inferenceSpeed,
      f1Score,
      tupleCount,
    };
  }

  private getHardcodedInputColumns(): Column[] {
    return [
      { name: "category", type: "Integer" },
      { name: "amt", type: "Double" },
      { name: "gender", type: "Integer" },
      { name: "street", type: "Integer" },
      { name: "city", type: "Integer" },
      { name: "state", type: "Integer" },
      { name: "job", type: "Integer" },
    ];
  }

  private getHardcodedFeatureColumns(): Column[] {
    return [{ name: "is_fraud", type: "Integer" }];
  }
}
