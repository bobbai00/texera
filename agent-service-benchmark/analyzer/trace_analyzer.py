# -*- coding: utf-8 -*-
"""
Trace Analyzer for Agent Service Benchmark

Analyzes trace.json files to extract token usage metrics including:
- Input/output tokens
- Total tokens
- Step counts
- Per-step token breakdown
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Any, Optional
import statistics


@dataclass
class TraceMetrics:
    """Metrics extracted from a single trace.json file."""
    # Token counts
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0

    # Step metrics
    step_count: int = 0

    # Tool usage counts by tool name
    tool_usage: Dict[str, int] = field(default_factory=dict)
    total_tool_calls: int = 0

    # Timing
    start_time: Optional[int] = None
    end_time: Optional[int] = None
    duration_ms: int = 0

    # Status
    status: str = ""
    error_message: Optional[str] = None

    # Parse error
    parse_error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
            "step_count": self.step_count,
            "tool_usage": self.tool_usage,
            "total_tool_calls": self.total_tool_calls,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "duration_ms": self.duration_ms,
            "status": self.status,
            "error_message": self.error_message,
            "parse_error": self.parse_error,
        }


@dataclass
class AggregatedTokenMetrics:
    """Aggregated token metrics across multiple traces.

    Note: Output tokens from traces are unreliable (only capture final response),
    so we focus primarily on input tokens for analysis.
    """
    # Task counts
    total_tasks: int = 0
    successful_tasks: int = 0
    errored_tasks: int = 0

    # Input token stats (primary metric - reliable)
    total_input_tokens: int = 0
    avg_input_tokens: float = 0.0
    min_input_tokens: int = 0
    max_input_tokens: int = 0
    median_input_tokens: float = 0.0

    # Step stats
    total_steps: int = 0
    avg_steps: float = 0.0
    min_steps: int = 0
    max_steps: int = 0

    # Input tokens per step
    avg_input_tokens_per_step: float = 0.0

    # Duration stats (in seconds)
    total_duration: float = 0.0
    avg_duration: float = 0.0
    min_duration: float = 0.0
    max_duration: float = 0.0

    # Tool usage stats
    total_tool_calls: int = 0
    avg_tool_calls: float = 0.0
    min_tool_calls: int = 0
    max_tool_calls: int = 0
    tool_usage_totals: Dict[str, int] = field(default_factory=dict)  # Total calls per tool type
    tool_usage_avg: Dict[str, float] = field(default_factory=dict)  # Avg calls per task per tool type

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "total_tasks": self.total_tasks,
            "successful_tasks": self.successful_tasks,
            "errored_tasks": self.errored_tasks,
            "total_input_tokens": self.total_input_tokens,
            "avg_input_tokens": self.avg_input_tokens,
            "min_input_tokens": self.min_input_tokens,
            "max_input_tokens": self.max_input_tokens,
            "median_input_tokens": self.median_input_tokens,
            "total_steps": self.total_steps,
            "avg_steps": self.avg_steps,
            "min_steps": self.min_steps,
            "max_steps": self.max_steps,
            "avg_input_tokens_per_step": self.avg_input_tokens_per_step,
            "total_duration": self.total_duration,
            "avg_duration": self.avg_duration,
            "min_duration": self.min_duration,
            "max_duration": self.max_duration,
            "total_tool_calls": self.total_tool_calls,
            "avg_tool_calls": self.avg_tool_calls,
            "min_tool_calls": self.min_tool_calls,
            "max_tool_calls": self.max_tool_calls,
            "tool_usage_totals": self.tool_usage_totals,
            "tool_usage_avg": self.tool_usage_avg,
        }


class TraceAnalyzer:
    """Analyzes trace.json files."""

    def __init__(self, trace_path: Path):
        """
        Initialize with a trace.json file path.

        Args:
            trace_path: Path to the trace.json file
        """
        self.trace_path = Path(trace_path)
        self.trace_data: Dict[str, Any] = {}

    def analyze(self) -> TraceMetrics:
        """
        Analyze the trace file and return metrics.

        Returns:
            TraceMetrics object with extracted metrics
        """
        metrics = TraceMetrics()

        try:
            with open(self.trace_path) as f:
                self.trace_data = json.load(f)
        except Exception as e:
            metrics.parse_error = str(e)
            return metrics

        # Extract from 'usage' section
        usage = self.trace_data.get("usage", {})
        metrics.input_tokens = usage.get("inputTokens", 0)
        metrics.output_tokens = usage.get("outputTokens", 0)
        metrics.total_tokens = usage.get("totalTokens", 0)

        # Extract from 'stats' section
        stats = self.trace_data.get("stats", {})
        metrics.step_count = stats.get("stepCount", 0)
        metrics.status = stats.get("status", "")
        metrics.error_message = stats.get("errorMessage")
        metrics.start_time = stats.get("startTime")
        metrics.end_time = stats.get("endTime")

        # Calculate duration
        if metrics.start_time and metrics.end_time:
            metrics.duration_ms = metrics.end_time - metrics.start_time

        # If usage tokens are 0 but stats has them, use stats
        if metrics.total_tokens == 0:
            metrics.input_tokens = stats.get("totalInputTokens", 0)
            metrics.output_tokens = stats.get("totalOutputTokens", 0)
            metrics.total_tokens = stats.get("totalTokens", 0)

        # Extract tool usage from messages
        metrics.tool_usage = self._extract_tool_usage()
        metrics.total_tool_calls = sum(metrics.tool_usage.values())

        return metrics

    def _extract_tool_usage(self) -> Dict[str, int]:
        """
        Extract tool usage counts from trace messages.

        Returns:
            Dictionary mapping tool names to call counts
        """
        tool_usage: Dict[str, int] = {}
        messages = self.trace_data.get("messages", [])

        for msg in messages:
            content = msg.get("content", [])
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "tool-call":
                        tool_name = item.get("toolName", "unknown")
                        tool_usage[tool_name] = tool_usage.get(tool_name, 0) + 1

        return tool_usage


def analyze_trace(trace_path: str) -> TraceMetrics:
    """
    Convenience function to analyze a single trace file.

    Args:
        trace_path: Path to trace.json file

    Returns:
        TraceMetrics object
    """
    analyzer = TraceAnalyzer(Path(trace_path))
    return analyzer.analyze()


def aggregate_trace_metrics(metrics_list: List[TraceMetrics]) -> AggregatedTokenMetrics:
    """
    Aggregate metrics from multiple traces.

    Args:
        metrics_list: List of TraceMetrics objects

    Returns:
        AggregatedTokenMetrics object
    """
    agg = AggregatedTokenMetrics()

    if not metrics_list:
        return agg

    agg.total_tasks = len(metrics_list)

    # Collect values for stats (only from successful parses with tokens)
    # Note: We focus on input tokens as output tokens are unreliable
    input_tokens_list = []
    steps_list = []
    durations_list = []
    tool_calls_list = []
    tool_usage_totals: Dict[str, int] = {}

    for m in metrics_list:
        if m.parse_error:
            continue

        if m.status == "error":
            agg.errored_tasks += 1
        else:
            agg.successful_tasks += 1

        # Only include non-zero input token counts in statistics
        if m.input_tokens > 0:
            input_tokens_list.append(m.input_tokens)

        if m.step_count > 0:
            steps_list.append(m.step_count)

        if m.duration_ms > 0:
            durations_list.append(m.duration_ms / 1000.0)  # Convert to seconds

        # Tool usage
        if m.total_tool_calls > 0:
            tool_calls_list.append(m.total_tool_calls)
        for tool_name, count in m.tool_usage.items():
            tool_usage_totals[tool_name] = tool_usage_totals.get(tool_name, 0) + count

    # Input token statistics (primary metric)
    if input_tokens_list:
        agg.total_input_tokens = sum(input_tokens_list)
        agg.avg_input_tokens = statistics.mean(input_tokens_list)
        agg.min_input_tokens = min(input_tokens_list)
        agg.max_input_tokens = max(input_tokens_list)
        agg.median_input_tokens = statistics.median(input_tokens_list)

    # Step statistics
    if steps_list:
        agg.total_steps = sum(steps_list)
        agg.avg_steps = statistics.mean(steps_list)
        agg.min_steps = min(steps_list)
        agg.max_steps = max(steps_list)

    # Input tokens per step
    if agg.total_steps > 0:
        agg.avg_input_tokens_per_step = agg.total_input_tokens / agg.total_steps

    # Duration statistics
    if durations_list:
        agg.total_duration = sum(durations_list)
        agg.avg_duration = statistics.mean(durations_list)
        agg.min_duration = min(durations_list)
        agg.max_duration = max(durations_list)

    # Tool usage statistics
    if tool_calls_list:
        agg.total_tool_calls = sum(tool_calls_list)
        agg.avg_tool_calls = statistics.mean(tool_calls_list)
        agg.min_tool_calls = min(tool_calls_list)
        agg.max_tool_calls = max(tool_calls_list)

    agg.tool_usage_totals = tool_usage_totals
    # Calculate average per task for each tool type
    tasks_with_tools = len(tool_calls_list) if tool_calls_list else 1
    agg.tool_usage_avg = {
        tool: count / tasks_with_tools
        for tool, count in tool_usage_totals.items()
    }

    return agg


def print_token_metrics(agg: AggregatedTokenMetrics, title: str = "Token Metrics"):
    """
    Print aggregated token metrics in a readable format.

    Note: We focus on input tokens as output tokens from traces are unreliable
    (only capture final response, not intermediate outputs).

    Args:
        agg: AggregatedTokenMetrics object
        title: Section title
    """
    print(f"\n{'='*30} {title} {'='*30}")
    print(f"  Tasks:            {agg.total_tasks} ({agg.successful_tasks} ok, {agg.errored_tasks} err)")

    print(f"\n  Input Tokens:")
    print(f"    Total:          {agg.total_input_tokens:,}")
    print(f"    Avg:            {agg.avg_input_tokens:,.1f}")
    print(f"    Min/Max:        {agg.min_input_tokens:,} / {agg.max_input_tokens:,}")
    print(f"    Median:         {agg.median_input_tokens:,.1f}")

    print(f"\n  Steps:")
    print(f"    Total:          {agg.total_steps:,}")
    print(f"    Avg:            {agg.avg_steps:.1f}")
    print(f"    Min/Max:        {agg.min_steps} / {agg.max_steps}")
    print(f"    Tokens/Step:    {agg.avg_input_tokens_per_step:,.1f}")

    if agg.total_duration > 0:
        print(f"\n  Duration:")
        print(f"    Total:          {agg.total_duration:.1f}s ({agg.total_duration/60:.1f}m)")
        print(f"    Avg:            {agg.avg_duration:.1f}s")
        print(f"    Min/Max:        {agg.min_duration:.1f}s / {agg.max_duration:.1f}s")

    if agg.total_tool_calls > 0:
        print(f"\n  Tool Usage:")
        print(f"    Total calls:    {agg.total_tool_calls:,}")
        print(f"    Avg per task:   {agg.avg_tool_calls:.1f}")
        print(f"    Min/Max:        {agg.min_tool_calls} / {agg.max_tool_calls}")
        print(f"    By tool type:")
        for tool, count in sorted(agg.tool_usage_totals.items(), key=lambda x: -x[1]):
            avg = agg.tool_usage_avg.get(tool, 0)
            print(f"      {tool}: {count:,} (avg {avg:.1f}/task)")
