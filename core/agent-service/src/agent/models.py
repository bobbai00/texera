"""
Pydantic models for agent service.
"""

from enum import Enum
from typing import Dict, Any, Optional, List, Literal
from pydantic import BaseModel, Field
import time


class AgentStatus(str, Enum):
    """Agent connection status."""
    CONNECTING = "Connecting"
    CONNECTED = "Connected"
    ACTIVE = "Active"
    DISCONNECTED = "Disconnected"
    ERROR = "Error"


class ModelConfig(BaseModel):
    """LLM model configuration."""
    provider: str = Field(default="openai", description="LLM provider")
    model: str = Field(default="gpt-4-turbo-preview", description="Model name")
    temperature: float = Field(default=0.7, ge=0.0, le=2.0, description="Sampling temperature")
    max_tokens: int = Field(default=4096, gt=0, description="Maximum tokens to generate")


class Position(BaseModel):
    """Position in workflow canvas."""
    x: float
    y: float


class PortInfo(BaseModel):
    """Port information for links."""
    operator_id: str = Field(description="ID of the operator")
    port_id: str = Field(description="ID of the port")


class OperatorInfo(BaseModel):
    """Operator information."""
    operator_id: str = Field(description="Unique operator ID")
    operator_type: str = Field(description="Type of operator")
    display_name: str = Field(description="Display name")
    properties: Dict[str, Any] = Field(default_factory=dict, description="Operator properties")
    position: Optional[Position] = Field(default=None, description="Position on canvas")


class LinkInfo(BaseModel):
    """Link information."""
    link_id: str = Field(description="Unique link ID")
    source: PortInfo = Field(description="Source port")
    target: PortInfo = Field(description="Target port")


class WorkflowState(BaseModel):
    """Current workflow state."""
    operators: List[OperatorInfo] = Field(default_factory=list)
    links: List[LinkInfo] = Field(default_factory=list)
    execution_status: Optional[str] = None


class WorkflowEvent(BaseModel):
    """Event from shared editing system."""
    event_type: str
    operator_id: Optional[str] = None
    link_id: Optional[str] = None
    data: Dict[str, Any] = Field(default_factory=dict)
    timestamp: int = Field(default_factory=lambda: int(time.time() * 1000))


class AgentSession(BaseModel):
    """Active agent session."""
    workflow_id: int
    agent_user_id: int
    llm_config: ModelConfig
    start_time: int
    status: AgentStatus = AgentStatus.CONNECTING
    workflow_state: Optional[WorkflowState] = None


# Tool models for instructor
class AddOperatorTool(BaseModel):
    """Add a new operator to the workflow."""
    operator_type: str = Field(description="Type of operator (e.g., 'CSVScanSource', 'Filter')")
    operator_id: str = Field(description="Unique ID for the operator")
    display_name: str = Field(description="Display name for the operator")
    position: Optional[Position] = Field(default=None, description="Position on canvas")


class DeleteOperatorTool(BaseModel):
    """Delete an operator from the workflow."""
    operator_id: str = Field(description="ID of operator to delete")


class SetOperatorPropertyTool(BaseModel):
    """Set or update operator properties."""
    operator_id: str = Field(description="ID of operator to modify")
    properties: Dict[str, Any] = Field(description="Properties to set")


class AddLinkTool(BaseModel):
    """Add a link between two operators."""
    link_id: str = Field(description="Unique ID for the link")
    source_operator_id: str = Field(description="Source operator ID")
    source_port_id: str = Field(description="Source port ID")
    target_operator_id: str = Field(description="Target operator ID")
    target_port_id: str = Field(description="Target port ID")


class DeleteLinkTool(BaseModel):
    """Delete a link from the workflow."""
    link_id: str = Field(description="ID of link to delete")


class RunWorkflowTool(BaseModel):
    """Execute the workflow."""
    pass


class PauseWorkflowTool(BaseModel):
    """Pause workflow execution."""
    pass


class ViewOperatorResultsTool(BaseModel):
    """View execution results of an operator."""
    operator_id: str = Field(description="ID of operator whose results to view")


class GetWorkflowGraphTool(BaseModel):
    """Get the current workflow graph structure."""
    pass


class GetOperatorInfoTool(BaseModel):
    """Get detailed information about an operator."""
    operator_id: str = Field(description="ID of operator to get info about")


class GetExecutionStatusTool(BaseModel):
    """Get current workflow execution status."""
    pass


# API Request/Response models
class InviteAgentRequest(BaseModel):
    """Request to invite agent to workflow."""
    workflow_id: int
    llm_config: Optional[ModelConfig] = None


class InviteAgentResponse(BaseModel):
    """Response from agent invitation."""
    success: bool
    agent_user_id: Optional[int] = None
    message: str


class RemoveAgentRequest(BaseModel):
    """Request to remove agent from workflow."""
    workflow_id: int


class RemoveAgentResponse(BaseModel):
    """Response from agent removal."""
    success: bool
    message: str


class AgentStatusResponse(BaseModel):
    """Agent status response."""
    workflow_id: int
    is_active: bool
    status: Optional[AgentStatus] = None


class ModelInfo(BaseModel):
    """Available model information."""
    id: str
    name: str
    provider: str


class AvailableModelsResponse(BaseModel):
    """Response with available models."""
    models: List[ModelInfo]