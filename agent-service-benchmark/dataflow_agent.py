# -*- coding: utf-8 -*-
"""
Dataflow Agent - Python client for Texera Agent Service benchmarking.

This module provides a DataflowAgent class that communicates with the Texera Agent Service
to run DABstep benchmark tasks. It handles authentication, workflow creation, and agent
interaction via REST APIs.
"""

import time
import json
import requests
from typing import Optional, Any
from dataclasses import dataclass, field

# ============================================================================
# Configuration Constants
# ============================================================================

# Texera Backend Configuration
TEXERA_API_ENDPOINT = "http://localhost:8080"
TEXERA_COMPUTING_UNIT_ENDPOINT = "http://localhost:8888"
TEXERA_AGENT_SERVICE_ENDPOINT = "http://localhost:3001"

# Authentication Configuration
TEXERA_USERNAME = "bob@test.com"
TEXERA_PASSWORD = "123456"

# Agent Settings (matches agent-service AgentSettingsApi)
# Available models: claude-haiku-4.5, claude-sonnet-4-5, gpt-5-mini, llama-local
AGENT_MODEL_TYPE = "claude-haiku-4.5"
AGENT_MAX_STEPS = 50
AGENT_MAX_OPERATOR_RESULT_TOKEN_LIMIT = 1000
AGENT_TOOL_TIMEOUT_SECONDS = 120
AGENT_EXECUTION_TIMEOUT_MINUTES = 10
AGENT_DISABLED_TOOLS: list[str] = []

# Workflow Configuration
DEFAULT_WORKFLOW_NAME = "Benchmark Workflow"


# ============================================================================
# Data Classes
# ============================================================================


@dataclass
class AgentSettings:
    """Agent settings for API requests."""

    max_steps: int = AGENT_MAX_STEPS
    max_operator_result_token_limit: int = AGENT_MAX_OPERATOR_RESULT_TOKEN_LIMIT
    tool_timeout_seconds: int = AGENT_TOOL_TIMEOUT_SECONDS
    execution_timeout_minutes: int = AGENT_EXECUTION_TIMEOUT_MINUTES
    disabled_tools: list[str] = field(default_factory=list)

    def to_api_dict(self) -> dict[str, Any]:
        """Convert to API request format."""
        return {
            "maxSteps": self.max_steps,
            "maxOperatorResultTokenLimit": self.max_operator_result_token_limit,
            "toolTimeoutSeconds": self.tool_timeout_seconds,
            "executionTimeoutMinutes": self.execution_timeout_minutes,
            "disabledTools": self.disabled_tools,
        }


@dataclass
class AgentInfo:
    """Agent information returned from API."""

    id: str
    name: str
    model_type: str
    state: str
    created_at: str
    settings: Optional[dict] = None
    delegate: Optional[dict] = None


@dataclass
class MessageResult:
    """Result from sending a message to the agent."""

    response: str
    usage: dict
    stats: dict
    stopped: bool
    error: Optional[str] = None


# ============================================================================
# Texera API Functions
# ============================================================================


def login(
    username: str = TEXERA_USERNAME,
    password: str = TEXERA_PASSWORD,
    api_endpoint: str = TEXERA_API_ENDPOINT,
) -> str:
    """
    Login to Texera and get an access token.

    Args:
        username: Texera username
        password: Texera password
        api_endpoint: Texera API endpoint URL

    Returns:
        JWT access token

    Raises:
        requests.HTTPError: If login fails
    """
    url = f"{api_endpoint}/api/auth/login"
    payload = {"username": username, "password": password}

    response = requests.post(url, json=payload)
    response.raise_for_status()

    data = response.json()
    return data["accessToken"]


def create_workflow(
    token: str,
    name: str = DEFAULT_WORKFLOW_NAME,
    api_endpoint: str = TEXERA_API_ENDPOINT,
) -> int:
    """
    Create a new workflow in Texera.

    Args:
        token: JWT access token
        name: Workflow name
        api_endpoint: Texera API endpoint URL

    Returns:
        Workflow ID (wid)

    Raises:
        requests.HTTPError: If workflow creation fails
    """
    url = f"{api_endpoint}/api/workflow/create"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    # Empty workflow content structure
    empty_content = {
        "operators": [],
        "operatorPositions": {},
        "links": [],
        "commentBoxes": [],
        "settings": {},
    }

    payload = {
        "name": name,
        "content": json.dumps(empty_content),  # Content must be JSON stringified
    }

    response = requests.post(url, json=payload, headers=headers)
    response.raise_for_status()

    data = response.json()
    # The response contains a workflow object with wid
    return data.get("workflow", {}).get("wid") or data.get("wid")


