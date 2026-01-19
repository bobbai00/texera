# -*- coding: utf-8 -*-
"""
Code Agent - Baseline agent using smolagents library for DABstep benchmarking.

This module provides a CodeAgentWrapper class that uses the smolagents CodeAgent
to run DABstep benchmark tasks. It connects to a local LiteLLM server for model inference.
"""

import time
from typing import Optional, Any
from dataclasses import dataclass, field

from smolagents import CodeAgent
from smolagents.agents import ActionStep
from smolagents.models import OpenAIServerModel

# ============================================================================
# Configuration Constants
# ============================================================================

# OpenAI-compatible API Configuration (LiteLLM proxy)
OPENAI_API_BASE = "http://localhost:9096/api"
OPENAI_API_KEY = "dummy"  # LiteLLM proxy typically uses a dummy key

# Agent Settings
CODE_AGENT_MODEL_TYPE = "claude-haiku-4.5"
CODE_AGENT_MAX_STEPS = 50

# Authorized imports for the code agent
AUTHORIZED_IMPORTS = [
    "numpy",
    "pandas",
    "json",
    "csv",
    "os",
    "glob",
    "markdown",
    "re",
    "datetime",
    "collections",
    "math",
    "statistics",
]


# ============================================================================
# Data Classes
# ============================================================================


