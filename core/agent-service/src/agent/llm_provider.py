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
        openai_key = self.config.openai_api_key or os.environ.get("OPENAI_API_KEY", "")
        if openai_key:
            logger.info("Setting up OpenAI client")
            openai_client = OpenAI(api_key=openai_key)
            self.openai_client = instructor.from_openai(openai_client)
        else:
            self.openai_client = None
            logger.info("OpenAI client not configured (no API key)")

        # Setup Anthropic client with instructor
        anthropic_key = self.config.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        if anthropic_key:
            logger.info("Setting up Anthropic client")
            anthropic_client = Anthropic(api_key=anthropic_key)
            self.anthropic_client = instructor.from_anthropic(anthropic_client)
        else:
            self.anthropic_client = None
            logger.info("Anthropic client not configured (no API key)")

    def _configure_litellm(self):
        """Configure litellm with API keys."""
        # Check config first, then environment
        openai_key = self.config.openai_api_key or os.environ.get("OPENAI_API_KEY", "")
        if openai_key:
            os.environ["OPENAI_API_KEY"] = openai_key
            logger.info("OpenAI API key configured for litellm")

        anthropic_key = self.config.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        if anthropic_key:
            os.environ["ANTHROPIC_API_KEY"] = anthropic_key
            logger.info("Anthropic API key configured for litellm")

        # Set litellm to not print verbose logs
        litellm.set_verbose = False

        # Log the default model configuration
        default_model = self.config.default_model
        logger.info(
            f"Default model configuration: provider={default_model.get('provider')}, model={default_model.get('model')}"
        )

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=4, max=10))
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
            default_dict = self.config.default_model
            logger.info(f"Using default model config: {default_dict}")
            model_config = ModelConfig(**default_dict)

        logger.info(f"Model config: provider={model_config.provider}, model={model_config.model}")

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
        response_model: Type[BaseModel],
    ) -> BaseModel:
        """Get structured completion from OpenAI using instructor."""
        try:
            response = self.openai_client.chat.completions.create(
                model=model_config.model,
                messages=messages,
                temperature=model_config.temperature,
                max_tokens=model_config.max_tokens,
                response_model=response_model,
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
        response_model: Type[BaseModel],
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
                response_model=response_model,
            )
            logger.info(f"Got structured response from Anthropic: {type(response).__name__}")
            return response
        except Exception as e:
            logger.error(f"Error getting structured completion from Anthropic: {e}")
            raise

    async def _get_standard_completion(
        self, messages: List[Dict[str, str]], model_config: ModelConfig
    ) -> str:
        """Get standard text completion using litellm."""
        try:
            # Build full model string for litellm
            if model_config.provider == "anthropic":
                # For Anthropic models in litellm, we ALWAYS need anthropic/ prefix
                # Even for claude-3 models, litellm requires the prefix
                model_string = f"anthropic/{model_config.model}"

                # Ensure Anthropic API key is set - check both config and environment
                anthropic_key = self.config.anthropic_api_key or os.environ.get(
                    "ANTHROPIC_API_KEY", ""
                )
                if not anthropic_key:
                    raise ValueError("Anthropic API key not configured")

                # Log for debugging
                logger.info(f"Using Anthropic model: {model_string}")

            elif model_config.provider == "openai":
                model_string = model_config.model
                # Ensure OpenAI API key is set - check both config and environment
                openai_key = self.config.openai_api_key or os.environ.get("OPENAI_API_KEY", "")
                if not openai_key:
                    raise ValueError("OpenAI API key not configured")

                # Log for debugging
                logger.info(f"Using OpenAI model: {model_string}")

            else:
                # For other providers, use provider/model format
                model_string = f"{model_config.provider}/{model_config.model}"
                logger.info(f"Using {model_config.provider} model: {model_string}")

            # Log the actual call for debugging
            logger.debug(
                f"Calling litellm with model={model_string}, provider={model_config.provider}"
            )

            response = await litellm.acompletion(
                model=model_string,
                messages=messages,
                temperature=model_config.temperature,
                max_tokens=model_config.max_tokens,
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
        model_config: Optional[ModelConfig] = None,
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

        try:
            # Build tool descriptions for the prompt
            tool_descriptions = []
            for tool in tools:
                tool_name = tool.__name__
                tool_doc = tool.__doc__ or f"Use {tool_name}"
                fields = []
                for field_name, field_info in tool.model_fields.items():
                    field_desc = field_info.description or field_name
                    field_type = str(field_info.annotation).replace("typing.", "")
                    fields.append(f"  - {field_name} ({field_type}): {field_desc}")

                tool_descriptions.append(
                    f"{tool_name}: {tool_doc}\n" + "Parameters:\n" + "\n".join(fields)
                    if fields
                    else ""
                )

            # Add tool instructions to system message
            tool_prompt = (
                "You are an AI assistant that helps users build workflows. "
                "When the user asks you to modify the workflow, respond with the appropriate tool call.\n\n"
                "Available tools:\n" + "\n\n".join(tool_descriptions) + "\n\n"
                "Respond with a JSON object containing:\n"
                "- tool: the name of the tool to use\n"
                "- parameters: the parameters for the tool\n\n"
                "Example response:\n"
                '{"tool": "AddOperatorTool", "parameters": {"operator_type": "Filter", "operator_id": "filter_1", "display_name": "Data Filter"}}'
            )

            # Modify messages to include tool instructions
            modified_messages = []
            system_added = False
            for msg in messages:
                if msg["role"] == "system" and not system_added:
                    modified_messages.append(
                        {"role": "system", "content": tool_prompt + "\n\n" + msg["content"]}
                    )
                    system_added = True
                else:
                    modified_messages.append(msg)

            if not system_added:
                modified_messages.insert(0, {"role": "system", "content": tool_prompt})

            # Get text response
            response = await self._get_standard_completion(modified_messages, model_config)

            # Try to parse the response as JSON
            import json
            import re

            # Extract JSON from response (it might be wrapped in markdown or other text)
            json_match = re.search(r"\{.*\}", response, re.DOTALL)
            if not json_match:
                logger.info("No JSON found in tool response")
                return None

            try:
                response_data = json.loads(json_match.group())
                tool_name = response_data.get("tool")
                parameters = response_data.get("parameters", {})

                # Find the matching tool class
                for tool_class in tools:
                    if tool_class.__name__ == tool_name:
                        # Create an instance of the tool with the parameters
                        tool_instance = tool_class(**parameters)
                        logger.info(f"Created tool instance: {tool_name}")
                        return tool_instance

                logger.warning(f"Tool {tool_name} not found in available tools")
                return None

            except (json.JSONDecodeError, ValueError) as e:
                logger.error(f"Failed to parse tool response as JSON: {e}")
                logger.debug(f"Response was: {response}")
                return None

        except Exception as e:
            logger.error(f"Error getting tool completion: {e}")
            return None

    def get_available_models(self) -> List[Dict[str, str]]:
        """Get list of available models."""
        models = []

        # Add OpenAI models if configured
        if self.config.openai_api_key:
            models.extend(
                [
                    {"id": "gpt-4-turbo-preview", "name": "GPT-4 Turbo", "provider": "openai"},
                    {"id": "gpt-4", "name": "GPT-4", "provider": "openai"},
                    {"id": "gpt-3.5-turbo", "name": "GPT-3.5 Turbo", "provider": "openai"},
                ]
            )

        # Add Anthropic models if configured
        if self.config.anthropic_api_key:
            models.extend(
                [
                    {
                        "id": "claude-3-opus-20240229",
                        "name": "Claude 3 Opus",
                        "provider": "anthropic",
                    },
                    {
                        "id": "claude-3-sonnet-20240229",
                        "name": "Claude 3 Sonnet",
                        "provider": "anthropic",
                    },
                    {
                        "id": "claude-3-haiku-20240307",
                        "name": "Claude 3 Haiku",
                        "provider": "anthropic",
                    },
                ]
            )

        return models