def delete_workflow(
    token: str, workflow_id: int, api_endpoint: str = TEXERA_API_ENDPOINT
) -> bool:
    """
    Delete a workflow from Texera.

    Args:
        token: JWT access token
        workflow_id: Workflow ID to delete
        api_endpoint: Texera API endpoint URL

    Returns:
        True if deletion was successful

    Raises:
        requests.HTTPError: If workflow deletion fails
    """
    url = f"{api_endpoint}/api/workflow/delete"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {"wids": [workflow_id]}

    response = requests.post(url, json=payload, headers=headers)
    response.raise_for_status()
    return True


def get_or_create_computing_unit(
    token: str, computing_unit_endpoint: str = TEXERA_COMPUTING_UNIT_ENDPOINT
) -> Optional[int]:
    """
    Get an existing computing unit or return None if not available.

    The computing unit is optional for basic agent operations.

    Args:
        token: JWT access token
        computing_unit_endpoint: Computing unit service endpoint URL (default: port 8888)

    Returns:
        Computing unit ID (cuid) or None if not available
    """
    headers = {"Authorization": f"Bearer {token}"}

    # Try to list existing computing units from the computing-unit service
    list_url = f"{computing_unit_endpoint}/api/computing-unit"
    try:
        response = requests.get(list_url, headers=headers, timeout=5)
        if response.status_code == 200:
            units = response.json()
            if units and len(units) > 0:
                # Return the first available computing unit
                return units[0].get("computingUnit", {}).get("cuid") or units[0].get(
                    "cuid"
                )
        return None
    except Exception as e:
        # Computing unit service may not be available, which is OK
        print(f"[DataflowAgent] Computing unit service not available: {e}")
        return None


# ============================================================================
# Agent Service Functions
# ============================================================================


def create_agent(
    model_type: str,
    token: str,
    workflow_id: int,
    computing_unit_id: int,
    settings: Optional[AgentSettings] = None,
    name: Optional[str] = None,
    agent_endpoint: str = TEXERA_AGENT_SERVICE_ENDPOINT,
) -> AgentInfo:
    """
    Create a new agent in the agent service.

    Args:
        model_type: LLM model type to use
        token: JWT access token for delegate mode
        workflow_id: Workflow ID to associate with
        computing_unit_id: Computing unit ID for execution
        settings: Agent settings (optional)
        name: Custom agent name (optional)
        agent_endpoint: Agent service endpoint URL

    Returns:
        AgentInfo with created agent details

    Raises:
        requests.HTTPError: If agent creation fails
    """
    url = f"{agent_endpoint}/api/agents"

    payload: dict[str, Any] = {
        "modelType": model_type,
        "userToken": token,
        "workflowId": workflow_id,
        "computingUnitId": computing_unit_id,
    }

    if name:
        payload["name"] = name

    if settings:
        payload["settings"] = settings.to_api_dict()

    response = requests.post(url, json=payload)
    response.raise_for_status()

    data = response.json()
    return AgentInfo(
        id=data["id"],
        name=data["name"],
        model_type=data["modelType"],
        state=data["state"],
        created_at=data["createdAt"],
        settings=data.get("settings"),
        delegate=data.get("delegate"),
    )


def delete_agent(
    agent_id: str, agent_endpoint: str = TEXERA_AGENT_SERVICE_ENDPOINT
) -> bool:
    """
    Delete an agent from the agent service.

    Args:
        agent_id: Agent ID to delete
        agent_endpoint: Agent service endpoint URL

    Returns:
        True if deletion was successful

    Raises:
        requests.HTTPError: If agent deletion fails
    """
    url = f"{agent_endpoint}/api/agents/{agent_id}"
    response = requests.delete(url)
    response.raise_for_status()
    return True


def send_message(
    agent_id: str, message: str, agent_endpoint: str = TEXERA_AGENT_SERVICE_ENDPOINT
) -> MessageResult:
    """
    Send a message to an agent and get the response.

    Args:
        agent_id: Agent ID to send message to
        message: Message content
        agent_endpoint: Agent service endpoint URL

    Returns:
        MessageResult with response details

    Raises:
        requests.HTTPError: If message sending fails
    """
    url = f"{agent_endpoint}/api/agents/{agent_id}/message"
    payload = {"message": message}

    response = requests.post(url, json=payload)
    response.raise_for_status()

    data = response.json()
    return MessageResult(
        response=data["response"],
        usage=data.get("usage", {}),
        stats=data.get("stats", {}),
        stopped=data.get("stopped", False),
        error=data.get("error"),
    )


