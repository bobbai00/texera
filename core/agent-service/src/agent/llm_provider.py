"""
LLM provider using instructor for structured tool calls.
"""

import os
from typing import Any, Dict, List, Optional, Union, Type
from pydantic import BaseModel
import instructor
from openai import OpenAI
from anthropic import Anthropic
import structlog

from .config import AgentConfig
from .models import ModelConfig

logger = structlog.get_logger()


class LLMProvider:
    """Provider for LLM interactions using instructor."""

    def __init__(self, config: AgentConfig):
        """
        Initialize LLM provider.

        Args:
            config: Agent configuration
        """
        self.config = config
        self.clients = {}
        self._setup_clients()

    def _setup_clients(self):
        """Setup instructor clients for different providers."""
        # Setup OpenAI client
        openai_key = self.config.openai_api_key or os.environ.get("OPENAI_API_KEY", "")
        if openai_key:
            try:
                openai_client = OpenAI(api_key=openai_key)
                self.clients["openai"] = instructor.from_openai(openai_client)
                logger.info("OpenAI client configured")
            except Exception as e:
                logger.error(f"Failed to setup OpenAI client: {e}")

        # Setup Anthropic client
        anthropic_key = self.config.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        if anthropic_key:
            try:
                anthropic_client = Anthropic(api_key=anthropic_key)
                self.clients["anthropic"] = instructor.from_anthropic(anthropic_client)
                logger.info("Anthropic client configured")
            except Exception as e:
                logger.error(f"Failed to setup Anthropic client: {e}")

    def _get_client(self, provider: str):
        """Get instructor client for the specified provider."""
        if provider not in self.clients:
            raise ValueError(
                f"Provider {provider} not configured. Available: {list(self.clients.keys())}"
            )
        return self.clients[provider]

    async def get_completion(
        self,
        messages: List[Dict[str, str]],
        model_config: Optional[ModelConfig] = None,
        response_model: Optional[Type[BaseModel]] = None,
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

        client = self._get_client(model_config.provider)

        # Handle different message formats for different providers
        if model_config.provider == "anthropic":
            # Extract system message for Anthropic
            system_message = next((m["content"] for m in messages if m["role"] == "system"), "")
            user_messages = [m for m in messages if m["role"] != "system"]

            if response_model:
                # Structured response with instructor
                return client.messages.create(
                    model=model_config.model,
                    system=system_message,
                    messages=user_messages,
                    temperature=model_config.temperature,
                    max_tokens=model_config.max_tokens,
                    response_model=response_model,
                )
            else:
                # Text response - use the underlying client directly for non-structured responses
                anthropic_client = Anthropic(
                    api_key=self.config.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY", "")
                )
                response = anthropic_client.messages.create(
                    model=model_config.model,
                    system=system_message,
                    messages=user_messages,
                    temperature=model_config.temperature,
                    max_tokens=model_config.max_tokens,
                )
                return response.content[0].text
        else:
            # OpenAI and other providers
            if response_model:
                # Structured response with instructor
                return client.chat.completions.create(
                    model=model_config.model,
                    messages=messages,
                    temperature=model_config.temperature,
                    max_tokens=model_config.max_tokens,
                    response_model=response_model,
                )
            else:
                # Text response - use the underlying client directly for non-structured responses
                openai_client = OpenAI(
                    api_key=self.config.openai_api_key or os.environ.get("OPENAI_API_KEY", "")
                )
                response = openai_client.chat.completions.create(
                    model=model_config.model,
                    messages=messages,
                    temperature=model_config.temperature,
                    max_tokens=model_config.max_tokens,
                )
                return response.choices[0].message.content

    async def get_tool_completion(
        self,
        messages: List[Dict[str, str]],
        tools: List[Type[BaseModel]],
        model_config: Optional[ModelConfig] = None,
    ) -> Optional[BaseModel]:
        """
        Get tool-based completion from LLM using instructor.

        Args:
            messages: Conversation messages
            tools: List of tool models (Pydantic classes)
            model_config: Model configuration

        Returns:
            Instance of one of the tool models or None
        """
        if model_config is None:
            model_config = ModelConfig(**self.config.default_model)

        client = self._get_client(model_config.provider)

        # Create a union type of all tools for instructor
        from typing import Union as UnionType

        # Dynamically create a Union type of all tool classes
        if len(tools) == 1:
            response_model = tools[0]
        else:
            # Create Union type for multiple tools
            response_model = UnionType[tuple(tools)]

        # Get structured response using instructor
        if model_config.provider == "anthropic":
            system_message = next((m["content"] for m in messages if m["role"] == "system"), "")
            user_messages = [m for m in messages if m["role"] != "system"]

            tool_response = client.messages.create(
                model=model_config.model,
                system=system_message,
                messages=user_messages,
                temperature=model_config.temperature,
                max_tokens=model_config.max_tokens,
                response_model=response_model,
            )
        else:
            tool_response = client.chat.completions.create(
                model=model_config.model,
                messages=messages,
                temperature=model_config.temperature,
                max_tokens=model_config.max_tokens,
                response_model=response_model,
            )

        logger.info(f"Got tool response: {type(tool_response).__name__}")
        return tool_response

    def get_available_models(self) -> List[Dict[str, str]]:
        """Get list of available models based on configured API keys."""
        models = []

        if "openai" in self.clients:
            models.extend(
                [
                    {"id": "gpt-4-turbo-preview", "name": "GPT-4 Turbo", "provider": "openai"},
                    {"id": "gpt-4", "name": "GPT-4", "provider": "openai"},
                    {"id": "gpt-3.5-turbo", "name": "GPT-3.5 Turbo", "provider": "openai"},
                ]
            )

        if "anthropic" in self.clients:
            models.extend(
                [
                    {
                        "id": "claude-3-5-sonnet-latest",
                        "name": "Claude 3.5 Sonnet",
                        "provider": "anthropic",
                    },
                    {
                        "id": "claude-3-5-haiku-latest",
                        "name": "Claude 3.5 Haiku",
                        "provider": "anthropic",
                    },
                    {
                        "id": "claude-3-opus-20240229",
                        "name": "Claude 3 Opus",
                        "provider": "anthropic",
                    },
                ]
            )

        return models
