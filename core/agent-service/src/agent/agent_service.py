"""
Main agent service for workflow collaboration.
"""

import asyncio
import json
import time
from typing import Dict, List, Optional, Any
import websockets
import structlog
from tenacity import retry, stop_after_attempt, wait_exponential

from .config import AgentConfig
from .llm_provider import LLMProvider
from .workflow_tools import WorkflowToolkit
from .models import (
    AgentSession,
    AgentStatus,
    ModelConfig,
    WorkflowEvent,
    WorkflowState,
    InviteAgentRequest,
    InviteAgentResponse,
    RemoveAgentRequest,
    RemoveAgentResponse,
    AgentStatusResponse
)

logger = structlog.get_logger()


class AgentService:
    """Service managing LLM agents for workflow collaboration."""

    def __init__(self, config: Optional[AgentConfig] = None):
        """
        Initialize agent service.

        Args:
            config: Agent configuration (uses default if None)
        """
        self.config = config or AgentConfig()
        self.llm_provider = LLMProvider(self.config)
        self.workflow_toolkit = WorkflowToolkit()
        self.active_sessions: Dict[int, AgentSession] = {}
        self.ws_connections: Dict[int, websockets.WebSocketClientProtocol] = {}

    async def invite_agent(self, request: InviteAgentRequest) -> InviteAgentResponse:
        """
        Invite agent to join a workflow.

        Args:
            request: Invitation request with workflow ID and optional model config

        Returns:
            Invitation response with agent user ID
        """
        workflow_id = request.workflow_id

        # Check if agent already in workflow
        if workflow_id in self.active_sessions:
            session = self.active_sessions[workflow_id]
            return InviteAgentResponse(
                success=True,
                agent_user_id=session.agent_user_id,
                message="Agent already in workflow"
            )

        try:
            # Create new session
            session = AgentSession(
                workflow_id=workflow_id,
                agent_user_id=self._generate_agent_user_id(),
                llm_config=request.llm_config or ModelConfig(**self.config.default_model),
                start_time=int(time.time() * 1000),
                status=AgentStatus.CONNECTING,
                workflow_state=WorkflowState()
            )

            # Connect to shared editing
            await self._connect_to_shared_editing(session)

            # Store session
            self.active_sessions[workflow_id] = session

            logger.info(f"Agent joined workflow {workflow_id} as user {session.agent_user_id}")

            return InviteAgentResponse(
                success=True,
                agent_user_id=session.agent_user_id,
                message="Agent successfully joined workflow"
            )

        except Exception as e:
            logger.error(f"Error inviting agent to workflow {workflow_id}: {e}")
            return InviteAgentResponse(
                success=False,
                message=f"Failed to invite agent: {str(e)}"
            )

    async def remove_agent(self, request: RemoveAgentRequest) -> RemoveAgentResponse:
        """
        Remove agent from a workflow.

        Args:
            request: Removal request with workflow ID

        Returns:
            Removal response
        """
        workflow_id = request.workflow_id

        if workflow_id not in self.active_sessions:
            return RemoveAgentResponse(
                success=False,
                message="Agent not in workflow"
            )

        try:
            # Close WebSocket connection
            if workflow_id in self.ws_connections:
                await self.ws_connections[workflow_id].close()
                del self.ws_connections[workflow_id]

            # Remove session
            del self.active_sessions[workflow_id]

            logger.info(f"Agent removed from workflow {workflow_id}")

            return RemoveAgentResponse(
                success=True,
                message="Agent successfully removed from workflow"
            )

        except Exception as e:
            logger.error(f"Error removing agent from workflow {workflow_id}: {e}")
            return RemoveAgentResponse(
                success=False,
                message=f"Failed to remove agent: {str(e)}"
            )

    async def get_agent_status(self, workflow_id: int) -> AgentStatusResponse:
        """
        Get agent status for a workflow.

        Args:
            workflow_id: Workflow ID

        Returns:
            Agent status response
        """
        if workflow_id in self.active_sessions:
            session = self.active_sessions[workflow_id]
            return AgentStatusResponse(
                workflow_id=workflow_id,
                is_active=True,
                status=session.status
            )
        else:
            return AgentStatusResponse(
                workflow_id=workflow_id,
                is_active=False
            )

    async def handle_workflow_event(
        self,
        workflow_id: int,
        event: WorkflowEvent
    ) -> Optional[Any]:
        """
        Handle workflow event and generate agent response.

        Args:
            workflow_id: Workflow ID
            event: Workflow event

        Returns:
            Agent's tool response if applicable
        """
        if workflow_id not in self.active_sessions:
            logger.warning(f"No session for workflow {workflow_id}")
            return None

        session = self.active_sessions[workflow_id]

        try:
            # Build context messages
            messages = self._build_context_messages(session, event)

            # Get tool response from LLM
            tool_response = await self.llm_provider.get_tool_completion(
                messages=messages,
                tools=self.workflow_toolkit.get_tool_classes(),
                model_config=session.llm_config
            )

            if tool_response:
                # Execute the tool
                ws_connection = self.ws_connections.get(workflow_id)
                result = await self.workflow_toolkit.execute_tool(
                    tool_response,
                    session,
                    ws_connection
                )
                logger.info(f"Executed tool for workflow {workflow_id}: {result}")
                return result

        except Exception as e:
            logger.error(f"Error handling workflow event: {e}")
            return None

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    async def _connect_to_shared_editing(self, session: AgentSession):
        """
        Connect to shared editing WebSocket server.

        Args:
            session: Agent session
        """
        ws_url = f"{self.config.shared_editing_url}/workflow/{session.workflow_id}"

        try:
            # Connect to WebSocket
            websocket = await websockets.connect(ws_url)
            self.ws_connections[session.workflow_id] = websocket

            # Update session status
            session.status = AgentStatus.CONNECTED

            # Start listening for messages
            asyncio.create_task(self._listen_to_websocket(session, websocket))

            logger.info(f"Connected to shared editing for workflow {session.workflow_id}")

        except Exception as e:
            session.status = AgentStatus.ERROR
            logger.error(f"Failed to connect to shared editing: {e}")
            raise

    async def _listen_to_websocket(
        self,
        session: AgentSession,
        websocket: websockets.WebSocketClientProtocol
    ):
        """
        Listen to WebSocket messages and handle events.

        Args:
            session: Agent session
            websocket: WebSocket connection
        """
        try:
            async for message in websocket:
                try:
                    # Parse message as workflow event
                    data = json.loads(message)
                    event = WorkflowEvent(**data)

                    # Update session status
                    session.status = AgentStatus.ACTIVE

                    # Handle the event
                    await self.handle_workflow_event(session.workflow_id, event)

                    # Reset status
                    session.status = AgentStatus.CONNECTED

                except json.JSONDecodeError:
                    logger.warning(f"Invalid JSON message: {message}")
                except Exception as e:
                    logger.error(f"Error handling WebSocket message: {e}")

        except websockets.exceptions.ConnectionClosed:
            logger.info(f"WebSocket connection closed for workflow {session.workflow_id}")
            session.status = AgentStatus.DISCONNECTED
        except Exception as e:
            logger.error(f"Error in WebSocket listener: {e}")
            session.status = AgentStatus.ERROR

    def _build_context_messages(
        self,
        session: AgentSession,
        event: WorkflowEvent
    ) -> List[Dict[str, str]]:
        """
        Build context messages for LLM.

        Args:
            session: Agent session
            event: Workflow event

        Returns:
            List of messages for LLM
        """
        system_prompt = (
            "You are an AI assistant helping users build and edit data workflows in Texera. "
            f"You are currently working on workflow {session.workflow_id}. "
            "You have access to tools for adding/removing operators, creating links, and modifying properties. "
            "Always use the provided tools to make changes to the workflow. "
            "Be helpful, concise, and accurate in your responses."
        )

        # Add workflow state context
        if session.workflow_state:
            state_info = (
                f"\n\nCurrent workflow state:\n"
                f"- Operators: {len(session.workflow_state.operators)}\n"
                f"- Links: {len(session.workflow_state.links)}\n"
                f"- Status: {session.workflow_state.execution_status or 'Not running'}"
            )
            system_prompt += state_info

        user_message = f"Workflow event received: {event.event_type}"
        if event.data:
            user_message += f"\nEvent data: {json.dumps(event.data)}"

        return [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message}
        ]

    def _generate_agent_user_id(self) -> int:
        """Generate unique agent user ID (negative to distinguish from regular users)."""
        return -int(time.time() * 1000)

    def get_available_models(self) -> List[Dict[str, str]]:
        """Get list of available models."""
        return self.llm_provider.get_available_models()