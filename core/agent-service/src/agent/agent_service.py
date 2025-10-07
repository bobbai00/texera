"""
Main agent service for workflow collaboration.
"""

import asyncio
import json
import time
from typing import Dict, List, Optional, Any
import websockets
import structlog

from .config import AgentConfig
from .llm_provider import LLMProvider
from .workflow_tools import WorkflowToolkit
from .models import (
    AgentSession,
    AgentStatus,
    ModelConfig,
    WorkflowEvent,
    WorkflowState,
    InviteAgentResponse,
    RemoveAgentResponse,
    AgentStatusResponse,
    SendChatRequest,
    SendChatResponse,
    ChatHistoryRequest,
    ChatHistoryResponse,
    ChatMessage,
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
        self.chat_history: Dict[int, List[ChatMessage]] = {}  # Store chat history per workflow

    async def invite_agent(self, workflow_id: int) -> InviteAgentResponse:
        """
        Invite agent to join a workflow.

        Args:
            workflow_id: Workflow ID to invite agent to

        Returns:
            Invitation response with agent user ID
        """
        # Check if agent already in workflow
        if workflow_id in self.active_sessions:
            session = self.active_sessions[workflow_id]
            return InviteAgentResponse(
                success=True,
                agent_user_id=session.agent_user_id,
                message="Agent already in workflow",
            )

        try:
            # Always use default configuration from environment
            default_model_dict = self.config.default_model
            llm_config = ModelConfig(**default_model_dict)
            logger.info(
                f"Using default model config: provider={llm_config.provider}, model={llm_config.model}"
            )

            # Create new session
            session = AgentSession(
                workflow_id=workflow_id,
                agent_user_id=self._generate_agent_user_id(),
                llm_config=llm_config,
                start_time=int(time.time() * 1000),
                status=AgentStatus.CONNECTING,
                workflow_state=WorkflowState(),
            )

            # Connect to shared editing
            await self._connect_to_shared_editing(session)

            # Store session
            self.active_sessions[workflow_id] = session

            logger.info(f"Agent joined workflow {workflow_id} as user {session.agent_user_id}")

            return InviteAgentResponse(
                success=True,
                agent_user_id=session.agent_user_id,
                message="Agent successfully joined workflow",
            )

        except Exception as e:
            logger.error(f"Error inviting agent to workflow {workflow_id}: {e}")
            return InviteAgentResponse(success=False, message=f"Failed to invite agent: {str(e)}")

    async def remove_agent(self, workflow_id: int) -> RemoveAgentResponse:
        """
        Remove agent from a workflow.

        Args:
            workflow_id: Workflow ID to remove agent from

        Returns:
            Removal response
        """

        if workflow_id not in self.active_sessions:
            return RemoveAgentResponse(success=False, message="Agent not in workflow")

        try:
            # Close WebSocket connection
            if workflow_id in self.ws_connections:
                await self.ws_connections[workflow_id].close()
                del self.ws_connections[workflow_id]

            # Remove session
            del self.active_sessions[workflow_id]

            logger.info(f"Agent removed from workflow {workflow_id}")

            return RemoveAgentResponse(
                success=True, message="Agent successfully removed from workflow"
            )

        except Exception as e:
            logger.error(f"Error removing agent from workflow {workflow_id}: {e}")
            return RemoveAgentResponse(success=False, message=f"Failed to remove agent: {str(e)}")

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
                workflow_id=workflow_id, is_active=True, status=session.status
            )
        else:
            return AgentStatusResponse(workflow_id=workflow_id, is_active=False)

    async def handle_workflow_event(self, workflow_id: int, event: WorkflowEvent) -> Optional[Any]:
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
                model_config=session.llm_config,
            )

            if tool_response:
                # Execute the tool
                ws_connection = self.ws_connections.get(workflow_id)
                result = await self.workflow_toolkit.execute_tool(
                    tool_response, session, ws_connection
                )
                logger.info(f"Executed tool for workflow {workflow_id}: {result}")
                return result

        except Exception as e:
            logger.error(f"Error handling workflow event: {e}")
            return None

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
        self, session: AgentSession, websocket: websockets.WebSocketClientProtocol
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
        self, session: AgentSession, event: WorkflowEvent
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
            {"role": "user", "content": user_message},
        ]

    def _generate_agent_user_id(self) -> int:
        """Generate unique agent user ID (negative to distinguish from regular users)."""
        return -int(time.time() * 1000)

    def get_available_models(self) -> List[Dict[str, str]]:
        """Get list of available models."""
        return self.llm_provider.get_available_models()

    async def send_chat_message(
        self, workflow_id: int, request: SendChatRequest
    ) -> SendChatResponse:
        """
        Send a chat message to the agent.

        Args:
            workflow_id: Workflow ID
            request: Chat request with message

        Returns:
            Chat response with agent's reply
        """
        user_message = request.message

        # Initialize chat history if needed
        if workflow_id not in self.chat_history:
            self.chat_history[workflow_id] = []

        # Add user message to history
        user_chat_message = ChatMessage(
            role="user", content=user_message, timestamp=int(time.time() * 1000)
        )
        self.chat_history[workflow_id].append(user_chat_message)

        # Update session with current workflow state if provided
        if request.workflow_state and workflow_id in self.active_sessions:
            session = self.active_sessions[workflow_id]
            if session.workflow_state:
                # Update with current state from frontend
                session.workflow_state.operators = request.workflow_state.get("operators", [])
                session.workflow_state.links = request.workflow_state.get("links", [])
                session.workflow_state.execution_status = request.workflow_state.get(
                    "execution_status"
                )

        try:
            # Get or create session
            if workflow_id not in self.active_sessions:
                # Create model config from default settings
                default_model_dict = self.config.default_model

                # Log the configuration being used
                logger.info(
                    f"Creating new session with default config: provider={default_model_dict.get('provider')}, model={default_model_dict.get('model')}"
                )

                # Validate that we have the required API key
                provider = default_model_dict.get("provider", "openai")
                if provider == "anthropic" and not self.config.anthropic_api_key:
                    raise ValueError(
                        "Anthropic provider is configured but ANTHROPIC_API_KEY is not set. "
                        "Please set the ANTHROPIC_API_KEY environment variable."
                    )
                elif provider == "openai" and not self.config.openai_api_key:
                    raise ValueError(
                        "OpenAI provider is configured but OPENAI_API_KEY is not set. "
                        "Please set the OPENAI_API_KEY environment variable."
                    )

                # Create a temporary session for chat
                session = AgentSession(
                    workflow_id=workflow_id,
                    agent_user_id=self._generate_agent_user_id(),
                    llm_config=ModelConfig(**default_model_dict),
                    start_time=int(time.time() * 1000),
                    status=AgentStatus.CONNECTED,
                    workflow_state=WorkflowState(),
                )
                self.active_sessions[workflow_id] = session
            else:
                session = self.active_sessions[workflow_id]

            # Build messages for LLM
            messages = self._build_chat_messages(workflow_id, user_message)

            # Log model config being used
            logger.info(
                f"Using model config for chat: provider={session.llm_config.provider}, model={session.llm_config.model}"
            )

            # Get response from LLM with tools
            tool_response = await self.llm_provider.get_tool_completion(
                messages=messages,
                tools=self.workflow_toolkit.get_tool_classes(),
                model_config=session.llm_config,
            )

            # Process tool response if any
            if tool_response:
                ws_connection = self.ws_connections.get(workflow_id)
                result = await self.workflow_toolkit.execute_tool(
                    tool_response, session, ws_connection
                )

                # Create a more structured response
                tool_name = tool_response.__class__.__name__
                tool_type = tool_name.replace("Tool", "")

                # Format the response for easy parsing
                if result.get("success"):
                    assistant_content = f"I've successfully executed the {tool_type} operation.\n\n"
                    assistant_content += f"**Action**: {tool_name}\n"
                    assistant_content += (
                        f"**Parameters**: {json.dumps(tool_response.__dict__, indent=2)}\n"
                    )
                    assistant_content += f"**Result**: Operation completed successfully"

                    if result.get("message"):
                        assistant_content += f" - {result['message']}"
                else:
                    assistant_content = f"I attempted to execute {tool_type} but encountered an error: {result.get('error', 'Unknown error')}"
            else:
                # Get text response from LLM without tools
                text_response = await self.llm_provider.get_completion(
                    messages=messages, model_config=session.llm_config
                )
                assistant_content = text_response

            # Add assistant message to history
            assistant_message = ChatMessage(
                role="assistant", content=assistant_content, timestamp=int(time.time() * 1000)
            )
            self.chat_history[workflow_id].append(assistant_message)

            # Create response with tool execution metadata
            response = SendChatResponse(success=True, message=assistant_message)

            # Add tool execution data to response for frontend
            if tool_response and result.get("success"):
                response_dict = response.dict()
                response_dict["message"]["toolExecutions"] = [
                    {
                        "type": tool_response.__class__.__name__.replace("Tool", ""),
                        "data": tool_response.__dict__,
                        "result": result,
                    }
                ]
                return SendChatResponse(**response_dict)

            return response

        except Exception as e:
            logger.error(f"Error processing chat message: {e}")

            # Add error message to history
            error_message = ChatMessage(
                role="system", content=f"Error: {str(e)}", timestamp=int(time.time() * 1000)
            )
            self.chat_history[workflow_id].append(error_message)

            return SendChatResponse(success=False, error=str(e))

    async def get_chat_history(
        self, workflow_id: int, request: ChatHistoryRequest
    ) -> ChatHistoryResponse:
        """
        Get chat history for a workflow.

        Args:
            workflow_id: Workflow ID
            request: History request with filters

        Returns:
            Chat history response
        """
        limit = request.limit or 50
        before_timestamp = request.before_timestamp

        # Get chat history for workflow
        history = self.chat_history.get(workflow_id, [])

        # Filter by timestamp if provided
        if before_timestamp:
            history = [msg for msg in history if msg.timestamp < before_timestamp]

        # Apply limit
        if len(history) > limit:
            history = history[-limit:]
            has_more = True
        else:
            has_more = False

        return ChatHistoryResponse(success=True, messages=history, has_more=has_more)

    def _build_chat_messages(self, workflow_id: int, user_message: str) -> List[Dict[str, str]]:
        """
        Build messages for chat completion.

        Args:
            workflow_id: Workflow ID
            user_message: User's message

        Returns:
            List of messages for LLM
        """
        system_prompt = (
            "You are an AI assistant helping users build and edit data workflows in Texera. "
            f"You are currently working on workflow {workflow_id}. "
            "You have access to tools for adding/removing operators, creating links, and modifying properties. "
            "When users ask you to modify the workflow, use the provided tools. "
            "Be helpful, concise, and accurate in your responses."
        )

        # Add workflow state context if available
        if workflow_id in self.active_sessions:
            session = self.active_sessions[workflow_id]
            if session.workflow_state:
                state_info = (
                    f"\n\nCurrent workflow state:\n"
                    f"- Operators: {len(session.workflow_state.operators)}\n"
                    f"- Links: {len(session.workflow_state.links)}\n"
                    f"- Status: {session.workflow_state.execution_status or 'Not running'}"
                )
                system_prompt += state_info

        messages = [{"role": "system", "content": system_prompt}]

        # Add recent chat history for context (last 10 messages)
        history = self.chat_history.get(workflow_id, [])
        recent_history = history[-10:] if len(history) > 10 else history

        for msg in recent_history[:-1]:  # Exclude the last message (current user message)
            messages.append({"role": msg.role, "content": msg.content})

        # Add current user message
        messages.append({"role": "user", "content": user_message})

        return messages
