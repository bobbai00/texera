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

import { Injectable, NgZone } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import {
  Observable,
  Subject,
  BehaviorSubject,
  catchError,
  map,
  of,
  shareReplay,
  defer,
  throwError,
  interval,
  switchMap,
  takeUntil,
} from "rxjs";
import { NotificationService } from "../../../common/service/notification/notification.service";
import { WorkflowPersistService } from "../../../common/service/workflow-persist/workflow-persist.service";
import { AppSettings } from "../../../common/app-setting";
import { AuthService } from "../../../common/service/user/auth.service";
import { CopilotState, ReActStep, ModelMessage, CopilotMessageStats } from "./texera-copilot";
import { Workflow } from "../../../common/type/workflow";

/**
 * Agent information for tracking created agents (API version).
 */
export interface AgentInfo {
  id: string;
  name: string;
  modelType: string;
  isBaselineMode: boolean;
  createdAt: Date;
  /** State is fetched from API */
  state?: CopilotState;
  delegate?: {
    userInfo: { uid: number; name: string; email: string; role: string };
    workflowId?: number;
    workflowName?: string;
  };
}

/**
 * Available model types for agent creation.
 */
export interface ModelType {
  id: string;
  name: string;
  description: string;
  icon: string;
}

/**
 * API response types
 */
interface ApiAgentInfo {
  id: string;
  name: string;
  modelType: string;
  state: string;
  createdAt: string;
  delegate?: {
    userToken: string;
    userInfo: { uid: number; name: string; email: string; role: string };
    workflowId?: number;
    workflowName?: string;
  };
}

interface ApiAgentListResponse {
  agents: ApiAgentInfo[];
}

interface ApiReActStepsResponse {
  steps: any[];
  state: string;
}

interface ApiMessageResponse {
  response: string;
  steps: any[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  stats: any;
  stopped: boolean;
  error?: string;
  workflow: any;
}

interface LiteLLMModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface LiteLLMModelsResponse {
  data: LiteLLMModel[];
  object: string;
}

/**
 * Agent state tracking for observables
 */
interface AgentStateTracking {
  stateSubject: BehaviorSubject<CopilotState>;
  reActStepsSubject: BehaviorSubject<ReActStep[]>;
  messageStatsSubject: BehaviorSubject<Map<string, CopilotMessageStats>>;
  hoveredMessageSubject: BehaviorSubject<{
    viewedOperatorIds: string[];
    addedOperatorIds: string[];
    modifiedOperatorIds: string[];
  }>;
  agentActionApprovalSubject: BehaviorSubject<{ isWaitingForApproval: boolean; agentActionId?: string }>;
  workflowSubject: BehaviorSubject<Workflow | null>;
  workflowId?: number;
  stopPolling$: Subject<void>;
  /** WebSocket connection for real-time updates */
  websocket?: WebSocket;
}

/**
 * Service to manage multiple copilot agents via API calls to agent-service.
 * This is a complete replacement of the direct TexeraCopilot implementation.
 */
@Injectable({
  providedIn: "root",
})
export class TexeraCopilotManagerService {
  /** Base URL for agent service API */
  private readonly AGENT_API_BASE = "/api";

  /** Local cache of agent info */
  private agents = new Map<string, AgentInfo>();

  /** State tracking for each agent */
  private agentStateTracking = new Map<string, AgentStateTracking>();

  /** Subject for agent list changes */
  private agentChangeSubject = new Subject<void>();
  public agentChange$ = this.agentChangeSubject.asObservable();

  /** Cached model types */
  private modelTypes$: Observable<ModelType[]> | null = null;

  /** Planning mode state per agent */
  private planningModes = new Map<string, boolean>();

  constructor(
    private http: HttpClient,
    private notificationService: NotificationService,
    private workflowPersistService: WorkflowPersistService,
    private ngZone: NgZone
  ) {}

  /**
   * Convert API state string to CopilotState enum
   */
  private mapStateToCopilotState(state: string): CopilotState {
    switch (state) {
      case "AVAILABLE":
        return CopilotState.AVAILABLE;
      case "GENERATING":
        return CopilotState.GENERATING;
      case "STOPPING":
        return CopilotState.STOPPING;
      case "UNAVAILABLE":
      default:
        return CopilotState.UNAVAILABLE;
    }
  }