def get_react_steps(
    agent_id: str, agent_endpoint: str = TEXERA_AGENT_SERVICE_ENDPOINT
) -> list[dict]:
    """
    Get ReAct steps from an agent.

    Args:
        agent_id: Agent ID
        agent_endpoint: Agent service endpoint URL

    Returns:
        List of ReAct steps

    Raises:
        requests.HTTPError: If API call fails
    """
    url = f"{agent_endpoint}/api/agents/{agent_id}/react-steps"
    response = requests.get(url)
    response.raise_for_status()

    data = response.json()
    return data.get("steps", [])


def clear_agent_history(
    agent_id: str, agent_endpoint: str = TEXERA_AGENT_SERVICE_ENDPOINT
) -> bool:
    """
    Clear an agent's conversation history.

    Args:
        agent_id: Agent ID
        agent_endpoint: Agent service endpoint URL

    Returns:
        True if successful

    Raises:
        requests.HTTPError: If API call fails
    """
    url = f"{agent_endpoint}/api/agents/{agent_id}/clear"
    response = requests.post(url)
    response.raise_for_status()
    return True


def reset_agent(
    agent_id: str, agent_endpoint: str = TEXERA_AGENT_SERVICE_ENDPOINT
) -> bool:
    """
    Reset an agent (clear history and workflow).

    Args:
        agent_id: Agent ID
        agent_endpoint: Agent service endpoint URL

    Returns:
        True if successful

    Raises:
        requests.HTTPError: If API call fails
    """
    url = f"{agent_endpoint}/api/agents/{agent_id}/reset"
    response = requests.post(url)
    response.raise_for_status()
    return True


# ============================================================================
# DataflowAgent Class
# ============================================================================


