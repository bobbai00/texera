"""
Configuration management for the agent service.
"""

import os
from pathlib import Path
from typing import Dict, Any, Optional
from pyhocon import ConfigFactory
import structlog

logger = structlog.get_logger()


class AgentConfig:
    """Manages agent service configuration from HOCON file and environment variables."""

    def __init__(self, config_path: Optional[str] = None):
        """
        Initialize configuration.

        Args:
            config_path: Path to the configuration file. If None, uses default path.
        """
        if config_path is None:
            # Default to config/src/main/resources/agent-service.conf
            base_dir = Path(__file__).parent.parent.parent.parent
            config_path = base_dir / "config" / "src" / "main" / "resources" / "agent-service.conf"

        self.config_path = Path(config_path)
        self.config = self._load_config()

    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from HOCON file with environment variable substitution."""
        if not self.config_path.exists():
            raise FileNotFoundError(f"Config file not found: {self.config_path}")

        # Load the HOCON file - pyhocon automatically resolves ${?VAR} environment variables
        config = ConfigFactory.parse_file(str(self.config_path))
        return config.as_plain_ordered_dict()

    def get(self, path: str, default: Any = None) -> Any:
        """
        Get configuration value by path.

        Args:
            path: Dot-separated path to the configuration value
            default: Default value if path not found

        Returns:
            Configuration value or default
        """
        parts = path.split(".")
        value = self.config

        for part in parts:
            if isinstance(value, dict) and part in value:
                value = value[part]
            else:
                return default

        return value

    @property
    def is_enabled(self) -> bool:
        """Check if agent service is enabled."""
        return self.get("agent.enabled", True)

    @property
    def openai_api_key(self) -> str:
        """Get OpenAI API key."""
        return self.get("agent.providers.openai.apiKey", "")

    @property
    def anthropic_api_key(self) -> str:
        """Get Anthropic API key."""
        return self.get("agent.providers.anthropic.apiKey", "")

    @property
    def default_model(self) -> Dict[str, Any]:
        """Get default model configuration."""
        return self.get("agent.defaultModel", {})

    @property
    def shared_editing_url(self) -> str:
        """Get shared editing WebSocket URL."""
        return self.get("agent.sharedEditing.url", "ws://localhost:1234")

    @property
    def rate_limits(self) -> Dict[str, int]:
        """Get rate limit configuration."""
        return self.get("agent.rateLimit", {})