  /**
   * Convert API ReActStep to frontend ReActStep format.
   * The backend now sends ReActSteps in the aligned format, so minimal conversion is needed.
   */
  private convertApiReActStep(apiStep: any): ReActStep {
    // Convert operator access from object to Map if present
    let operatorAccess: Map<number, any> | undefined;
    if (apiStep.operatorAccess) {
      operatorAccess = new Map();
      for (const [key, value] of Object.entries(apiStep.operatorAccess)) {
        operatorAccess.set(parseInt(key), value);
      }
    }

    return {
      messageId: apiStep.messageId,
      stepId: apiStep.stepId || 0,
      timestamp: new Date(apiStep.timestamp),
      role: apiStep.role || "agent",
      content: apiStep.content || "",
      isBegin: apiStep.isBegin || false,
      isEnd: apiStep.isEnd || false,
      toolCalls: apiStep.toolCalls,
      toolResults: apiStep.toolResults?.map((tr: any) => ({
        ...tr,
        // Ensure compatibility: backend uses 'output', frontend expects 'result' or 'output'
        result: tr.output || tr.result,
        output: tr.output || tr.result,
      })),
      usage: apiStep.usage,
      operatorAccess,
    };
  }

  /**
   * Get or create state tracking for an agent
   */
  private getOrCreateStateTracking(agentId: string, workflowId?: number): AgentStateTracking {
    let tracking = this.agentStateTracking.get(agentId);
    if (!tracking) {
      tracking = {
        stateSubject: new BehaviorSubject<CopilotState>(CopilotState.UNAVAILABLE),
        reActStepsSubject: new BehaviorSubject<ReActStep[]>([]),
        messageStatsSubject: new BehaviorSubject<Map<string, CopilotMessageStats>>(new Map()),
        hoveredMessageSubject: new BehaviorSubject<{
          viewedOperatorIds: string[];
          addedOperatorIds: string[];
          modifiedOperatorIds: string[];
        }>({ viewedOperatorIds: [], addedOperatorIds: [], modifiedOperatorIds: [] }),
        agentActionApprovalSubject: new BehaviorSubject<{ isWaitingForApproval: boolean; agentActionId?: string }>({
          isWaitingForApproval: false,
        }),
        workflowSubject: new BehaviorSubject<Workflow | null>(null),
        workflowId,
        stopPolling$: new Subject<void>(),
      };
      this.agentStateTracking.set(agentId, tracking);

      // Start polling for state updates
      this.startStatePolling(agentId, tracking);
    }
    return tracking;
  }

  /**
   * Start WebSocket connection for real-time ReActSteps updates
   */
  private startStatePolling(agentId: string, tracking: AgentStateTracking): void {
    // Build WebSocket URL
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${window.location.host}${this.AGENT_API_BASE}/agents/${agentId}/react`;

    console.log(`[CopilotManager] Connecting to WebSocket: ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    tracking.websocket = ws;

    ws.onopen = () => {
      console.log(`[CopilotManager] WebSocket connected for agent ${agentId}`);
    };

    ws.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        this.ngZone.run(() => {
          this.handleWebSocketMessage(agentId, tracking, message);
        });
      } catch (error) {
        console.error(`[CopilotManager] Failed to parse WebSocket message:`, error);
      }
    };

    ws.onerror = error => {
      console.error(`[CopilotManager] WebSocket error for agent ${agentId}:`, error);
    };

    ws.onclose = () => {
      console.log(`[CopilotManager] WebSocket closed for agent ${agentId}`);
      tracking.websocket = undefined;
    };