@dataclass
class CodeAgentSettings:
    """Settings for the code agent."""

    max_steps: int = CODE_AGENT_MAX_STEPS
    verbosity_level: int = 1
    authorized_imports: list[str] = field(default_factory=lambda: AUTHORIZED_IMPORTS.copy())

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary format."""
        return {
            "max_steps": self.max_steps,
            "verbosity_level": self.verbosity_level,
            "authorized_imports": self.authorized_imports,
        }


@dataclass
class CodeAgentResult:
    """Result from running the code agent."""

    response: str
    reasoning_trace: list[dict]
    elapsed_seconds: float
    error: Optional[str] = None


# ============================================================================
# Utility Functions
# ============================================================================


def clean_reasoning_trace(trace: list) -> list[dict]:
    """
    Clean the reasoning trace to make it more compact.
    Removes memory objects to reduce size.

    Args:
        trace: List of ActionStep objects from the agent

    Returns:
        List of dictionaries with cleaned trace information
    """
    cleaned = []
    for step in trace:
        step_dict = {}

        if hasattr(step, "step_number"):
            step_dict["step"] = step.step_number

        if isinstance(step, ActionStep):
            # Remove memory from logs to make them more compact
            if hasattr(step, "memory"):
                step.memory = None
            if hasattr(step, "agent_memory"):
                step.agent_memory = None

            if hasattr(step, "tool_calls") and step.tool_calls:
                step_dict["tool_calls"] = str(step.tool_calls)
            if hasattr(step, "observations") and step.observations:
                step_dict["observations"] = str(step.observations)[:500]  # Truncate
            if hasattr(step, "error") and step.error:
                step_dict["error"] = str(step.error)

        if hasattr(step, "llm_output") and step.llm_output:
            step_dict["llm_output"] = str(step.llm_output)[:1000]  # Truncate

        if step_dict:
            cleaned.append(step_dict)

    return cleaned


def get_model_id(model_type: str) -> str:
    """
    Convert a model type to the model ID expected by the LiteLLM proxy.

    Args:
        model_type: Model type like "claude-haiku-4.5" or "claude-sonnet-4-5"

    Returns:
        Model ID as expected by the proxy
    """
    # The LiteLLM proxy uses these exact model names
    # Map common variations to the correct names
    model_mapping = {
        "claude-haiku-4.5": "claude-haiku-4.5",
        "claude-haiku-4-5": "claude-haiku-4.5",
        "claude-sonnet-4.5": "claude-sonnet-4-5",
        "claude-sonnet-4-5": "claude-sonnet-4-5",
        "gpt-5-mini": "gpt-5-mini",
        "gpt-4o-mini": "gpt-5-mini",
        "llama-local": "llama-local",
    }
    return model_mapping.get(model_type, model_type)


# ============================================================================
# CodeAgentWrapper Class
# ============================================================================


class CodeAgentWrapper:
    """
    A wrapper class for the smolagents CodeAgent.

    This class provides a similar interface to DataflowAgent for benchmarking
    purposes, allowing comparison between code-based and dataflow-based agents.

    Example usage:
        agent = CodeAgentWrapper(
            model_type="claude-haiku-4.5",
            max_steps=50,
        )
        agent.setup()

        result = agent.run("What is the total revenue?")
        print(result.response)

        # Inspect reasoning trace
        for step in result.reasoning_trace:
            print(step)

        agent.cleanup()
    """

    def __init__(
        self,
        model_type: str = CODE_AGENT_MODEL_TYPE,
        max_steps: int = CODE_AGENT_MAX_STEPS,
        verbosity_level: int = 1,
        authorized_imports: Optional[list[str]] = None,
        api_base: str = OPENAI_API_BASE,
        api_key: str = OPENAI_API_KEY,
        agent_name: Optional[str] = None,
    ):
        """
        Initialize the CodeAgentWrapper.

        Args:
            model_type: LLM model type to use
            max_steps: Maximum number of steps per run
            verbosity_level: Logging verbosity (0=quiet, 1=normal, 2=verbose)
            authorized_imports: List of Python imports the agent can use
            api_base: OpenAI-compatible API base URL
            api_key: API key
            agent_name: Custom name for the agent (optional)
        """
        self.model_type = model_type
        self.settings = CodeAgentSettings(
            max_steps=max_steps,
            verbosity_level=verbosity_level,
            authorized_imports=authorized_imports or AUTHORIZED_IMPORTS.copy(),
        )
        self.api_base = api_base
        self.api_key = api_key
        self.agent_name = agent_name
        self.verbosity_level = verbosity_level

        # State
        self._agent: Optional[CodeAgent] = None
        self._model: Optional[OpenAIServerModel] = None
        self._last_result: Optional[CodeAgentResult] = None

    @property
    def agent_id(self) -> Optional[str]:
        """Get the agent identifier."""
        return self.agent_name or f"code-agent-{self.model_type}"

    @property
    def last_result(self) -> Optional[CodeAgentResult]:
        """Get the last run result."""
        return self._last_result

    def _log(self, message: str, level: int = 1):
        """Log a message if verbosity level is high enough."""
        if self.verbosity_level >= level:
            print(f"[CodeAgent] {message}")

    def setup(self) -> "CodeAgentWrapper":
        """
        Setup the code agent.

        This method:
        1. Creates the OpenAI-compatible model connection
        2. Creates the CodeAgent with configured settings

        Returns:
            self for method chaining
        """
        self._log("Setting up code agent...")

        # Create the OpenAI-compatible model
        model_id = get_model_id(self.model_type)
        self._log(f"Creating OpenAI model: {model_id} at {self.api_base}")

        self._model = OpenAIServerModel(
            model_id=model_id,
            api_base=self.api_base,
            api_key=self.api_key,
        )

        # Create the CodeAgent
        self._log(f"Creating CodeAgent with max_steps={self.settings.max_steps}")
        self._agent = CodeAgent(
            tools=[],  # No external tools, just code execution
            model=self._model,
            additional_authorized_imports=self.settings.authorized_imports,
            max_steps=self.settings.max_steps,
            verbosity_level=self.settings.verbosity_level,
        )

        # Give agent power to open files (like in quickstart.py)
        # Note: We must use additional_functions, not static_tools, because
        # static_tools gets overwritten when CodeAgent.run() calls send_tools()
        self._agent.python_executor.additional_functions["open"] = open

        self._log("Code agent setup complete")
        return self

    def run(self, prompt: str) -> CodeAgentResult:
        """
        Run the agent with a prompt and return the result.

        Args:
            prompt: The prompt/question to send to the agent

        Returns:
            CodeAgentResult containing response, reasoning trace, and timing

        Raises:
            RuntimeError: If agent is not set up
        """
        if not self._agent:
            raise RuntimeError("Agent not set up. Call setup() first.")

        self._log(f"Running agent with prompt: {prompt[:100]}...", level=2)

        start_time = time.time()
        error = None
        response = ""

        try:
            response = self._agent.run(prompt)
            response = str(response) if response is not None else ""
        except Exception as e:
            error = str(e)
            self._log(f"Agent error: {e}", level=0)

        elapsed = time.time() - start_time

        # Get reasoning trace
        reasoning_trace = []
        if hasattr(self._agent, "logs") and self._agent.logs:
            reasoning_trace = clean_reasoning_trace(self._agent.logs)

        result = CodeAgentResult(
            response=response,
            reasoning_trace=reasoning_trace,
            elapsed_seconds=elapsed,
            error=error,
        )

        self._last_result = result
        self._log(f"Agent completed in {elapsed:.1f}s", level=1)

        return result

    def reset(self):
        """Reset the agent state (recreate the agent)."""
        if self._agent:
            self._log("Resetting agent...")
            # Recreate the agent to clear state
            self._agent = CodeAgent(
                tools=[],
                model=self._model,
                additional_authorized_imports=self.settings.authorized_imports,
                max_steps=self.settings.max_steps,
                verbosity_level=self.settings.verbosity_level,
            )
            self._agent.python_executor.additional_functions["open"] = open
            self._last_result = None
            self._log("Agent reset complete")

    def cleanup(self):
        """
        Cleanup resources.

        For the code agent, this just clears internal state.
        """
        self._log("Cleaning up code agent...")
        self._agent = None
        self._model = None
        self._last_result = None
        self._log("Cleanup complete")

    def __enter__(self) -> "CodeAgentWrapper":
        """Context manager entry - setup the agent."""
        return self.setup()

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit - cleanup resources."""
        self.cleanup()
        return False


# ============================================================================
# Main Entry Point
# ============================================================================

if __name__ == "__main__":
    # Example usage
    print("CodeAgentWrapper Example")
    print("=" * 50)

    # Create agent with context manager for automatic cleanup
    with CodeAgentWrapper(
        model_type=CODE_AGENT_MODEL_TYPE,
        max_steps=10,
        verbosity_level=2,
    ) as agent:
        # Test with a simple question
        result = agent.run("Calculate 2 + 2 and print the result")
        print(f"\nResponse: {result.response}")
        print(f"Elapsed: {result.elapsed_seconds:.1f}s")
        print(f"Steps: {len(result.reasoning_trace)}")
        if result.error:
            print(f"Error: {result.error}")
