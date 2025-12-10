#!/usr/bin/env npx ts-node
/**
 * Simple e2e test for the execution API.
 * Retrieves a workflow by ID and executes it via the ExecutionClient.
 *
 * Services:
 *   - API_ENDPOINT (port 8080): Main web service (workflow CRUD)
 *   - EXECUTION_ENDPOINT (port 8085): Execution service (sync execution)
 *
 * Usage:
 *   TEST_USER_TOKEN="your-jwt" TEST_WORKFLOW_ID="123" bun run src/bin/execution-test.ts
 */

import { retrieveWorkflow } from "../api/workflow-api";
import { setBackendConfig } from "../api/backend-api";
import { ExecutionClient, type LogicalPlan } from "../api/execution-api";

// Get config from env
const userToken = process.env.TEST_USER_TOKEN;
const workflowId = parseInt(process.env.TEST_WORKFLOW_ID || "0", 10);
const computingUnitId = parseInt(process.env.TEST_COMPUTING_UNIT_ID || "0", 10);
const apiEndpoint = process.env.API_ENDPOINT || "http://localhost:8080";
const executionEndpoint = process.env.EXECUTION_ENDPOINT || "http://localhost:8085";

if (!userToken || !workflowId) {
  console.error("Required: TEST_USER_TOKEN and TEST_WORKFLOW_ID");
  process.exit(1);
}

setBackendConfig({ apiEndpoint, executionEndpoint });

async function main() {
  console.log("=== Execution API E2E Test ===\n");
  console.log(`Workflow ID: ${workflowId}`);
  console.log(`API Endpoint (port 8080): ${apiEndpoint}`);
  console.log(`Execution Endpoint (port 8085): ${executionEndpoint}`);
  console.log(`Computing Unit ID: ${computingUnitId}\n`);

  // Step 1: Retrieve workflow from main API (port 8080)
  console.log("--- Retrieving workflow from main API ---");
  const workflow = await retrieveWorkflow(userToken!, workflowId);
  console.log(`Workflow name: ${workflow.name}`);
  console.log(`Operators: ${workflow.content.operators?.length || 0}`);
  console.log(`Links: ${workflow.content.links?.length || 0}`);

  // Build logical plan from workflow content
  const operators = (workflow.content.operators || []).map((op: any) => ({
    operatorID: op.operatorID,
    operatorType: op.operatorType,
    ...op.operatorProperties,
  }));

  const links = (workflow.content.links || []).map((link: any) => ({
    fromOpId: link.source.operatorID,
    fromPortId: { id: parseInt(link.source.portID?.replace(/\D/g, "") || "0", 10), internal: false },
    toOpId: link.target.operatorID,
    toPortId: { id: parseInt(link.target.portID?.replace(/\D/g, "") || "0", 10), internal: false },
  }));

  const logicalPlan: LogicalPlan = {
    operators,
    links,
  };

  console.log("\n--- Logical Plan ---");
  console.log(JSON.stringify(logicalPlan, null, 2));

  // Step 2: Execute workflow via ExecutionClient
  console.log("\n--- Executing workflow via ExecutionClient ---");

  const client = new ExecutionClient({
    userToken: userToken!,
    workflowId,
    userId: 0, // Not used for sync execution
    computingUnitId,
    timeoutSeconds: 300,
    maxResultRows: 100,
  });

  const result = await client.executeWorkflow(logicalPlan, `e2e-test-${Date.now()}`);

  console.log("\n--- Execution Result ---");
  console.log(JSON.stringify(result, null, 2));

  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
