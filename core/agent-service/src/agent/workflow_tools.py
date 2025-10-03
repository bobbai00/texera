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
    AgentSession
)

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
            GetExecutionStatusTool
        ]

    def get_tool_classes(self):
        """Get all available tool classes for instructor."""
        return self.tool_classes

    async def execute_tool(
        self,
        tool_instance: Any,
        session: AgentSession,
        ws_connection: Optional[Any] = None
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
        self,
        tool: AddOperatorTool,
        session: AgentSession,
        ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute add operator tool through HTTP API."""
        # Instead of WebSocket, we'll use HTTP API to add operator
        import aiohttp

        # Default position if not provided
        position = tool.position or {"x": 300, "y": 300}

        # Create operator predicate matching Texera's format
        operator_data = {
            "operatorID": tool.operator_id,
            "operatorType": tool.operator_type,
            "operatorVersion": "v1",  # Default version
            "operatorProperties": {},
            "inputPorts": [],
            "outputPorts": [],
            "showAdvanced": False,
            "isDisabled": False,
            "customDisplayName": tool.display_name
        }

        # Call Texera backend API to add operator
        try:
            # Get the backend URL from environment or use default
            import os
            backend_url = os.environ.get("TEXERA_BACKEND_URL", "http://localhost:8080")

            async with aiohttp.ClientSession() as http_session:
                # Add operator via REST API
                async with http_session.post(
                    f"{backend_url}/api/workflow/{session.workflow_id}/operator",
                    json={
                        "operator": operator_data,
                        "position": {"x": position.x if hasattr(position, 'x') else position["x"],
                                   "y": position.y if hasattr(position, 'y') else position["y"]}
                    }
                ) as resp:
                    if resp.status == 200:
                        logger.info(f"Added operator {tool.operator_id} via API")
                    else:
                        logger.warning(f"API call returned status {resp.status}")
        except Exception as e:
            logger.error(f"Error calling backend API: {e}")
            # Continue even if API call fails, as we'll update through shared editing

        # Update local state
        if session.workflow_state:
            from .models import OperatorInfo
            session.workflow_state.operators.append(
                OperatorInfo(
                    operator_id=tool.operator_id,
                    operator_type=tool.operator_type,
                    display_name=tool.display_name,
                    position=tool.position
                )
            )

        return {
            "success": True,
            "operator_id": tool.operator_id,
            "message": f"Added operator {tool.display_name}"
        }

    async def _execute_delete_operator(
        self,
        tool: DeleteOperatorTool,
        session: AgentSession,
        ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute delete operator tool."""
        event = {
            "type": "operatorDelete",
            "operatorId": tool.operator_id
        }

        if ws_connection:
            await self._send_to_websocket(ws_connection, event)

        # Update local state
        if session.workflow_state:
            session.workflow_state.operators = [
                op for op in session.workflow_state.operators
                if op.operator_id != tool.operator_id
            ]

        return {
            "success": True,
            "deleted": tool.operator_id,
            "message": f"Deleted operator {tool.operator_id}"
        }

    async def _execute_set_property(
        self,
        tool: SetOperatorPropertyTool,
        session: AgentSession,
        ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute set operator property tool."""
        event = {
            "type": "operatorPropertyChange",
            "operatorId": tool.operator_id,
            "properties": tool.properties
        }

        if ws_connection:
            await self._send_to_websocket(ws_connection, event)

        # Update local state
        if session.workflow_state:
            for op in session.workflow_state.operators:
                if op.operator_id == tool.operator_id:
                    op.properties.update(tool.properties)
                    break

        return {
            "success": True,
            "operator_id": tool.operator_id,
            "message": f"Updated properties for {tool.operator_id}"
        }

    async def _execute_add_link(
        self,
        tool: AddLinkTool,
        session: AgentSession,
        ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute add link tool."""
        event = {
            "type": "linkAdd",
            "linkId": tool.link_id,
            "source": {
                "operatorId": tool.source_operator_id,
                "portId": tool.source_port_id
            },
            "target": {
                "operatorId": tool.target_operator_id,
                "portId": tool.target_port_id
            }
        }

        if ws_connection:
            await self._send_to_websocket(ws_connection, event)

        # Update local state
        if session.workflow_state:
            from .models import LinkInfo, PortInfo
            session.workflow_state.links.append(
                LinkInfo(
                    link_id=tool.link_id,
                    source=PortInfo(
                        operator_id=tool.source_operator_id,
                        port_id=tool.source_port_id
                    ),
                    target=PortInfo(
                        operator_id=tool.target_operator_id,
                        port_id=tool.target_port_id
                    )
                )
            )

        return {
            "success": True,
            "link_id": tool.link_id,
            "message": f"Added link {tool.link_id}"
        }

    async def _execute_delete_link(
        self,
        tool: DeleteLinkTool,
        session: AgentSession,
        ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute delete link tool."""
        event = {
            "type": "linkDelete",
            "linkId": tool.link_id
        }

        if ws_connection:
            await self._send_to_websocket(ws_connection, event)

        # Update local state
        if session.workflow_state:
            session.workflow_state.links = [
                link for link in session.workflow_state.links
                if link.link_id != tool.link_id
            ]

        return {
            "success": True,
            "deleted": tool.link_id,
            "message": f"Deleted link {tool.link_id}"
        }

    async def _execute_run_workflow(
        self,
        session: AgentSession,
        ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute run workflow tool."""
        event = {"type": "executeWorkflow"}

        if ws_connection:
            await self._send_to_websocket(ws_connection, event)

        # Update local state
        if session.workflow_state:
            session.workflow_state.execution_status = "running"

        return {
            "success": True,
            "status": "running",
            "message": "Workflow execution started"
        }

    async def _execute_pause_workflow(
        self,
        session: AgentSession,
        ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute pause workflow tool."""
        event = {"type": "pauseWorkflow"}

        if ws_connection:
            await self._send_to_websocket(ws_connection, event)

        # Update local state
        if session.workflow_state:
            session.workflow_state.execution_status = "paused"

        return {
            "success": True,
            "status": "paused",
            "message": "Workflow execution paused"
        }

    async def _execute_view_results(
        self,
        tool: ViewOperatorResultsTool,
        session: AgentSession,
        ws_connection: Optional[Any]
    ) -> Dict[str, Any]:
        """Execute view operator results tool."""
        event = {
            "type": "viewResults",
            "operatorId": tool.operator_id
        }

        if ws_connection:
            await self._send_to_websocket(ws_connection, event)

        return {
            "success": True,
            "operator_id": tool.operator_id,
            "message": f"Viewing results for {tool.operator_id}"
        }

    async def _execute_get_graph(self, session: AgentSession) -> Dict[str, Any]:
        """Execute get workflow graph tool."""
        if not session.workflow_state:
            return {
                "success": False,
                "error": "No workflow state available"
            }

        return {
            "success": True,
            "operators": [
                {
                    "id": op.operator_id,
                    "type": op.operator_type,
                    "name": op.display_name
                }
                for op in session.workflow_state.operators
            ],
            "links": [
                {
                    "id": link.link_id,
                    "source": link.source.operator_id,
                    "target": link.target.operator_id
                }
                for link in session.workflow_state.links
            ]
        }

    async def _execute_get_operator_info(
        self,
        tool: GetOperatorInfoTool,
        session: AgentSession
    ) -> Dict[str, Any]:
        """Execute get operator info tool."""
        if not session.workflow_state:
            return {
                "success": False,
                "error": "No workflow state available"
            }

        for op in session.workflow_state.operators:
            if op.operator_id == tool.operator_id:
                return {
                    "success": True,
                    "operator": {
                        "id": op.operator_id,
                        "type": op.operator_type,
                        "name": op.display_name,
                        "properties": op.properties
                    }
                }

        return {
            "success": False,
            "error": f"Operator {tool.operator_id} not found"
        }

    async def _execute_get_status(self, session: AgentSession) -> Dict[str, Any]:
        """Execute get execution status tool."""
        status = "uninitialized"
        if session.workflow_state and session.workflow_state.execution_status:
            status = session.workflow_state.execution_status

        return {
            "success": True,
            "status": status,
            "message": f"Workflow status: {status}"
        }

    async def _send_to_websocket(self, ws_connection: Any, event: Dict[str, Any]):
        """Send event to WebSocket connection."""
        try:
            message = json.dumps(event)
            await ws_connection.send(message)
            logger.info(f"Sent WebSocket event: {event['type']}")
        except Exception as e:
            logger.error(f"Error sending to WebSocket: {e}")
            raise