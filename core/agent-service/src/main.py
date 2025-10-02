#!/usr/bin/env python3
"""
Main entry point for the Texera agent service.
"""

import argparse
import logging
import sys
from pathlib import Path

import structlog

# Add src directory to path
sys.path.insert(0, str(Path(__file__).parent))

from agent.api import start_server
from agent.config import AgentConfig


def setup_logging(log_level: str = "DEBUG"):
    """
    Configure structured logging with the specified log level.

    Args:
        log_level: Log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
    """
    # Configure standard logging
    logging.basicConfig(
        format="%(message)s",
        level=getattr(logging, log_level.upper()),
        stream=sys.stdout
    )

    # Configure structlog
    structlog.configure(
        processors=[
            structlog.stdlib.filter_by_level,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.UnicodeDecoder(),
            structlog.dev.ConsoleRenderer()
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def log_config_info(config: AgentConfig):
    """
    Log non-confidential configuration information.

    Args:
        config: Agent configuration
    """
    logger = structlog.get_logger()

    logger.info("=" * 60)
    logger.info("Agent Service Configuration")
    logger.info("=" * 60)
    logger.info(f"Configuration file: {config.config_path}")
    logger.info(f"Agent enabled: {config.is_enabled}")

    # Log default model configuration
    default_model = config.default_model
    logger.info(f"Default model provider: {default_model.get('provider', 'N/A')}")
    logger.info(f"Default model: {default_model.get('model', 'N/A')}")
    logger.info(f"Default temperature: {default_model.get('temperature', 'N/A')}")
    logger.info(f"Default max tokens: {default_model.get('maxTokens', 'N/A')}")

    # Log rate limits
    rate_limits = config.rate_limits
    logger.info(f"Rate limit - Requests/min: {rate_limits.get('requestsPerMinute', 'N/A')}")
    logger.info(f"Rate limit - Tokens/min: {rate_limits.get('tokensPerMinute', 'N/A')}")

    # Log shared editing configuration
    logger.info(f"Shared editing URL: {config.shared_editing_url}")
    shared_editing = config.get("agent.sharedEditing", {})
    logger.info(f"Reconnect interval: {shared_editing.get('reconnectInterval', 'N/A')}ms")
    logger.info(f"Max reconnect attempts: {shared_editing.get('maxReconnectAttempts', 'N/A')}")

    # Log capabilities
    capabilities = config.get("agent.capabilities", {})
    logger.info(f"Capabilities: {', '.join(k for k, v in capabilities.items() if v)}")

    # Log security settings
    security = config.get("agent.security", {})
    logger.info(f"Max workflow size: {security.get('maxWorkflowSize', 'N/A')}")
    logger.info(f"Operation timeout: {security.get('operationTimeout', 'N/A')}s")
    logger.info(f"Audit logging: {security.get('auditLogging', 'N/A')}")

    # Log provider availability (without API keys)
    providers = config.get("agent.providers", {})
    available_providers = []
    for provider, provider_config in providers.items():
        api_key = provider_config.get("apiKey", "")
        if api_key:
            available_providers.append(provider)
    logger.info(f"Available providers: {', '.join(available_providers) if available_providers else 'None'}")

    logger.info("=" * 60)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description="Texera Agent Service")
    parser.add_argument(
        "--host",
        type=str,
        default="0.0.0.0",
        help="Host to bind to (default: 0.0.0.0)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8090,
        help="Port to bind to (default: 8090)"
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload for development"
    )
    parser.add_argument(
        "--config",
        type=str,
        help="Path to configuration file"
    )
    parser.add_argument(
        "--log-level",
        type=str,
        default="DEBUG",
        choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        help="Log level (default: DEBUG)"
    )

    args = parser.parse_args()

    # Setup logging
    setup_logging(args.log_level)
    logger = structlog.get_logger()

    # Load configuration
    try:
        config = AgentConfig(args.config) if args.config else AgentConfig()

        # Log configuration information
        log_config_info(config)

        if not config.is_enabled:
            logger.warning("Agent service is disabled in configuration")
            sys.exit(1)

    except FileNotFoundError as e:
        logger.error(f"Configuration error: {e}")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Failed to load configuration: {e}")
        sys.exit(1)

    # Start the server
    logger.info(f"Starting agent service on {args.host}:{args.port}")
    start_server(
        host=args.host,
        port=args.port,
        reload=args.reload
    )


if __name__ == "__main__":
    main()