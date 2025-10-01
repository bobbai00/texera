"""
LLM provider with instructor for structured tool calls.
"""

import os
from typing import Any, Dict, List, Optional, Union, Type
from pydantic import BaseModel
import litellm
import instructor
from openai import OpenAI
from anthropic import Anthropic
import structlog
from tenacity import retry, stop_after_attempt, wait_exponential

from .config import AgentConfig
from .models import ModelConfig

logger = structlog.get_logger()


class LLMProvider:
    """Provider for LLM interactions using litellm and instructor."""

    def __init__(self, config: AgentConfig):
        """
        Initialize LLM provider.

        Args:
            config: Agent configuration
        """
        self.config = config
        self._setup_clients()
        self._configure_litellm()

    def _setup_clients(self):
        """Setup LLM clients with instructor patches."""
        # Setup OpenAI client with instructor
        if self.config.openai_api_key:
            openai_client = OpenAI(api_key=self.config.openai_api_key)
            self.openai_client = instructor.from_openai(openai_client)
        else:
            self.openai_client = None

        # Setup Anthropic client with instructor
        if self.config.anthropic_api_key:
            anthropic_client = Anthropic(api_key=self.config.anthropic_api_key)
            self.anthropic_client = instructor.from_anthropic(anthropic_client)
        else:
            self.anthropic_client = None

    def _configure_litellm(self):
        """Configure litellm with API keys."""
        if self.config.openai_api_key:
            os.environ["OPENAI_API_KEY"] = self.config.openai_api_key
        if self.config.anthropic_api_key:
            os.environ["ANTHROPIC_API_KEY"] = self.config.anthropic_api_key

        # Set litellm to not print verbose logs
        litellm.set_verbose = False

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10)
    )
    async def get_completion(
        self,
        messages: List[Dict[str, str]],
        model_config: Optional[ModelConfig] = None,
        response_model: Optional[Type[BaseModel]] = None
    ) -> Union[str, BaseModel]:
        """
        Get completion from LLM with optional structured output.

        Args:
            messages: Conversation messages
            model_config: Model configuration (uses default if None)
            response_model: Optional Pydantic model for structured output

        Returns:
            String response or structured model instance
        """
        if model_config is None:
            model_config = ModelConfig(**self.config.default_model)

        # Determine which client to use based on provider
        if response_model and model_config.provider == "openai" and self.openai_client:
            # Use instructor for structured output with OpenAI
            return await self._get_structured_completion_openai(
                messages, model_config, response_model
            )
        elif response_model and model_config.provider == "anthropic" and self.anthropic_client:
            # Use instructor for structured output with Anthropic
            return await self._get_structured_completion_anthropic(
                messages, model_config, response_model
            )
        else:
            # Fall back to litellm for standard completions
            return await self._get_standard_completion(messages, model_config)

    async def _get_structured_completion_openai(
        self,
        messages: List[Dict[str, str]],
        model_config: ModelConfig,
        response_model: Type[BaseModel]
    ) -> BaseModel:
        """Get structured completion from OpenAI using instructor."""
        try:
            response = self.openai_client.chat.completions.create(
                model=model_config.model,
                messages=messages,
                temperature=model_config.temperature,
                max_tokens=model_config.max_tokens,
                response_model=response_model
            )
            logger.info(f"Got structured response from OpenAI: {type(response).__name__}")
            return response
        except Exception as e:
            logger.error(f"Error getting structured completion from OpenAI: {e}")
            raise

    async def _get_structured_completion_anthropic(
        self,
        messages: List[Dict[str, str]],
        model_config: ModelConfig,
        response_model: Type[BaseModel]
    ) -> BaseModel:
        """Get structured completion from Anthropic using instructor."""
        try:
            # Convert messages to Anthropic format
            system_message = next((m["content"] for m in messages if m["role"] == "system"), "")
            user_messages = [m for m in messages if m["role"] != "system"]

            response = self.anthropic_client.messages.create(
                model=model_config.model,
                system=system_message,
                messages=user_messages,
                temperature=model_config.temperature,
                max_tokens=model_config.max_tokens,
                response_model=response_model
            )
            logger.info(f"Got structured response from Anthropic: {type(response).__name__}")
            return response
        except Exception as e:
            logger.error(f"Error getting structured completion from Anthropic: {e}")
            raise

    async def _get_standard_completion(
        self,
        messages: List[Dict[str, str]],
        model_config: ModelConfig
    ) -> str:
        """Get standard text completion using litellm."""
        try:
            # Build full model string for litellm
            if model_config.provider != "openai":
                model_string = f"{model_config.provider}/{model_config.model}"
            else:
                model_string = model_config.model

            response = await litellm.acompletion(
                model=model_string,
                messages=messages,
                temperature=model_config.temperature,
                max_tokens=model_config.max_tokens
            )

            content = response.choices[0].message.content
            logger.info(f"Got text response from {model_config.provider}")
            return content
        except Exception as e:
            logger.error(f"Error getting completion from litellm: {e}")
            raise

    async def get_tool_completion(
        self,
        messages: List[Dict[str, str]],
        tools: List[Type[BaseModel]],
        model_config: Optional[ModelConfig] = None
    ) -> Optional[BaseModel]:
        """
        Get tool-based completion from LLM.

        Args:
            messages: Conversation messages
            tools: List of tool models (Pydantic classes)
            model_config: Model configuration

        Returns:
            Instance of one of the tool models or None
        """
        if model_config is None:
            model_config = ModelConfig(**self.config.default_model)

        # Create a union type of all tools for instructor
        if len(tools) == 1:
            response_model = tools[0]
        else:
            from typing import Union as UnionType
            response_model = UnionType[tuple(tools)]

        try:
            # Add instructions about tool usage to the system message
            tool_instructions = (
                "\n\nYou have access to the following tools:\n" +
                "\n".join([f"- {tool.__name__}: {tool.__doc__}" for tool in tools]) +
                "\n\nUse the appropriate tool to accomplish the user's request."
            )

            # Append tool instructions to system message
            modified_messages = messages.copy()
            for msg in modified_messages:
                if msg["role"] == "system":
                    msg["content"] += tool_instructions
                    break
            else:
                # No system message found, add one
                modified_messages.insert(0, {
                    "role": "system",
                    "content": tool_instructions
                })

            # Get structured response
            response = await self.get_completion(
                messages=modified_messages,
                model_config=model_config,
                response_model=response_model
            )

            logger.info(f"Got tool response: {type(response).__name__}")
            return response

        except Exception as e:
            logger.error(f"Error getting tool completion: {e}")
            return None

    def get_available_models(self) -> List[Dict[str, str]]:
        """Get list of available models."""
        models = []

        # Add OpenAI models if configured
        if self.config.openai_api_key:
            models.extend([
                {"id": "gpt-4-turbo-preview", "name": "GPT-4 Turbo", "provider": "openai"},
                {"id": "gpt-4", "name": "GPT-4", "provider": "openai"},
                {"id": "gpt-3.5-turbo", "name": "GPT-3.5 Turbo", "provider": "openai"}
            ])

        # Add Anthropic models if configured
        if self.config.anthropic_api_key:
            models.extend([
                {"id": "claude-3-opus-20240229", "name": "Claude 3 Opus", "provider": "anthropic"},
                {"id": "claude-3-sonnet-20240229", "name": "Claude 3 Sonnet", "provider": "anthropic"},
                {"id": "claude-3-haiku-20240307", "name": "Claude 3 Haiku", "provider": "anthropic"}
            ])

        return models