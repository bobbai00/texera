#!/usr/bin/env python3
"""
Main entry point for the Texera agent service.
"""

import argparse
import sys
from pathlib import Path

# Add src directory to path
sys.path.insert(0, str(Path(__file__).parent))

from agent.api import start_server
from agent.config import AgentConfig


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

    args = parser.parse_args()

    # Load configuration if specified
    if args.config:
        config = AgentConfig(args.config)
        if not config.is_enabled:
            print("Agent service is disabled in configuration")
            sys.exit(1)

    # Start the server
    start_server(
        host=args.host,
        port=args.port,
        reload=args.reload
    )


if __name__ == "__main__":
    main()