    // Poll workflow content from backend database if workflowId is set
    if (tracking.workflowId) {
      const wid = tracking.workflowId;
      interval(1000)
        .pipe(
          switchMap(() => this.workflowPersistService.retrieveWorkflow(wid).pipe(catchError(() => of(null)))),
          takeUntil(tracking.stopPolling$)
        )
        .subscribe(workflow => {
          if (workflow) {
            this.ngZone.run(() => {
              tracking.workflowSubject.next(workflow);
            });
          }
        });
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleWebSocketMessage(agentId: string, tracking: AgentStateTracking, message: any): void {
    switch (message.type) {
      case "init":
        // Initial state and steps
        if (message.state) {
          tracking.stateSubject.next(this.mapStateToCopilotState(message.state));
        }
        if (message.steps && Array.isArray(message.steps)) {
          const steps = message.steps.map((s: any) => this.convertApiReActStep(s));
          tracking.reActStepsSubject.next(steps);
        }
        break;

      case "step":
        // New step received - update existing step or append new one
        if (message.step) {
          const convertedStep = this.convertApiReActStep(message.step);
          const currentSteps = tracking.reActStepsSubject.getValue();

          // Check if step with same messageId and stepId already exists
          const existingIndex = currentSteps.findIndex(
            s => s.messageId === convertedStep.messageId && s.stepId === convertedStep.stepId
          );

          if (existingIndex >= 0) {
            // Update existing step (e.g., when isEnd changes from false to true)
            const updatedSteps = [...currentSteps];
            updatedSteps[existingIndex] = convertedStep;
            tracking.reActStepsSubject.next(updatedSteps);
          } else {
            // Append new step
            tracking.reActStepsSubject.next([...currentSteps, convertedStep]);
          }
        }
        break;

      case "state":
        // State update
        if (message.state) {
          tracking.stateSubject.next(this.mapStateToCopilotState(message.state));
        }
        break;

      case "complete":
        // Message processing complete
        if (message.state) {
          tracking.stateSubject.next(this.mapStateToCopilotState(message.state));
        }
        break;

      case "error":
        // Error occurred
        console.error(`[CopilotManager] Agent ${agentId} error:`, message.error);
        this.notificationService.error(message.error || "Agent error occurred");
        break;

      default:
        console.warn(`[CopilotManager] Unknown message type:`, message.type);
    }
  }

  /**
   * Stop WebSocket connection and polling for an agent
   */
  private stopStatePolling(agentId: string): void {
    const tracking = this.agentStateTracking.get(agentId);
    if (tracking) {
      // Close WebSocket if open
      if (tracking.websocket) {
        tracking.websocket.close();
        tracking.websocket = undefined;
      }
      tracking.stopPolling$.next();
      tracking.stopPolling$.complete();
      this.agentStateTracking.delete(agentId);
    }
  }

  /**
   * Create a new agent with the specified model type.
   * Uses the user's current auth token for delegate mode.
   * @param modelType - The LLM model type to use
   * @param customName - Optional custom name for the agent
   * @param isBaselineMode - Whether the agent is in baseline mode
   * @param workflowId - Optional workflow ID for delegate mode
   */
  public createAgent(
    modelType: string,
    customName?: string,
    isBaselineMode: boolean = false,
    workflowId?: number
  ): Observable<AgentInfo> {
    return defer(() => {
      const userToken = AuthService.getAccessToken();

      const body: any = {
        modelType,
        name: customName,
      };

      // Include user token and workflowId for delegate mode if available
      if (userToken) {
        body.userToken = userToken;
        if (workflowId !== undefined) {
          body.workflowId = workflowId;
        }
      }

      return this.http.post<ApiAgentInfo>(`${this.AGENT_API_BASE}/agents`, body).pipe(
        map(response => {
          const agentInfo: AgentInfo = {
            id: response.id,
            name: response.name,
            modelType: response.modelType,
            isBaselineMode,
            createdAt: new Date(response.createdAt),
            state: this.mapStateToCopilotState(response.state),
            delegate: response.delegate
              ? {
                  userInfo: response.delegate.userInfo,
                  workflowId: response.delegate.workflowId,
                  workflowName: response.delegate.workflowName,
                }
              : undefined,
          };

          this.agents.set(response.id, agentInfo);
          // Pass workflowId to enable workflow polling from backend database
          const tracking = this.getOrCreateStateTracking(response.id, workflowId);
          // Set the initial state from the API response (agent is AVAILABLE after creation)
          tracking.stateSubject.next(agentInfo.state || CopilotState.AVAILABLE);
          this.agentChangeSubject.next();

          return agentInfo;
        }),
        catchError((error: unknown) => {
          const err = error as { error?: { error?: string }; message?: string };
          const errorMsg = err.error?.error || err.message || "Failed to create agent";
          this.notificationService.error(errorMsg);
          return throwError(() => new Error(errorMsg));
        })
      );
    });
  }

  /**
   * Get an agent by ID.
   */
  public getAgent(agentId: string): Observable<AgentInfo> {
    return defer(() => {
      const agent = this.agents.get(agentId);
      if (agent) {
        return of(agent);
      }

      // Fetch from API if not in cache
      return this.http.get<ApiAgentInfo>(`${this.AGENT_API_BASE}/agents/${agentId}`).pipe(
        map(response => {
          const agentInfo: AgentInfo = {
            id: response.id,
            name: response.name,
            modelType: response.modelType,
            isBaselineMode: false,
            createdAt: new Date(response.createdAt),
            state: this.mapStateToCopilotState(response.state),
          };
          this.agents.set(response.id, agentInfo);
          return agentInfo;
        }),
        catchError(() => throwError(() => new Error(`Agent with ID ${agentId} not found`)))
      );
    });
  }

  /**
   * Get all agents.
   */
  public getAllAgents(): Observable<AgentInfo[]> {
    return this.http.get<ApiAgentListResponse>(`${this.AGENT_API_BASE}/agents`).pipe(
      map(response => {
        const agents = response.agents.map(a => ({
          id: a.id,
          name: a.name,
          modelType: a.modelType,
          isBaselineMode: false,
          createdAt: new Date(a.createdAt),
          state: this.mapStateToCopilotState(a.state),
        }));

        // Update local cache
        for (const agent of agents) {
          this.agents.set(agent.id, agent);
        }

        return agents;
      }),
      catchError(() => of(Array.from(this.agents.values())))
    );
  }

  /**
   * Delete an agent by ID.
   */
  public deleteAgent(agentId: string): Observable<boolean> {
    return this.http.delete<{ deleted: boolean }>(`${this.AGENT_API_BASE}/agents/${agentId}`).pipe(
      map(response => {
        if (response.deleted) {
          this.agents.delete(agentId);
          this.stopStatePolling(agentId);
          this.agentChangeSubject.next();
        }
        return response.deleted;
      }),
      catchError(() => {
        this.agents.delete(agentId);
        this.stopStatePolling(agentId);
        this.agentChangeSubject.next();
        return of(true);
      })
    );
  }

  /**
   * Fetch available models from the API.
   */
  public fetchModelTypes(): Observable<ModelType[]> {
    if (!this.modelTypes$) {
      this.modelTypes$ = this.http.get<LiteLLMModelsResponse>(`${AppSettings.getApiEndpoint()}/models`).pipe(
        map(response =>
          response.data.map((model: LiteLLMModel) => ({
            id: model.id,
            name: this.formatModelName(model.id),
            description: `Model: ${model.id}`,
            icon: "robot",
          }))
        ),
        catchError((error: unknown) => {
          console.error("Failed to fetch models from API:", error);
          return of([]);
        }),
        shareReplay(1)
      );
    }
    return this.modelTypes$;
  }

  private formatModelName(modelId: string): string {
    return modelId
      .split("-")
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  /**
   * Get the count of active agents.
   */
  public getAgentCount(): Observable<number> {
    return of(this.agents.size);
  }

  /**
   * Send a message to an agent via WebSocket.
   * The message is sent through the WebSocket connection for real-time streaming.
   */
  public sendMessage(agentId: string, message: string, relevantOperatorIds: string[] = []): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      this.notificationService.error(`Agent with ID ${agentId} not found`);
      return;
    }

    const tracking = this.agentStateTracking.get(agentId);
    if (!tracking || !tracking.websocket || tracking.websocket.readyState !== WebSocket.OPEN) {
      this.notificationService.error("WebSocket connection not available");
      return;
    }

    // Send message via WebSocket
    const wsMessage = {
      type: "message",
      content: message,
    };

    try {
      tracking.websocket.send(JSON.stringify(wsMessage));
      console.log(`[CopilotManager] Sent message to agent ${agentId}: ${message.substring(0, 50)}...`);
    } catch (error) {
      console.error(`[CopilotManager] Failed to send message:`, error);
      this.notificationService.error("Failed to send message");
    }
  }

