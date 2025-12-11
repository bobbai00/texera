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

/**
 * WorkflowUtilService - Utility class for creating operator predicates.
 * This mirrors the frontend's WorkflowUtilService to ensure operators
 * are created with the correct format.
 */

import Ajv from "ajv";
import type { OperatorPredicate, PortDescription } from "../types/workflow";
import type { OperatorMetadataStore } from "../tools/metadata-tools";

/**
 * Input port info from operator metadata
 */
interface InputPortInfo {
  displayName?: string;
  allowMultiLinks?: boolean;
  dependencies?: { id: number; internal: boolean }[];
}

/**
 * Output port info from operator metadata
 */
interface OutputPortInfo {
  displayName?: string;
}

/**
 * Generate a random UUID for operator IDs
 */
function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Convert input port info to port description
 */
function inputPortToPortDescription(portID: string, inputPortInfo: InputPortInfo): PortDescription {
  return {
    portID,
    displayName: inputPortInfo.displayName ?? "",
    allowMultiInputs: inputPortInfo.allowMultiLinks ?? false,
    isDynamicPort: false,
    dependencies: inputPortInfo.dependencies ?? [],
  };
}

/**
 * Convert output port info to port description
 */
function outputPortToPortDescription(portID: string, outputPortInfo: OutputPortInfo): PortDescription {
  return {
    portID,
    displayName: outputPortInfo.displayName ?? "",
    allowMultiInputs: false,
    isDynamicPort: false,
  };
}

/**
 * WorkflowUtilService provides utilities for creating operator predicates.
 * Mirrors the frontend's WorkflowUtilService to ensure consistent operator creation.
 */
export class WorkflowUtilService {
  private metadataStore: OperatorMetadataStore;
  private ajv: Ajv;

  constructor(metadataStore: OperatorMetadataStore) {
    this.metadataStore = metadataStore;
    this.ajv = new Ajv({ useDefaults: true, strict: false });
  }

  /**
   * Create a new operator predicate with default properties.
   * This method mirrors the frontend's getNewOperatorPredicate() exactly.
   *
   * @param operatorType - The type of operator to create
   * @param customDisplayName - Optional custom display name for the operator
   * @returns A new OperatorPredicate with all required fields
   */
  public getNewOperatorPredicate(operatorType: string, customDisplayName?: string): OperatorPredicate {
    const jsonSchema = this.metadataStore.getSchema(operatorType);
    const additionalMetadata = this.metadataStore.getAdditionalMetadata(operatorType);

    if (!jsonSchema || !additionalMetadata) {
      throw new Error(`operatorType ${operatorType} doesn't exist in operator metadata`);
    }

    const operatorId = operatorType + "-operator-" + generateUUID();
    const operatorProperties: Record<string, any> = {};

    // Remove the ID field for the schema to prevent warning messages from Ajv
    const { $id, ...schemaWithoutId } = jsonSchema as any;

    // Value inserted in the data will be the deep clone of the default in the schema
    const validate = this.ajv.compile(schemaWithoutId);
    validate(operatorProperties);

    const inputPorts: PortDescription[] = [];
    const outputPorts: PortDescription[] = [];

    // By default, the operator will not show advanced option in the properties to the user
    const showAdvanced = false;

    // By default, the operator is not disabled
    const isDisabled = false;

    // Use provided customDisplayName or default to the user friendly name from schema
    const displayName = customDisplayName ?? additionalMetadata.userFriendlyName;

    const dynamicInputPorts = additionalMetadata.dynamicInputPorts ?? false;
    const dynamicOutputPorts = additionalMetadata.dynamicOutputPorts ?? false;

    // Build input ports
    const inputPortInfos = additionalMetadata.inputPorts || [];
    for (let i = 0; i < inputPortInfos.length; i++) {
      const portID = "input-" + i.toString();
      const portInfo = inputPortInfos[i] as InputPortInfo;
      inputPorts.push(inputPortToPortDescription(portID, portInfo));
    }

    // Build output ports
    const outputPortInfos = additionalMetadata.outputPorts || [];
    for (let i = 0; i < outputPortInfos.length; i++) {
      const portID = "output-" + i.toString();
      const portInfo = outputPortInfos[i] as OutputPortInfo;
      outputPorts.push(outputPortToPortDescription(portID, portInfo));
    }

    // Get operator version from metadata (or use "N/A" as fallback)
    const operatorVersion = (additionalMetadata as any).operatorVersion ?? "N/A";

    return {
      operatorID: operatorId,
      operatorType,
      operatorVersion,
      operatorProperties,
      inputPorts,
      outputPorts,
      showAdvanced,
      isDisabled,
      customDisplayName: displayName,
      dynamicInputPorts,
      dynamicOutputPorts,
    };
  }

}
