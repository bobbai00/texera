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
import { HttpClient } from "@angular/common/http";
import { Observable, BehaviorSubject, interval, of } from "rxjs";
import { map, catchError, switchMap, distinctUntilChanged, filter } from "rxjs/operators";
import { NotificationService } from "../../../common/service/notification/notification.service";
import { UserService } from "../../../common/service/user/user.service";
import { WorkflowActionService } from "../workflow-graph/model/workflow-action.service";
import { CoeditorPresenceService } from "../workflow-graph/model/coeditor-presence.service";
import { Coeditor } from "../../../common/type/user";
import { environment } from "../../../../environments/environment";

/**
 * Agent model configuration
 */
export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Agent status
 */
export enum AgentStatus {
  CONNECTING = "Connecting",
  CONNECTED = "Connected",
  ACTIVE = "Active",
  DISCONNECTED = "Disconnected",
  ERROR = "Error"
}

/**
 * Model information
 */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

/**
 * Agent session information
 */
export interface AgentSession {
  workflowId: number;
  agentUserId: number;
  status: AgentStatus;
  modelConfig?: ModelConfig;
}

/**
 * Service for managing AI agent interactions with workflows
 */
@Injectable({
  providedIn: "root"
})
export class AgentService {
  private readonly API_BASE = `${environment.apiUrl}/agent`;

  // Observable for agent presence in current workflow
  private agentPresentSubject = new BehaviorSubject<boolean>(false);
  public agentPresent$ = this.agentPresentSubject.asObservable();

  // Current agent session
  private currentSession: AgentSession | null = null;

  // Available models
  private availableModels: ModelInfo[] = [];

  constructor(
    private http: HttpClient,
    private notificationService: NotificationService,
    private userService: UserService,
    private workflowActionService: WorkflowActionService,
    private coeditorPresenceService: CoeditorPresenceService
  ) {
    this.loadAvailableModels();
    this.monitorAgentPresence();
  }

  /**
   * Invites an AI agent to join the current workflow
   * @param modelConfig Optional model configuration
   * @returns Observable of the invitation response
   */
  public inviteToWorkflow(modelConfig?: ModelConfig): Observable<any> {
    const workflowId = this.workflowActionService.getWorkflowMetadata().wid;

    if (!workflowId) {
      this.notificationService.error("Cannot invite agent to unsaved workflow. Please save first.");
      return of(null);
    }

    if (!this.userService.isLogin()) {
      this.notificationService.error("Please login to use AI Assistant");
      return of(null);
    }

    const request = {
      workflowId,
      modelConfig: modelConfig || this.getDefaultModelConfig()
    };

    return this.http.post(`${this.API_BASE}/invite`, request).pipe(
      map((response: any) => {
        if (response.success) {
          this.currentSession = {
            workflowId,
            agentUserId: response.agentUserId,
            status: AgentStatus.CONNECTED,
            modelConfig: modelConfig || this.getDefaultModelConfig()
          };
          this.agentPresentSubject.next(true);
          this.notificationService.success("AI Assistant has joined the workflow");
        }
        return response;
      }),
      catchError(error => {
        this.notificationService.error("Failed to invite AI Assistant");
        console.error("Agent invitation error:", error);
        return of(null);
      })
    );
  }

  /**
   * Removes the AI agent from the current workflow
   * @returns Observable of the removal response
   */
  public removeFromWorkflow(): Observable<any> {
    const workflowId = this.workflowActionService.getWorkflowMetadata().wid;

    if (!workflowId || !this.currentSession) {
      return of(null);
    }

    return this.http.post(`${this.API_BASE}/remove`, { workflowId }).pipe(
      map((response: any) => {
        if (response.success) {
          this.currentSession = null;
          this.agentPresentSubject.next(false);
          this.notificationService.success("AI Assistant has left the workflow");
        }
        return response;
      }),
      catchError(error => {
        this.notificationService.error("Failed to remove AI Assistant");
        console.error("Agent removal error:", error);
        return of(null);
      })
    );
  }

  /**
   * Gets the current agent status for a workflow
   * @param workflowId The workflow ID
   * @returns Observable of agent status
   */
  public getAgentStatus(workflowId: number): Observable<AgentStatus | null> {
    return this.http.get(`${this.API_BASE}/status/${workflowId}`).pipe(
      map((response: any) => {
        return response.isActive ? response.status : null;
      }),
      catchError(() => of(null))
    );
  }

  /**
   * Gets available LLM models
   * @returns Observable of available models
   */
  public getAvailableModels(): Observable<ModelInfo[]> {
    return this.http.get<{ models: ModelInfo[] }>(`${this.API_BASE}/models`).pipe(
      map(response => response.models),
      catchError(() => {
        console.error("Failed to load available models");
        return of([]);
      })
    );
  }

  /**
   * Loads available models on service initialization
   */
  private loadAvailableModels(): void {
    this.getAvailableModels().subscribe(models => {
      this.availableModels = models;
    });
  }

  /**
   * Gets the default model configuration
   * @returns Default model config
   */
  private getDefaultModelConfig(): ModelConfig {
    return {
      provider: "openai",
      model: "gpt-4-turbo-preview",
      temperature: 0.7,
      maxTokens: 4096
    };
  }

  /**
   * Monitors agent presence in the current workflow
   */
  private monitorAgentPresence(): void {
    // Monitor coeditor presence for agent users (negative user IDs)
    // Since CoeditorPresenceService has a public coeditors array, not an observable
    // We'll poll periodically to check for agent presence
    interval(1000).pipe(
      map(() => this.coeditorPresenceService.coeditors.some((user: Coeditor) => user.uid < 0)),
      distinctUntilChanged()
    ).subscribe((hasAgent: boolean) => {
      this.agentPresentSubject.next(hasAgent);
    });

    // Periodically check agent status if we have a session
    interval(30000).pipe(
      filter(() => this.currentSession !== null),
      switchMap(() => {
        const workflowId = this.workflowActionService.getWorkflowMetadata().wid;
        return workflowId ? this.getAgentStatus(workflowId) : of(null);
      })
    ).subscribe(status => {
      if (this.currentSession && status) {
        this.currentSession.status = status as AgentStatus;
      } else if (this.currentSession && !status) {
        // Agent disconnected
        this.currentSession = null;
        this.agentPresentSubject.next(false);
      }
    });
  }

  /**
   * Checks if an agent is currently present
   * @returns Boolean indicating agent presence
   */
  public isAgentPresent(): boolean {
    return this.agentPresentSubject.value;
  }

  /**
   * Gets the current agent session
   * @returns Current agent session or null
   */
  public getCurrentSession(): AgentSession | null {
    return this.currentSession;
  }

  /**
   * Gets the list of cached available models
   * @returns Array of available models
   */
  public getCachedModels(): ModelInfo[] {
    return this.availableModels;
  }

  /**
   * Opens model selection dialog
   * @returns Observable of selected model or null
   */
  public selectModel(): Observable<ModelConfig | null> {
    // This would open a dialog for model selection
    // For now, return default
    return of(this.getDefaultModelConfig());
  }
}