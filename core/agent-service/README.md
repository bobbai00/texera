# Texera Agent Service

Python-based LLM agent service for collaborative workflow editing in Texera.

## Features

- **Multi-model Support**: Works with OpenAI, Anthropic, and other LLMs via litellm
- **Structured Tool Calls**: Uses instructor library for reliable tool execution
- **Real-time Collaboration**: Connects to shared editing via WebSocket
- **Type-safe**: Full Pydantic models for all data structures
- **Configurable**: HOCON configuration with environment variable support
- **Modern Python**: Managed with uv for fast, reliable dependency management

## Installation

```bash
# Install uv (if not already installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Navigate to agent service
cd agent-service

# Create virtual environment with uv
uv venv

# Activate virtual environment
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install the package in editable mode
uv pip install -e .

# Or install with development dependencies
uv pip install -e ".[dev]"
```

## Configuration

The service reads configuration from `config/src/main/resources/agent-service.conf`.

Key environment variables:
- `OPENAI_API_KEY`: OpenAI API key
- `ANTHROPIC_API_KEY`: Anthropic API key
- `AGENT_DEFAULT_MODEL`: Default model to use (e.g., "gpt-4-turbo-preview")
- `SHARED_EDITING_URL`: WebSocket URL for shared editing (default: ws://localhost:1234)

## Running the Service

### Development Mode
```bash
# With auto-reload
python src/main.py --reload

# Custom port
python src/main.py --port 8090
```

### Production Mode
```bash
# Using uvicorn directly
uvicorn agent.api:app --host 0.0.0.0 --port 8090

# Or with gunicorn
gunicorn agent.api:app -w 4 -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8090
```

## API Endpoints

- `POST /api/agent/invite` - Invite agent to workflow
- `POST /api/agent/remove` - Remove agent from workflow
- `GET /api/agent/status/{workflow_id}` - Get agent status
- `GET /api/agent/models` - Get available models
- `GET /health` - Health check

## Available Tools

The agent can execute the following workflow manipulation tools:

- **AddOperatorTool** - Add new operators to workflow
- **DeleteOperatorTool** - Remove operators
- **SetOperatorPropertyTool** - Modify operator properties
- **AddLinkTool** - Create links between operators
- **DeleteLinkTool** - Remove links
- **RunWorkflowTool** - Execute workflow
- **PauseWorkflowTool** - Pause execution
- **ViewOperatorResultsTool** - View operator results
- **GetWorkflowGraphTool** - Get workflow structure
- **GetOperatorInfoTool** - Get operator details
- **GetExecutionStatusTool** - Get execution status

## Architecture

```
agent-service/
├── src/
│   ├── agent/
│   │   ├── __init__.py         # Package initialization
│   │   ├── config.py           # Configuration management
│   │   ├── models.py           # Pydantic models
│   │   ├── llm_provider.py     # LLM integration with instructor
│   │   ├── workflow_tools.py   # Tool definitions and execution
│   │   ├── agent_service.py    # Core service logic
│   │   └── api.py              # FastAPI REST endpoints
│   └── main.py                 # Entry point
├── pyproject.toml              # Project configuration and dependencies
└── README.md                   # This file
```

## Testing

```bash
# Run tests with uv
uv run pytest tests/

# With coverage
uv run pytest --cov=agent tests/

# Run linting and formatting
uv run ruff check src/
uv run black src/
uv run mypy src/
```

## Docker Support

```dockerfile
FROM ghcr.io/astral-sh/uv:python3.11-slim

WORKDIR /app

# Copy project files
COPY pyproject.toml .
COPY src/ ./src/

# Install dependencies with uv
RUN uv venv && \
    . .venv/bin/activate && \
    uv pip install -e .

EXPOSE 8090

CMD [".venv/bin/python", "src/main.py"]
```

Build and run:
```bash
docker build -t texera-agent .
docker run -p 8090:8090 -e OPENAI_API_KEY=your-key texera-agent
```

## Security Notes

- API keys are never exposed to frontend
- All secrets managed through environment variables
- Rate limiting configured per provider
- Audit logging available for all agent actions

## License

Apache License 2.0