class DataflowAgent:
    """
    A wrapper class for interacting with the Texera Agent Service.

    This class provides a similar interface to smolagents.CodeAgent for
    benchmarking purposes, allowing the DABstep benchmark to use Texera's
    dataflow-based agent instead of code-based agents.

    Example usage:
        agent = DataflowAgent(
            model_type="claude-sonnet-4-20250514",
            max_steps=10,
        )
        agent.setup()  # Login and create workflow

        answer = agent.run("What is the total revenue?")
        print(answer)

        # Inspect reasoning trace
        for step in agent.logs:
            print(step)

        agent.cleanup()  # Delete agent and workflow
    """

    def __init__(
        self,
        model_type: str = AGENT_MODEL_TYPE,
        max_steps: int = AGENT_MAX_STEPS,
        max_operator_result_token_limit: int = AGENT_MAX_OPERATOR_RESULT_TOKEN_LIMIT,
        tool_timeout_seconds: int = AGENT_TOOL_TIMEOUT_SECONDS,
        execution_timeout_minutes: int = AGENT_EXECUTION_TIMEOUT_MINUTES,
        disabled_tools: Optional[list[str]] = None,
        texera_api_endpoint: str = TEXERA_API_ENDPOINT,
        computing_unit_endpoint: str = TEXERA_COMPUTING_UNIT_ENDPOINT,
        agent_service_endpoint: str = TEXERA_AGENT_SERVICE_ENDPOINT,
        username: str = TEXERA_USERNAME,
        password: str = TEXERA_PASSWORD,
        workflow_name: str = DEFAULT_WORKFLOW_NAME,
        verbosity_level: int = 1,
    ):
        """
        Initialize the DataflowAgent.

        Args:
            model_type: LLM model type to use
            max_steps: Maximum number of steps per message
            max_operator_result_token_limit: Max tokens for operator results
            tool_timeout_seconds: Tool execution timeout in seconds
            execution_timeout_minutes: Workflow execution timeout in minutes
            disabled_tools: List of tool names to disable
            texera_api_endpoint: Texera backend API endpoint
            agent_service_endpoint: Agent service endpoint
            username: Texera username for authentication
            password: Texera password for authentication
            workflow_name: Name for the created workflow
            verbosity_level: Logging verbosity (0=quiet, 1=normal, 2=verbose)
        """
        self.model_type = model_type
        self.settings = AgentSettings(
            max_steps=max_steps,
            max_operator_result_token_limit=max_operator_result_token_limit,
            tool_timeout_seconds=tool_timeout_seconds,
            execution_timeout_minutes=execution_timeout_minutes,
            disabled_tools=disabled_tools or [],
        )
        self.texera_api_endpoint = texera_api_endpoint
        self.computing_unit_endpoint = computing_unit_endpoint
        self.agent_service_endpoint = agent_service_endpoint
        self.username = username
        self.password = password
        self.workflow_name = workflow_name
        self.verbosity_level = verbosity_level

        # State
        self._token: Optional[str] = None
        self._workflow_id: Optional[int] = None
        self._computing_unit_id: Optional[int] = None
        self._agent_info: Optional[AgentInfo] = None
        self._logs: list[dict] = []

    @property
    def logs(self) -> list[dict]:
        """Get the reasoning trace logs from the last run."""
        return self._logs

    @property
    def agent_id(self) -> Optional[str]:
        """Get the current agent ID."""
        return self._agent_info.id if self._agent_info else None

    def _log(self, message: str, level: int = 1):
        """Log a message if verbosity level is high enough."""
        if self.verbosity_level >= level:
            print(f"[DataflowAgent] {message}")

    def setup(self) -> "DataflowAgent":
        """
        Setup the agent by logging in and creating necessary resources.

        This method:
        1. Logs into Texera to get an access token
        2. Gets or creates a computing unit
        3. Creates a new workflow
        4. Creates an agent in the agent service

        Returns:
            self for method chaining

        Raises:
            requests.HTTPError: If any API call fails
        """
        self._log("Logging into Texera...")
        self._token = login(
            username=self.username,
            password=self.password,
            api_endpoint=self.texera_api_endpoint,
        )
        self._log("Login successful")

        self._log("Getting computing unit...")
        self._computing_unit_id = get_or_create_computing_unit(
            token=self._token,
            computing_unit_endpoint=self.computing_unit_endpoint,
        )
        self._log(f"Using computing unit: {self._computing_unit_id}")

        self._log("Creating workflow...")
        self._workflow_id = create_workflow(
            token=self._token,
            name=self.workflow_name,
            api_endpoint=self.texera_api_endpoint,
        )
        self._log(f"Created workflow: {self._workflow_id}")

        self._log("Creating agent...")
        self._agent_info = create_agent(
            model_type=self.model_type,
            token=self._token,
            workflow_id=self._workflow_id,
            computing_unit_id=self._computing_unit_id,
            settings=self.settings,
            agent_endpoint=self.agent_service_endpoint,
        )
        self._log(f"Created agent: {self._agent_info.id}")

        return self

    def run(self, prompt: str) -> str:
        """
        Run the agent with a prompt and return the response.

        This is the main method for interacting with the agent, similar to
        smolagents.CodeAgent.run().

        Args:
            prompt: The prompt/question to send to the agent

        Returns:
            The agent's final response text (last response content from react steps)

        Raises:
            RuntimeError: If agent is not set up
            requests.HTTPError: If API call fails
        """
        if not self._agent_info:
            raise RuntimeError("Agent not set up. Call setup() first.")

        self._log(f"Sending message: {prompt[:100]}...", level=2)

        result = send_message(
            agent_id=self._agent_info.id,
            message=prompt,
            agent_endpoint=self.agent_service_endpoint,
        )

        # Fetch reasoning trace
        self._logs = get_react_steps(
            agent_id=self._agent_info.id,
            agent_endpoint=self.agent_service_endpoint,
        )

        self._log(f"Response received. Steps: {len(self._logs)}", level=2)

        if result.error:
            self._log(f"Error: {result.error}", level=0)

        # Return the last response content from react steps
        return self.get_last_response_content()

    def get_last_response_content(self) -> str:
        """
        Extract the last response content from the agent's reasoning trace.

        This method finds the last agent/assistant message in the react steps
        and returns its content as the final answer.

        Returns:
            The content of the last agent response, or empty string if none found
        """
        if not self._logs:
            return ""

        # Iterate through logs in reverse to find the last agent/assistant response
        for step in reversed(self._logs):
            role = step.get("role", "")
            content = step.get("content", "")

            # Look for agent or assistant role with non-empty content
            if role in ("agent", "assistant") and content:
                self._log(f"Last response content: {content[:100]}...", level=2)
                return content

        # Fallback: return empty string if no agent response found
        self._log("No agent response found in logs", level=1)
        return ""

    def clear_history(self):
        """Clear the agent's conversation history."""
        if self._agent_info:
            clear_agent_history(
                agent_id=self._agent_info.id,
                agent_endpoint=self.agent_service_endpoint,
            )
            self._logs = []
            self._log("History cleared")

    def reset(self):
        """Reset the agent (clear history and workflow state)."""
        if self._agent_info:
            reset_agent(
                agent_id=self._agent_info.id,
                agent_endpoint=self.agent_service_endpoint,
            )
            self._logs = []
            self._log("Agent reset")

    def cleanup(self):
        """
        Cleanup resources by deleting the agent and workflow.

        Call this when done with the agent to free up resources.
        """
        if self._agent_info:
            self._log(f"Deleting agent: {self._agent_info.id}")
            try:
                delete_agent(
                    agent_id=self._agent_info.id,
                    agent_endpoint=self.agent_service_endpoint,
                )
            except Exception as e:
                self._log(f"Failed to delete agent: {e}", level=0)
            self._agent_info = None

        if self._workflow_id and self._token:
            self._log(f"Deleting workflow: {self._workflow_id}")
            try:
                delete_workflow(
                    token=self._token,
                    workflow_id=self._workflow_id,
                    api_endpoint=self.texera_api_endpoint,
                )
            except Exception as e:
                self._log(f"Failed to delete workflow: {e}", level=0)
            self._workflow_id = None

        self._token = None
        self._computing_unit_id = None
        self._logs = []
        self._log("Cleanup complete")

    def __enter__(self) -> "DataflowAgent":
        """Context manager entry - setup the agent."""
        return self.setup()

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit - cleanup resources."""
        self.cleanup()
        return False


# ============================================================================
# Benchmark Helper Functions
# ============================================================================


def clean_reasoning_trace(trace: list[dict]) -> list[dict]:
    """
    Clean up reasoning trace for more compact representation.
    Similar to the smolagents clean_reasoning_trace function.

    Args:
        trace: List of ReAct step dictionaries

    Returns:
        Cleaned trace list
    """
    cleaned = []
    for step in trace:
        cleaned_step = {
            "stepId": step.get("stepId"),
            "role": step.get("role"),
            "content": step.get("content", "")[:500],  # Truncate long content
            "toolCalls": step.get("toolCalls"),
            "isEnd": step.get("isEnd"),
        }
        if step.get("toolResults"):
            # Summarize tool results
            cleaned_step["toolResultsSummary"] = [
                {
                    "toolCallId": tr.get("toolCallId"),
                    "success": tr.get("output", {}).get("success")
                    if isinstance(tr.get("output"), dict)
                    else None,
                }
                for tr in step["toolResults"]
            ]
        cleaned.append(cleaned_step)
    return cleaned


def run_benchmark_task(agent: DataflowAgent, task: dict, prompt_template: str) -> dict:
    """
    Run a single benchmark task with the agent.

    Args:
        agent: DataflowAgent instance
        task: Task dictionary with 'task_id', 'question', 'guidelines'
        prompt_template: Prompt template with {question} and {guidelines} placeholders

    Returns:
        Dictionary with task_id, agent_answer, and reasoning_trace
    """
    prompt = prompt_template.format(
        question=task["question"],
        guidelines=task["guidelines"],
    )

    # Clear history before each task for clean state
    agent.clear_history()

    answer = agent.run(prompt)

    return {
        "task_id": str(task["task_id"]),
        "agent_answer": str(answer),
        "reasoning_trace": str(clean_reasoning_trace(agent.logs)),
    }


# ============================================================================
# Main Entry Point
# ============================================================================

if __name__ == "__main__":
    # Example usage
    print("DataflowAgent Example")
    print("=" * 50)

    # Create agent with context manager for automatic cleanup
    with DataflowAgent(
        model_type=AGENT_MODEL_TYPE,
        max_steps=AGENT_MAX_STEPS,
        verbosity_level=2,
    ) as agent:
        # Test with a simple question
        response = agent.run("What operators are available for data processing?")
        print(f"\nResponse: {response}")

        # Show reasoning trace
        print(f"\nReasoning steps: {len(agent.logs)}")
        for step in agent.logs:
            print(
                f"  Step {step.get('stepId')}: {step.get('role')} - {step.get('content', '')[:100]}..."
            )
