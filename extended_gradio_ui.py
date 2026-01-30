# -*- coding: utf-8 -*-
"""
Extended GradioUI with import/export capabilities.

Adds conversation history export and trace file import functionality
to the standard smolagents GradioUI.
"""

import json
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

from smolagents import GradioUI
from smolagents.gradio_ui import stream_to_gradio, MessageRole


class ExtendedGradioUI(GradioUI):
    """
    Extended GradioUI with import/export capabilities.

    Adds:
    - Export: Save current conversation history to a JSON file
    - Import: Load a previous trace file and display it (display-only)
    """

    def create_app(self):
        """Override to add export/import buttons in the sidebar."""
        import gradio as gr

        with gr.Blocks(theme="ocean", fill_height=True) as demo:
            # Add session state to store session-specific data
            session_state = gr.State({})
            stored_messages = gr.State([])
            file_uploads_log = gr.State([])

            with gr.Sidebar():
                gr.Markdown(
                    f"# {self.name.replace('_', ' ').capitalize()}"
                    "\n> This web ui allows you to interact with a `smolagents` agent that can use tools and execute steps to complete tasks."
                    + (f"\n\n**Agent description:**\n{self.description}" if self.description else "")
                )

                with gr.Group():
                    gr.Markdown("**Your request**", container=True)
                    text_input = gr.Textbox(
                        lines=3,
                        label="Chat Message",
                        container=False,
                        placeholder="Enter your prompt here and press Shift+Enter or press the button",
                    )
                    submit_btn = gr.Button("Submit", variant="primary")

                # If an upload folder is provided, enable the upload feature
                if self.file_upload_folder is not None:
                    upload_file = gr.File(label="Upload a file")
                    upload_status = gr.Textbox(label="Upload Status", interactive=False, visible=False)
                    upload_file.change(
                        self.upload_file,
                        [upload_file, file_uploads_log],
                        [upload_status, file_uploads_log],
                    )

                # NEW: Conversation Management Section
                with gr.Group():
                    gr.Markdown("**Conversation Management**", container=True)

                    with gr.Row():
                        export_btn = gr.Button("Export", variant="secondary", size="sm")

                    import_file = gr.File(
                        label="Import Trace",
                        file_types=[".json"],
                        file_count="single",
                    )

                    import_status = gr.Textbox(
                        label="Status",
                        interactive=False,
                        visible=True,
                        value="Ready",
                        max_lines=2,
                    )

                gr.HTML(
                    "<br><br><h4><center>Powered by <a target='_blank' href='https://github.com/huggingface/smolagents'><b>smolagents</b></a></center></h4>"
                )

            # Main chat interface
            chatbot = gr.Chatbot(
                label="Agent",
                type="messages",
                avatar_images=(
                    None,
                    "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/smolagents/mascot_smol.png",
                ),
                resizeable=True,
                scale=1,
                latex_delimiters=[
                    {"left": r"$$", "right": r"$$", "display": True},
                    {"left": r"$", "right": r"$", "display": False},
                    {"left": r"\[", "right": r"\]", "display": True},
                    {"left": r"\(", "right": r"\)", "display": False},
                ],
            )

            # Set up event handlers for chat
            text_input.submit(
                self.log_user_message,
                [text_input, file_uploads_log],
                [stored_messages, text_input, submit_btn],
            ).then(self.interact_with_agent, [stored_messages, chatbot, session_state], [chatbot]).then(
                lambda: (
                    gr.Textbox(
                        interactive=True, placeholder="Enter your prompt here and press Shift+Enter or the button"
                    ),
                    gr.Button(interactive=True),
                ),
                None,
                [text_input, submit_btn],
            )

            submit_btn.click(
                self.log_user_message,
                [text_input, file_uploads_log],
                [stored_messages, text_input, submit_btn],
            ).then(self.interact_with_agent, [stored_messages, chatbot, session_state], [chatbot]).then(
                lambda: (
                    gr.Textbox(
                        interactive=True, placeholder="Enter your prompt here and press Shift+Enter or the button"
                    ),
                    gr.Button(interactive=True),
                ),
                None,
                [text_input, submit_btn],
            )

            chatbot.clear(self.agent.memory.reset)

            # NEW: Export handler
            export_btn.click(
                self.export_conversation,
                [chatbot],
                [gr.File(visible=True)],
            )

            # NEW: Import handler
            import_file.change(
                self.import_trace,
                [import_file],
                [chatbot, import_status],
            )

        return demo

    def export_conversation(self, chatbot_messages: list) -> str | None:
        """
        Export conversation history to a JSON file.

        The exported format is compatible with import and includes:
        - task: The user's original request/question
        - response: The final answer from the agent
        - reasoning_trace: Step-by-step execution trace with task in first step
        - messages: Serialized chatbot messages for display
        - exported_at: Timestamp of export
        - error: Any error that occurred (or None)

        Args:
            chatbot_messages: List of gr.ChatMessage objects from the chatbot

        Returns:
            Path to the exported JSON file, or None if no messages
        """
        if not chatbot_messages:
            return None

        # Extract user's task from messages
        user_task = self._extract_user_task(chatbot_messages)

        # Extract reasoning trace and add task to first step
        reasoning_trace = self._extract_reasoning_trace()
        if reasoning_trace and user_task:
            reasoning_trace[0]["task"] = user_task

        # Build export data structure
        export_data = {
            "task": user_task,
            "response": self._extract_final_answer(chatbot_messages),
            "reasoning_trace": reasoning_trace,
            "messages": self._serialize_messages(chatbot_messages),
            "exported_at": datetime.now().isoformat(),
            "error": None,
        }

        # Write to temp file
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        export_path = Path(tempfile.gettempdir()) / f"conversation_export_{timestamp}.json"

        with open(export_path, "w", encoding="utf-8") as f:
            json.dump(export_data, f, indent=2, ensure_ascii=False, default=str)

        return str(export_path)

    def _extract_final_answer(self, messages: list) -> str | None:
        """Extract the final answer from messages if present."""
        for msg in reversed(messages):
            content = self._get_message_content(msg)
            if content and "**Final answer:**" in content:
                return content.replace("**Final answer:**", "").strip()
        return None

    def _extract_user_task(self, messages: list) -> str | None:
        """Extract the user's original task/request from messages."""
        for msg in messages:
            role = self._get_message_role(msg)
            if role == "user":
                content = self._get_message_content(msg)
                if content:
                    return content
        return None

    def _extract_reasoning_trace(self) -> list[dict]:
        """Extract reasoning trace from agent memory."""
        if not hasattr(self.agent, "memory") or not hasattr(self.agent.memory, "steps"):
            return []

        trace = []
        for i, step in enumerate(self.agent.memory.steps):
            step_data = {"step": i + 1}

            if hasattr(step, "model_output"):
                step_data["model_output"] = step.model_output
            if hasattr(step, "code_action"):
                step_data["code"] = step.code_action
            if hasattr(step, "observations"):
                step_data["observations"] = step.observations
            if hasattr(step, "tool_calls") and step.tool_calls:
                step_data["tool_calls"] = str(step.tool_calls)
            if hasattr(step, "token_usage") and step.token_usage:
                step_data["token_usage"] = {
                    "input": step.token_usage.input_tokens,
                    "output": step.token_usage.output_tokens,
                }
            if hasattr(step, "output"):
                step_data["output"] = str(step.output)

            trace.append(step_data)

        return trace

    def _serialize_messages(self, messages: list) -> list[dict]:
        """Serialize gr.ChatMessage objects to JSON-compatible dicts."""
        serialized = []
        for msg in messages:
            content = self._get_message_content(msg)
            role = self._get_message_role(msg)
            metadata = self._get_message_metadata(msg)

            serialized.append({
                "role": role,
                "content": content,
                "metadata": metadata,
            })
        return serialized

    def _get_message_content(self, msg: Any) -> str:
        """Extract content from a message (handles different formats)."""
        if hasattr(msg, "content"):
            content = msg.content
            if isinstance(content, dict):
                return content.get("path", str(content))
            return str(content) if content else ""
        if isinstance(msg, dict):
            content = msg.get("content", "")
            if isinstance(content, dict):
                return content.get("path", str(content))
            return str(content) if content else ""
        return str(msg)

    def _get_message_role(self, msg: Any) -> str:
        """Extract role from a message."""
        if hasattr(msg, "role"):
            return str(msg.role)
        if isinstance(msg, dict):
            return msg.get("role", "assistant")
        return "assistant"

    def _get_message_metadata(self, msg: Any) -> dict:
        """Extract metadata from a message."""
        if hasattr(msg, "metadata"):
            return msg.metadata if isinstance(msg.metadata, dict) else {}
        if isinstance(msg, dict):
            return msg.get("metadata", {})
        return {}

    def import_trace(self, file_obj) -> tuple[list, str]:
        """
        Import a trace file and display it in the chatbot (display-only).

        Args:
            file_obj: Uploaded file object

        Returns:
            Tuple of (messages for chatbot, status message)
        """
        import gradio as gr

        if file_obj is None:
            return [], "Ready"

        try:
            # Read the file
            file_path = file_obj.name if hasattr(file_obj, "name") else str(file_obj)
            with open(file_path, "r", encoding="utf-8") as f:
                trace_data = json.load(f)

            # Convert trace to Gradio messages
            messages = self.trace_to_gradio_messages(trace_data)

            if not messages:
                return [], "Warning: No messages found in trace file"

            return messages, f"Imported {len(messages)} messages"

        except json.JSONDecodeError as e:
            return [], f"Error: Invalid JSON - {str(e)}"
        except Exception as e:
            return [], f"Error: {str(e)}"

    @staticmethod
    def _extract_code_from_tool_calls(tool_calls_str: str) -> str | None:
        """
        Extract Python code from tool_calls string.

        The tool_calls field contains a string representation of ToolCall objects.
        We need to extract the 'arguments' which contains the actual code.

        Args:
            tool_calls_str: String like "[ToolCall(name='python_interpreter', arguments='...', id='call_X')]"

        Returns:
            Extracted code string or None
        """
        import re

        if not tool_calls_str:
            return None

        # Try to extract the arguments field which contains the code
        # The arguments string is delimited by single quotes and may contain:
        # - Escaped single quotes: \'
        # - Escaped newlines: \n
        # - Other escaped characters
        # Pattern: match any char that's not ' or \, OR any escaped char (\.)
        # This properly handles escaped quotes inside the string
        match = re.search(
            r"arguments='((?:[^'\\]|\\.)*)'\s*,\s*id=",
            tool_calls_str,
            re.DOTALL
        )
        if match:
            code = match.group(1)
            # Unescape common escape sequences
            code = code.replace("\\n", "\n")
            code = code.replace("\\'", "'")
            code = code.replace('\\"', '"')
            code = code.replace("\\\\", "\\")
            return code

        # Fallback: try with double quotes
        match = re.search(
            r'arguments="((?:[^"\\]|\\.)*)"\s*,\s*id=',
            tool_calls_str,
            re.DOTALL
        )
        if match:
            code = match.group(1)
            code = code.replace("\\n", "\n")
            code = code.replace("\\'", "'")
            code = code.replace('\\"', '"')
            code = code.replace("\\\\", "\\")
            return code

        return None

    @staticmethod
    def _clean_llm_output(llm_output: str) -> str | None:
        """
        Clean up LLM output by extracting just the thought/reasoning part.

        Handles various formats:
        - "Thought: ..." followed by "Code:" or code blocks
        - Raw text with embedded code

        Args:
            llm_output: Raw LLM output string

        Returns:
            Cleaned thought/reasoning text or None if empty
        """
        if not llm_output:
            return None

        text = llm_output.strip()

        # Remove code blocks (```...```)
        import re
        text = re.sub(r"```[\s\S]*?```", "", text)

        # Split at "Code:" if present
        if "Code:" in text:
            text = text.split("Code:")[0].strip()

        # Split at "<code>" if present
        if "<code>" in text:
            text = text.split("<code>")[0].strip()

        # Remove "Thought:" prefix if present
        if text.startswith("Thought:"):
            text = text[8:].strip()

        return text if text else None

    @staticmethod
    def trace_to_gradio_messages(trace: dict | list) -> list:
        """
        Convert a trace JSON to a list of gr.ChatMessage objects.

        Supports multiple formats:
        1. Export format with 'messages' field (from our export)
        2. Original format with 'reasoning_trace' containing 'model_output' and 'code'
        3. Script trace format with 'reasoning_trace' containing 'llm_output' and 'tool_calls'
        4. Raw list format where the trace itself is a list of steps

        Args:
            trace: Dictionary containing trace data, or a list of steps directly

        Returns:
            List of gr.ChatMessage objects
        """
        import gradio as gr

        messages = []

        # Format 4: If trace is a list, it's a raw list of steps
        if isinstance(trace, list):
            reasoning_trace = trace
            response = None
            # Check if the last step has a final answer
            if reasoning_trace:
                last_step = reasoning_trace[-1]
                if last_step.get("is_final_answer"):
                    # Try to extract response from observations or code output
                    obs = last_step.get("observations", "")
                    if "final_answer(" in last_step.get("code", ""):
                        # Extract the argument from final_answer() call
                        import re
                        match = re.search(r"final_answer\(([^)]+)\)", last_step.get("code", ""))
                        if match:
                            response = match.group(1).strip().strip("'\"")
        else:
            # Format 1: If we have pre-serialized messages (from our export), use them
            if "messages" in trace and trace["messages"]:
                for msg_data in trace["messages"]:
                    messages.append(gr.ChatMessage(
                        role=msg_data.get("role", "assistant"),
                        content=msg_data.get("content", ""),
                        metadata=msg_data.get("metadata", {"status": "done"}),
                    ))
                return messages

            # Format 2 & 3: Convert from reasoning_trace format
            reasoning_trace = trace.get("reasoning_trace", [])
            response = trace.get("response")

        # Extract initial task - check top-level 'task' field first, then first step
        task = None
        if isinstance(trace, dict):
            task = trace.get("task")
        if not task and reasoning_trace and "task" in reasoning_trace[0]:
            task = reasoning_trace[0]["task"]
        if task:
            messages.append(gr.ChatMessage(
                role="user",
                content=task,
                metadata={"status": "done"},
            ))

        # Process each step
        for step in reasoning_trace:
            step_num = step.get("step", "?")

            # Step header
            messages.append(gr.ChatMessage(
                role="assistant",
                content=f"**Step {step_num}**",
                metadata={"status": "done"},
            ))

            # Model output (thinking/reasoning) - check both 'model_output' and 'llm_output'
            model_output = step.get("model_output") or step.get("llm_output")
            if model_output:
                thought_text = ExtendedGradioUI._clean_llm_output(model_output)
                if thought_text:
                    messages.append(gr.ChatMessage(
                        role="assistant",
                        content=thought_text,
                        metadata={"status": "done"},
                    ))

            # Code execution - check both 'code' and 'tool_calls'
            code_content = step.get("code")
            if not code_content and "tool_calls" in step:
                code_content = ExtendedGradioUI._extract_code_from_tool_calls(step["tool_calls"])

            if code_content:
                code_content = code_content.strip()
                messages.append(gr.ChatMessage(
                    role="assistant",
                    content=f"```python\n{code_content}\n```",
                    metadata={"title": "Used tool python_interpreter", "status": "done"},
                ))

            # Execution logs/observations
            if "observations" in step and step["observations"]:
                observations = step["observations"].strip()
                # Clean up "Execution logs:" prefix if present
                if observations.startswith("Execution logs:"):
                    observations = observations[15:].strip()
                if observations:
                    messages.append(gr.ChatMessage(
                        role="assistant",
                        content=f"```bash\n{observations}\n```",
                        metadata={"title": "Execution Logs", "status": "done"},
                    ))

            # Error handling (some formats use 'error' field instead of/in addition to observations)
            if "error" in step and step["error"]:
                error_info = step["error"]
                if isinstance(error_info, dict):
                    error_msg = error_info.get("message", str(error_info))
                    error_type = error_info.get("type", "Error")
                    error_text = f"{error_type}: {error_msg}"
                else:
                    error_text = str(error_info)
                messages.append(gr.ChatMessage(
                    role="assistant",
                    content=f"```\n{error_text}\n```",
                    metadata={"title": "Error", "status": "done"},
                ))

            # Token usage footnote
            token_info = ""
            if "token_usage" in step and step["token_usage"]:
                tu = step["token_usage"]
                input_tokens = tu.get("input", tu.get("input_tokens", 0))
                output_tokens = tu.get("output", tu.get("output_tokens", 0))
                token_info = f" | Input: {input_tokens:,} | Output: {output_tokens:,}"

            messages.append(gr.ChatMessage(
                role="assistant",
                content=f'<span style="color: #bbbbc2; font-size: 12px;">**Step {step_num}**{token_info}</span>',
                metadata={"status": "done"},
            ))

            # Separator
            messages.append(gr.ChatMessage(
                role="assistant",
                content="-----",
                metadata={"status": "done"},
            ))

        # Final answer
        if response:
            messages.append(gr.ChatMessage(
                role="assistant",
                content=f"**Final answer:** {response}",
                metadata={"status": "done"},
            ))

        return messages


__all__ = ["ExtendedGradioUI"]