  /**
   * Get the ReActSteps observable stream.
   */
  public getReActStepsObservable(agentId: string): Observable<ReActStep[]> {
    const tracking = this.getOrCreateStateTracking(agentId);
    return tracking.reActStepsSubject.asObservable();
  }

  /**
   * Get the current ReActSteps.
   */
  public getReActSteps(agentId: string): Observable<ReActStep[]> {
    return this.http.get<ApiReActStepsResponse>(`${this.AGENT_API_BASE}/agents/${agentId}/react-steps`).pipe(
      map(response => response.steps.map((s: any) => this.convertApiReActStep(s))),
      catchError(() => of([]))
    );
  }

  /**
   * Clear all messages for an agent.
   */
  public clearMessages(agentId: string): void {
    this.http.post(`${this.AGENT_API_BASE}/agents/${agentId}/clear`, {}).subscribe({
      next: () => {
        const tracking = this.agentStateTracking.get(agentId);
        if (tracking) {
          tracking.reActStepsSubject.next([]);
          tracking.messageStatsSubject.next(new Map());
        }
      },
      error: (error: unknown) => {
        console.error(`Error clearing messages for agent ${agentId}:`, error);
      },
    });
  }

  /**
   * Stop generation for an agent via WebSocket.
   */
  public stopGeneration(agentId: string): void {
    const tracking = this.agentStateTracking.get(agentId);
    if (tracking?.websocket && tracking.websocket.readyState === WebSocket.OPEN) {
      // Send stop via WebSocket for immediate effect
      try {
        tracking.websocket.send(JSON.stringify({ type: "stop" }));
        console.log(`[CopilotManager] Sent stop command to agent ${agentId}`);
      } catch (error) {
        console.error(`[CopilotManager] Failed to send stop command:`, error);
      }
    } else {
      // Fallback to HTTP if WebSocket not available
      this.http.post(`${this.AGENT_API_BASE}/agents/${agentId}/stop`, {}).subscribe({
        error: (error: unknown) => {
          console.error(`Error stopping agent ${agentId}:`, error);
        },
      });
    }
  }

