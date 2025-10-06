"""
Workflow manipulation tools for the agent.
"""

import json
from typing import Any, Dict, Optional
import structlog

from .models import (
    AddOperatorTool,
    DeleteOperatorTool,
    SetOperatorPropertyTool,
    AddLinkTool,
    DeleteLinkTool,
    RunWorkflowTool,
    PauseWorkflowTool,
    ViewOperatorResultsTool,
    GetWorkflowGraphTool,
    GetOperatorInfoTool,
    GetExecutionStatusTool,
    WorkflowState,
    AgentSession,
)
from .shared_editing_client import SharedEditingClient

logger = structlog.get_logger()


class WorkflowToolkit:
    """Toolkit for workflow manipulation."""

    def __init__(self):
        """Initialize workflow toolkit."""
        self.tool_classes = [
            AddOperatorTool,
            DeleteOperatorTool,
            SetOperatorPropertyTool,
            AddLinkTool,
            DeleteLinkTool,
            RunWorkflowTool,
            PauseWorkflowTool,
            ViewOperatorResultsTool,
            GetWorkflowGraphTool,
            GetOperatorInfoTool,
            GetExecutionStatusTool,
        ]
        self.shared_editing_clients: Dict[int, SharedEditingClient] = {}

    def get_tool_classes(self):
        """Get all available tool classes for instructor."""
        return self.tool_classes

    async def get_or_create_shared_editing_client(self, workflow_id: int) -> SharedEditingClient:
        """
        Get or create a shared editing client for the workflow.

        Args:
            workflow_id: The workflow ID

        Returns:
            SharedEditingClient instance
        """
        if workflow_id not in self.shared_editing_clients:
            # Create new client
            import os

            rtc_url = os.environ.get("SHARED_EDITING_URL", "ws://localhost:1234")
            client = SharedEditingClient(workflow_id, rtc_url)
            await client.connect()
            self.shared_editing_clients[workflow_id] = client
            logger.info(f"Created new shared editing client for workflow {workflow_id}")

        return self.shared_editing_clients[workflow_id]

    async def execute_tool(
        self, tool_instance: Any, session: AgentSession, ws_connection: Optional[Any] = None
    ) -> Dict[str, Any]:
        """
        Execute a tool instance.

        Args:
            tool_instance: Instance of a tool model
            session: Current agent session
            ws_connection: WebSocket connection for sending events

        Returns:
            Result of tool execution
        """
        tool_name = type(tool_instance).__name__
        logger.info(f"Executing tool: {tool_name}")

        try:
            if isinstance(tool_instance, AddOperatorTool):
                return await self._execute_add_operator(tool_instance, session, ws_connection)
            elif isinstance(tool_instance, DeleteOperatorTool):
                return await self._execute_delete_operator(tool_instance, session, ws_connection)
            elif isinstance(tool_instance, SetOperatorPropertyTool):
                return await self._execute_set_property(tool_instance, session, ws_connection)
            elif isinstance(tool_instance, AddLinkTool):
                return await self._execute_add_link(tool_instance, session, ws_connection)
            elif isinstance(tool_instance, DeleteLinkTool):
                return await self._execute_delete_link(tool_instance, session, ws_connection)
            elif isinstance(tool_instance, RunWorkflowTool):
                return await self._execute_run_workflow(session, ws_connection)
            elif isinstance(tool_instance, PauseWorkflowTool):
                return await self._execute_pause_workflow(session, ws_connection)
            elif isinstance(tool_instance, ViewOperatorResultsTool):
                return await self._execute_view_results(tool_instance, session, ws_connection)
            elif isinstance(tool_instance, GetWorkflowGraphTool):
                return await self._execute_get_graph(session)
            elif isinstance(tool_instance, GetOperatorInfoTool):
                return await self._execute_get_operator_info(tool_instance, session)
            elif isinstance(tool_instance, GetExecutionStatusTool):
                return await self._execute_get_status(session)
            else:
                return {"success": False, "error": f"Unknown tool: {tool_name}"}

        except Exception as e:
            logger.error(f"Error executing tool {tool_name}: {e}")
            return {"success": False, "error": str(e)}

    async def _execute_add_operator(
        self, tool: AddOperatorTool, session: AgentSession, ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute add operator tool through shared editing Y.js."""
        try:
            # Get shared editing client
            client = await self.get_or_create_shared_editing_client(session.workflow_id)

            # Default position if not provided
            position = tool.position or {"x": 300, "y": 300}

            # Create operator predicate matching Texera's format
            operator_data = {
                "operatorType": tool.operator_type,
                "operatorVersion": "v1",  # Default version
                "operatorProperties": {},
                "inputPorts": [],
                "outputPorts": [],
                "showAdvanced": False,
                "isDisabled": False,
                "customDisplayName": tool.display_name,
            }

            # Add operator through Y.js shared editing
            client.add_operator(
                operator_id=tool.operator_id,
                operator_data=operator_data,
                position={
                    "x": position.get("x", 300) if isinstance(position, dict) else position.x,
                    "y": position.get("y", 300) if isinstance(position, dict) else position.y,
                },
            )

            # Update local state
            if session.workflow_state:
                from .models import OperatorInfo

                session.workflow_state.operators.append(
                    OperatorInfo(
                        operator_id=tool.operator_id,
                        operator_type=tool.operator_type,
                        display_name=tool.display_name,
                        position=tool.position,
                    )
                )

            logger.info(f"Added operator {tool.operator_id} via shared editing")

            return {
                "success": True,
                "operator_id": tool.operator_id,
                "message": f"Added operator {tool.display_name}",
            }

        except Exception as e:
            logger.error(f"Error adding operator: {e}")
            return {
                "success": False,
                "error": str(e),
                "message": f"Failed to add operator: {str(e)}",
            }

    async def _execute_delete_operator(
        self, tool: DeleteOperatorTool, session: AgentSession, ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute delete operator tool through shared editing Y.js."""
        try:
            # Get shared editing client
            client = await self.get_or_create_shared_editing_client(session.workflow_id)

            # Delete operator through Y.js
            client.delete_operator(tool.operator_id)

            # Update local state
            if session.workflow_state:
                session.workflow_state.operators = [
                    op
                    for op in session.workflow_state.operators
                    if op.operator_id != tool.operator_id
                ]

            logger.info(f"Deleted operator {tool.operator_id} via shared editing")

            return {
                "success": True,
                "deleted": tool.operator_id,
                "message": f"Deleted operator {tool.operator_id}",
            }

        except Exception as e:
            logger.error(f"Error deleting operator: {e}")
            return {
                "success": False,
                "error": str(e),
                "message": f"Failed to delete operator: {str(e)}",
            }

    async def _execute_set_property(
        self, tool: SetOperatorPropertyTool, session: AgentSession, ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute set operator property tool through shared editing Y.js."""
        try:
            # Get shared editing client
            client = await self.get_or_create_shared_editing_client(session.workflow_id)

            # Update properties through Y.js
            client.set_operator_property(tool.operator_id, tool.properties)

            # Update local state
            if session.workflow_state:
                for op in session.workflow_state.operators:
                    if op.operator_id == tool.operator_id:
                        op.properties.update(tool.properties)
                        break

            logger.info(f"Updated properties for {tool.operator_id} via shared editing")

            return {
                "success": True,
                "operator_id": tool.operator_id,
                "message": f"Updated properties for {tool.operator_id}",
            }

        except Exception as e:
            logger.error(f"Error updating operator properties: {e}")
            return {
                "success": False,
                "error": str(e),
                "message": f"Failed to update properties: {str(e)}",
            }

    async def _execute_add_link(
        self, tool: AddLinkTool, session: AgentSession, ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute add link tool through shared editing Y.js."""
        try:
            # Get shared editing client
            client = await self.get_or_create_shared_editing_client(session.workflow_id)

            # Add link through Y.js
            client.add_link(
                link_id=tool.link_id,
                source_op=tool.source_operator_id,
                source_port=tool.source_port_id,
                target_op=tool.target_operator_id,
                target_port=tool.target_port_id,
            )

            # Update local state
            if session.workflow_state:
                from .models import LinkInfo, PortInfo

                session.workflow_state.links.append(
                    LinkInfo(
                        link_id=tool.link_id,
                        source=PortInfo(
                            operator_id=tool.source_operator_id, port_id=tool.source_port_id
                        ),
                        target=PortInfo(
                            operator_id=tool.target_operator_id, port_id=tool.target_port_id
                        ),
                    )
                )

            logger.info(f"Added link {tool.link_id} via shared editing")

            return {
                "success": True,
                "link_id": tool.link_id,
                "message": f"Added link {tool.link_id}",
            }

        except Exception as e:
            logger.error(f"Error adding link: {e}")
            return {
                "success": False,
                "error": str(e),
                "message": f"Failed to add link: {str(e)}",
            }

    async def _execute_delete_link(
        self, tool: DeleteLinkTool, session: AgentSession, ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute delete link tool through shared editing Y.js."""
        try:
            # Get shared editing client
            client = await self.get_or_create_shared_editing_client(session.workflow_id)

            # Delete link through Y.js
            client.delete_link(tool.link_id)

            # Update local state
            if session.workflow_state:
                session.workflow_state.links = [
                    link for link in session.workflow_state.links if link.link_id != tool.link_id
                ]

            logger.info(f"Deleted link {tool.link_id} via shared editing")

            return {
                "success": True,
                "deleted": tool.link_id,
                "message": f"Deleted link {tool.link_id}",
            }

        except Exception as e:
            logger.error(f"Error deleting link: {e}")
            return {
                "success": False,
                "error": str(e),
                "message": f"Failed to delete link: {str(e)}",
            }

    async def _execute_run_workflow(
        self, session: AgentSession, ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute run workflow tool."""
        event = {"type": "executeWorkflow"}

        if ws_connection:
            await self._send_to_websocket(ws_connection, event)

        # Update local state
        if session.workflow_state:
            session.workflow_state.execution_status = "running"

        return {"success": True, "status": "running", "message": "Workflow execution started"}

    async def _execute_pause_workflow(
        self, session: AgentSession, ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute pause workflow tool."""
        event = {"type": "pauseWorkflow"}

        if ws_connection:
            await self._send_to_websocket(ws_connection, event)

        # Update local state
        if session.workflow_state:
            session.workflow_state.execution_status = "paused"

        return {"success": True, "status": "paused", "message": "Workflow execution paused"}

    async def _execute_view_results(
        self, tool: ViewOperatorResultsTool, session: AgentSession, ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute view operator results tool."""
        event = {"type": "viewResults", "operatorId": tool.operator_id}

        if ws_connection:
            await self._send_to_websocket(ws_connection, event)

        return {
            "success": True,
            "operator_id": tool.operator_id,
            "message": f"Viewing results for {tool.operator_id}",
        }

    async def _execute_get_graph(self, session: AgentSession) -> Dict[str, Any]:
        """Execute get workflow graph tool."""
        try:
            # Get shared editing client to get current state
            client = await self.get_or_create_shared_editing_client(session.workflow_id)

            # Get workflow state from Y.js
            state = client.get_workflow_state()

            return {
                "success": True,
                "operators": state.get("operators", []),
                "links": state.get("links", []),
            }

        except Exception as e:
            logger.error(f"Error getting workflow graph: {e}")

            # Fall back to local state if available
            if session.workflow_state:
                return {
                    "success": True,
                    "operators": [
                        {"id": op.operator_id, "type": op.operator_type, "name": op.display_name}
                        for op in session.workflow_state.operators
                    ],
                    "links": [
                        {
                            "id": link.link_id,
                            "source": link.source.operator_id,
                            "target": link.target.operator_id,
                        }
                        for link in session.workflow_state.links
                    ],
                }

            return {"success": False, "error": str(e)}

    async def _execute_get_operator_info(
        self, tool: GetOperatorInfoTool, session: AgentSession
    ) -> Dict[str, Any]:
        """Execute get operator info tool."""
        if not session.workflow_state:
            return {"success": False, "error": "No workflow state available"}

        for op in session.workflow_state.operators:
            if op.operator_id == tool.operator_id:
                return {
                    "success": True,
                    "operator": {
                        "id": op.operator_id,
                        "type": op.operator_type,
                        "name": op.display_name,
                        "properties": op.properties,
                    },
                }

        return {"success": False, "error": f"Operator {tool.operator_id} not found"}

    async def _execute_get_status(self, session: AgentSession) -> Dict[str, Any]:
        """Execute get execution status tool."""
        status = "uninitialized"
        if session.workflow_state and session.workflow_state.execution_status:
            status = session.workflow_state.execution_status

        return {"success": True, "status": status, "message": f"Workflow status: {status}"}
