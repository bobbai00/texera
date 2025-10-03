"""
FastAPI REST API for agent service.
"""

from typing import List, Optional
from fastapi import FastAPI, HTTPException, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import structlog
import uvicorn

from .agent_service import AgentService
from .config import AgentConfig
from .models import (
    InviteAgentResponse,
    RemoveAgentResponse,
    AgentStatusResponse,
    ModelInfo,
    AvailableModelsResponse,
    SendChatRequest,
    SendChatResponse,
    ChatHistoryRequest,
    ChatHistoryResponse,
    ChatMessage,
)

# Setup logging
structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.dev.ConsoleRenderer(),
    ],
    context_class=dict,
    logger_factory=structlog.stdlib.LoggerFactory(),
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger()

# Create FastAPI app
app = FastAPI(
    title="Texera Agent Service",
    description="LLM Agent service for collaborative workflow editing",
    version="1.0.0",
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize services
config = AgentConfig()
agent_service = AgentService(config)


# Dependency for checking if service is enabled
async def check_service_enabled():
    """Check if agent service is enabled."""
    if not config.is_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Agent service is disabled"
        )
    return True


# Health check endpoint
@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "service": "agent", "enabled": config.is_enabled}


# Agent endpoints
@app.post(
    "/api/agent/{workflow_id}/invite",
    response_model=InviteAgentResponse,
    dependencies=[Depends(check_service_enabled)],
)
async def invite_agent(workflow_id: int):
    """
    Invite an agent to join a workflow.

    Args:
        workflow_id: Workflow ID to invite agent to

    Returns:
        Invitation response with agent user ID
    """
    try:
        logger.info(f"Inviting agent to workflow {workflow_id}")
        response = await agent_service.invite_agent(workflow_id)

        if not response.success:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=response.message)

        return response

    except Exception as e:
        logger.error(f"Error inviting agent: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@app.post(
    "/api/agent/{workflow_id}/remove",
    response_model=RemoveAgentResponse,
    dependencies=[Depends(check_service_enabled)],
)
async def remove_agent(workflow_id: int):
    """
    Remove an agent from a workflow.

    Args:
        workflow_id: Workflow ID to remove agent from

    Returns:
        Removal response
    """
    try:
        logger.info(f"Removing agent from workflow {workflow_id}")
        response = await agent_service.remove_agent(workflow_id)

        if not response.success:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=response.message)

        return response

    except Exception as e:
        logger.error(f"Error removing agent: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@app.get(
    "/api/agent/{workflow_id}/status",
    response_model=AgentStatusResponse,
    dependencies=[Depends(check_service_enabled)],
)
async def get_agent_status(workflow_id: int):
    """
    Get agent status for a workflow.

    Args:
        workflow_id: Workflow ID

    Returns:
        Agent status response
    """
    try:
        response = await agent_service.get_agent_status(workflow_id)
        return response

    except Exception as e:
        logger.error(f"Error getting agent status: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@app.get(
    "/api/agent/models",
    response_model=AvailableModelsResponse,
    dependencies=[Depends(check_service_enabled)],
)
async def get_available_models():
    """
    Get list of available LLM models.

    Returns:
        List of available models
    """
    try:
        models_data = agent_service.get_available_models()
        models = [
            ModelInfo(id=m["id"], name=m["name"], provider=m["provider"]) for m in models_data
        ]
        return AvailableModelsResponse(models=models)

    except Exception as e:
        logger.error(f"Error getting available models: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


# Chat endpoints
@app.post(
    "/api/agent/{workflow_id}/chat/send",
    response_model=SendChatResponse,
    dependencies=[Depends(check_service_enabled)],
)
async def send_chat_message(workflow_id: int, request: SendChatRequest):
    """
    Send a chat message to the agent.

    Args:
        workflow_id: Workflow ID
        request: Chat request with message

    Returns:
        Chat response with agent's reply
    """
    try:
        logger.info(f"Sending chat message to agent for workflow {workflow_id}")
        response = await agent_service.send_chat_message(workflow_id, request)

        if not response.success:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=response.error)

        return response

    except Exception as e:
        logger.error(f"Error sending chat message: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@app.post(
    "/api/agent/{workflow_id}/chat/history",
    response_model=ChatHistoryResponse,
    dependencies=[Depends(check_service_enabled)],
)
async def get_chat_history(workflow_id: int, request: ChatHistoryRequest):
    """
    Get chat history for a workflow.

    Args:
        workflow_id: Workflow ID
        request: History request with filters

    Returns:
        Chat history response
    """
    try:
        logger.info(f"Getting chat history for workflow {workflow_id}")
        response = await agent_service.get_chat_history(workflow_id, request)

        if not response.success:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Failed to retrieve chat history"
            )

        return response

    except Exception as e:
        logger.error(f"Error getting chat history: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


# Error handlers
@app.exception_handler(404)
async def not_found_handler(request, exc):
    """Handle 404 errors."""
    return JSONResponse(status_code=404, content={"error": "Endpoint not found"})


@app.exception_handler(500)
async def internal_error_handler(request, exc):
    """Handle 500 errors."""
    logger.error(f"Internal server error: {exc}")
    return JSONResponse(status_code=500, content={"error": "Internal server error"})


def start_server(host: str = "0.0.0.0", port: int = 8090, reload: bool = False):
    """
    Start the FastAPI server.

    Args:
        host: Host to bind to
        port: Port to bind to
        reload: Enable auto-reload for development
    """
    logger.info(f"Starting agent service on {host}:{port}")
    uvicorn.run("agent.api:app", host=host, port=port, reload=reload, log_level="info")


if __name__ == "__main__":
    # Start server for development
    start_server(reload=True)