  /**
   * Get the current state of an agent.
   */
  public getAgentState(agentId: string): Observable<CopilotState> {
    return defer(() => {
      const tracking = this.agentStateTracking.get(agentId);
      if (tracking) {
        return of(tracking.stateSubject.getValue());
      }
      return of(CopilotState.UNAVAILABLE);
    });
  }

  /**
   * Get the state observable stream for an agent.
   */
  public getAgentStateObservable(agentId: string): Observable<CopilotState> {
    const tracking = this.getOrCreateStateTracking(agentId);
    return tracking.stateSubject.asObservable();
  }

  /**
   * Check if an agent is connected.
   */
  public isAgentConnected(agentId: string): Observable<boolean> {
    return this.getAgentState(agentId).pipe(map(state => state !== CopilotState.UNAVAILABLE));
  }

  /**
   * Set planning mode for an agent (local state only).
   */
  public setPlanningMode(agentId: string, planningMode: boolean): void {
    this.planningModes.set(agentId, planningMode);
  }

  /**
   * Get planning mode for an agent.
   */
  public getPlanningMode(agentId: string): boolean {
    return this.planningModes.get(agentId) || false;
  }

  /**
   * Get system information for an agent (system prompt and tools).
   * Fetches from agent-service API.
   */
  public getSystemInfo(agentId: string): Observable<{
    systemPrompt: string;
    tools: Array<{ name: string; description: string; inputSchema: any; enabled: boolean }>;
  }> {
    return this.http
      .get<{
        systemPrompt: string;
        tools: Array<{ name: string; description: string; inputSchema: any; enabled: boolean }>;
      }>(`${this.AGENT_API_BASE}/agents/${agentId}/system-info`)
      .pipe(
        catchError(() =>
          of({
            systemPrompt: "Unable to retrieve system prompt",
            tools: [],
          })
        )
      );
  }

  /**
   * Get agent internal state for debugging.
   * Fetches from agent-service API.
   */
  public getAgentInternalState(agentId: string): Observable<object> {
    return this.http.get<object>(`${this.AGENT_API_BASE}/agents/${agentId}/state`).pipe(catchError(() => of({})));
  }

  /**
   * Set hovered message (local UI state).
   */
  public setHoveredMessage(agentId: string, step: ReActStep | null): void {
    const tracking = this.agentStateTracking.get(agentId);
    if (tracking) {
      if (step && step.operatorAccess) {
        const viewedOperatorIds: string[] = [];
        const addedOperatorIds: string[] = [];
        const modifiedOperatorIds: string[] = [];

        step.operatorAccess.forEach(access => {
          viewedOperatorIds.push(...access.viewedOperatorIds);
          addedOperatorIds.push(...access.addedOperatorIds);
          modifiedOperatorIds.push(...access.modifiedOperatorIds);
        });

        tracking.hoveredMessageSubject.next({
          viewedOperatorIds: [...new Set(viewedOperatorIds)],
          addedOperatorIds: [...new Set(addedOperatorIds)],
          modifiedOperatorIds: [...new Set(modifiedOperatorIds)],
        });
      } else {
        tracking.hoveredMessageSubject.next({
          viewedOperatorIds: [],
          addedOperatorIds: [],
          modifiedOperatorIds: [],
        });
      }
    }
  }

  /**
   * Get hovered message operators observable.
   */
  public getHoveredMessageOperatorsObservable(
    agentId: string
  ): Observable<{ viewedOperatorIds: string[]; addedOperatorIds: string[]; modifiedOperatorIds: string[] }> {
    const tracking = this.getOrCreateStateTracking(agentId);
    return tracking.hoveredMessageSubject.asObservable();
  }

  /**
   * Get message stats observable.
   */
  public getMessageStatsObservable(agentId: string): Observable<Map<string, CopilotMessageStats>> {
    const tracking = this.getOrCreateStateTracking(agentId);
    return tracking.messageStatsSubject.asObservable();
  }

  /**
   * Get all model messages for an agent.
   */
  public getMessages(agentId: string): ModelMessage[] {
    // Messages are managed on the server
    // This would require an API call
    return [];
  }

  /**
   * Get agent action approval observable.
   */
  public getAgentActionApprovalObservable(
    agentId: string
  ): Observable<{ isWaitingForApproval: boolean; agentActionId?: string }> {
    const tracking = this.getOrCreateStateTracking(agentId);
    return tracking.agentActionApprovalSubject.asObservable();
  }

  /**
   * Get ReActSteps that viewed or modified a specific operator.
   */
  public getReActStepsByOperatorAccess(
    agentId: string,
    operatorId: string
  ): Observable<{ viewedBy: ReActStep[]; modifiedBy: ReActStep[] }> {
    return this.getReActSteps(agentId).pipe(
      map(allSteps => {
        const viewedBy: ReActStep[] = [];
        const modifiedBy: ReActStep[] = [];

        for (const step of allSteps) {
          if (step.operatorAccess) {
            step.operatorAccess.forEach(access => {
              if (access.viewedOperatorIds.includes(operatorId) && !viewedBy.includes(step)) {
                viewedBy.push(step);
              }
              if (access.modifiedOperatorIds.includes(operatorId) && !modifiedBy.includes(step)) {
                modifiedBy.push(step);
              }
            });
          }
        }

        return { viewedBy, modifiedBy };
      })
    );
  }

  /**
   * Get workflow observable for an agent.
   * This observable emits the full Workflow object from the backend database
   * whenever the agent's workflow changes.
   */
  public getWorkflowObservable(agentId: string): Observable<Workflow | null> {
    const tracking = this.agentStateTracking.get(agentId);
    if (tracking) {
      return tracking.workflowSubject.asObservable();
    }
    return of(null);
  }
}
