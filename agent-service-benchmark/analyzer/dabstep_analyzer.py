# -*- coding: utf-8 -*-
"""
DABstep Benchmark Analyzer

Analyzes DABstep benchmark runs including:
- Per-task workflow metrics
- Aggregated statistics across all tasks
- Extreme instances (most operators, links, etc.)
- Grouping by task difficulty or other categories
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple
from collections import defaultdict
import statistics

from .workflow_analyzer import WorkflowMetrics, analyze_workflow
from .trace_analyzer import TraceMetrics, AggregatedTokenMetrics, analyze_trace, aggregate_trace_metrics


# Task difficulty threshold: tasks 1-72 are "easy", 73+ are "hard"
EASY_TASK_THRESHOLD = 72


def get_task_difficulty(task_id: str) -> str:
    """
    Determine task difficulty based on task ID.

    Args:
        task_id: The task ID string

    Returns:
        "easy" for tasks 1-72, "hard" for tasks 73+
    """
    try:
        task_num = int(task_id)
        return "easy" if task_num <= EASY_TASK_THRESHOLD else "hard"
    except ValueError:
        return "unknown"


@dataclass
class DifficultyMetrics:
    """Metrics for a specific difficulty level (easy/hard)."""
    difficulty: str = ""
    task_count: int = 0
    successful_tasks: int = 0
    errored_tasks: int = 0

    # Accuracy
    scored_tasks: int = 0
    accuracy: float = 0.0
    correct_count: int = 0

    # Operator stats
    total_operators: int = 0
    avg_operators: float = 0.0
    min_operators: int = 0
    max_operators: int = 0

    # Link stats
    total_links: int = 0
    avg_links: float = 0.0
    min_links: int = 0
    max_links: int = 0

    # Time stats
    avg_elapsed: float = 0.0
    min_elapsed: float = 0.0
    max_elapsed: float = 0.0

    # Shape distribution
    shape_counts: Dict[str, int] = field(default_factory=dict)

    # Input token stats (output tokens are unreliable in traces)
    total_input_tokens: int = 0
    avg_input_tokens: float = 0.0
    min_input_tokens: int = 0
    max_input_tokens: int = 0

    # Step stats
    total_steps: int = 0
    avg_steps: float = 0.0
    min_steps: int = 0
    max_steps: int = 0

    # Tool usage stats
    total_tool_calls: int = 0
    avg_tool_calls: float = 0.0
    min_tool_calls: int = 0
    max_tool_calls: int = 0
    tool_usage_totals: Dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "difficulty": self.difficulty,
            "task_count": self.task_count,
            "successful_tasks": self.successful_tasks,
            "errored_tasks": self.errored_tasks,
            "scored_tasks": self.scored_tasks,
            "accuracy": self.accuracy,
            "correct_count": self.correct_count,
            "total_operators": self.total_operators,
            "avg_operators": self.avg_operators,
            "min_operators": self.min_operators,
            "max_operators": self.max_operators,
            "total_links": self.total_links,
            "avg_links": self.avg_links,
            "min_links": self.min_links,
            "max_links": self.max_links,
            "avg_elapsed": self.avg_elapsed,
            "min_elapsed": self.min_elapsed,
            "max_elapsed": self.max_elapsed,
            "shape_counts": self.shape_counts,
            "total_input_tokens": self.total_input_tokens,
            "avg_input_tokens": self.avg_input_tokens,
            "min_input_tokens": self.min_input_tokens,
            "max_input_tokens": self.max_input_tokens,
            "total_steps": self.total_steps,
            "avg_steps": self.avg_steps,
            "min_steps": self.min_steps,
            "max_steps": self.max_steps,
            "total_tool_calls": self.total_tool_calls,
            "avg_tool_calls": self.avg_tool_calls,
            "min_tool_calls": self.min_tool_calls,
            "max_tool_calls": self.max_tool_calls,
            "tool_usage_totals": self.tool_usage_totals,
        }


@dataclass
class TaskAnalysis:
    """Analysis results for a single task."""
    task_id: str
    answer: str = ""
    expected: str = ""
    error: Optional[str] = None
    elapsed: float = 0.0
    score: Optional[float] = None
    workflow_metrics: Optional[WorkflowMetrics] = None
    trace_metrics: Optional[TraceMetrics] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "task_id": self.task_id,
            "answer": self.answer,
            "expected": self.expected,
            "error": self.error,
            "elapsed": self.elapsed,
            "score": self.score,
            "workflow_metrics": self.workflow_metrics.to_dict() if self.workflow_metrics else None,
            "trace_metrics": self.trace_metrics.to_dict() if self.trace_metrics else None,
        }


@dataclass
class AggregatedMetrics:
    """Aggregated metrics across multiple tasks."""
    # Task counts
    total_tasks: int = 0
    successful_tasks: int = 0
    errored_tasks: int = 0
    scored_tasks: int = 0

    # Accuracy
    accuracy: float = 0.0
    correct_count: int = 0

    # Time stats
    total_elapsed: float = 0.0
    avg_elapsed: float = 0.0
    min_elapsed: float = 0.0
    max_elapsed: float = 0.0

    # Operator stats
    total_operators: int = 0
    avg_operators: float = 0.0
    min_operators: int = 0
    max_operators: int = 0
    operator_type_counts: Dict[str, int] = field(default_factory=dict)

    # Link stats
    total_links: int = 0
    avg_links: float = 0.0
    min_links: int = 0
    max_links: int = 0

    # DAG shape distribution
    shape_counts: Dict[str, int] = field(default_factory=dict)

    # Depth stats
    avg_max_depth: float = 0.0
    max_max_depth: int = 0

    # Component stats
    avg_components: float = 0.0
    max_components: int = 0

    # Input token stats (output tokens are unreliable in traces)
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
    avg_input_tokens_per_step: float = 0.0

    # Tool usage stats
    total_tool_calls: int = 0
    avg_tool_calls: float = 0.0
    min_tool_calls: int = 0
    max_tool_calls: int = 0
    tool_usage_totals: Dict[str, int] = field(default_factory=dict)
    tool_usage_avg: Dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "total_tasks": self.total_tasks,
            "successful_tasks": self.successful_tasks,
            "errored_tasks": self.errored_tasks,
            "scored_tasks": self.scored_tasks,
            "accuracy": self.accuracy,
            "correct_count": self.correct_count,
            "total_elapsed": self.total_elapsed,
            "avg_elapsed": self.avg_elapsed,
            "min_elapsed": self.min_elapsed,
            "max_elapsed": self.max_elapsed,
            "total_operators": self.total_operators,
            "avg_operators": self.avg_operators,
            "min_operators": self.min_operators,
            "max_operators": self.max_operators,
            "operator_type_counts": self.operator_type_counts,
            "total_links": self.total_links,
            "avg_links": self.avg_links,
            "min_links": self.min_links,
            "max_links": self.max_links,
            "shape_counts": self.shape_counts,
            "avg_max_depth": self.avg_max_depth,
            "max_max_depth": self.max_max_depth,
            "avg_components": self.avg_components,
            "max_components": self.max_components,
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
            "total_tool_calls": self.total_tool_calls,
            "avg_tool_calls": self.avg_tool_calls,
            "min_tool_calls": self.min_tool_calls,
            "max_tool_calls": self.max_tool_calls,
            "tool_usage_totals": self.tool_usage_totals,
            "tool_usage_avg": self.tool_usage_avg,
        }


@dataclass
class ExtremeInstances:
    """Extreme instances (min/max) for various metrics."""
    most_operators: List[Tuple[str, int]] = field(default_factory=list)  # (task_id, count)
    fewest_operators: List[Tuple[str, int]] = field(default_factory=list)
    most_links: List[Tuple[str, int]] = field(default_factory=list)
    fewest_links: List[Tuple[str, int]] = field(default_factory=list)
    deepest: List[Tuple[str, int]] = field(default_factory=list)  # max_depth
    longest_elapsed: List[Tuple[str, float]] = field(default_factory=list)
    shortest_elapsed: List[Tuple[str, float]] = field(default_factory=list)
    most_components: List[Tuple[str, int]] = field(default_factory=list)
    most_input_tokens: List[Tuple[str, int]] = field(default_factory=list)  # (task_id, input_tokens)
    fewest_input_tokens: List[Tuple[str, int]] = field(default_factory=list)
    most_steps: List[Tuple[str, int]] = field(default_factory=list)
    most_tool_calls: List[Tuple[str, int]] = field(default_factory=list)  # (task_id, tool_calls)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "most_operators": [{"task_id": t, "count": c} for t, c in self.most_operators],
            "fewest_operators": [{"task_id": t, "count": c} for t, c in self.fewest_operators],
            "most_links": [{"task_id": t, "count": c} for t, c in self.most_links],
            "fewest_links": [{"task_id": t, "count": c} for t, c in self.fewest_links],
            "deepest": [{"task_id": t, "depth": d} for t, d in self.deepest],
            "longest_elapsed": [{"task_id": t, "elapsed": e} for t, e in self.longest_elapsed],
            "shortest_elapsed": [{"task_id": t, "elapsed": e} for t, e in self.shortest_elapsed],
            "most_components": [{"task_id": t, "count": c} for t, c in self.most_components],
            "most_input_tokens": [{"task_id": t, "input_tokens": c} for t, c in self.most_input_tokens],
            "fewest_input_tokens": [{"task_id": t, "input_tokens": c} for t, c in self.fewest_input_tokens],
            "most_steps": [{"task_id": t, "steps": c} for t, c in self.most_steps],
            "most_tool_calls": [{"task_id": t, "tool_calls": c} for t, c in self.most_tool_calls],
        }


@dataclass
class DABstepAnalysis:
    """Complete analysis of a DABstep benchmark run."""
    run_dir: str
    config: Dict[str, Any] = field(default_factory=dict)
    task_analyses: List[TaskAnalysis] = field(default_factory=list)
    aggregated: AggregatedMetrics = field(default_factory=AggregatedMetrics)
    extremes: ExtremeInstances = field(default_factory=ExtremeInstances)
    easy_metrics: DifficultyMetrics = field(default_factory=lambda: DifficultyMetrics(difficulty="easy"))
    hard_metrics: DifficultyMetrics = field(default_factory=lambda: DifficultyMetrics(difficulty="hard"))

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "run_dir": self.run_dir,
            "config": self.config,
            "aggregated": self.aggregated.to_dict(),
            "easy_metrics": self.easy_metrics.to_dict(),
            "hard_metrics": self.hard_metrics.to_dict(),
            "extremes": self.extremes.to_dict(),
            "task_analyses": [t.to_dict() for t in self.task_analyses],
        }


class DABstepAnalyzer:
    """Analyzes a DABstep benchmark run directory."""

    def __init__(self, run_dir: Path, top_n: int = 5):
        """
        Initialize with a run directory.

        Args:
            run_dir: Path to the benchmark run directory
            top_n: Number of extreme instances to track
        """
        self.run_dir = Path(run_dir)
        self.top_n = top_n
        self.config: Dict[str, Any] = {}
        self.task_analyses: List[TaskAnalysis] = []

    def analyze(self) -> DABstepAnalysis:
        """
        Analyze the benchmark run.

        Returns:
            DABstepAnalysis object with all results
        """
        # Load config
        self._load_config()

        # Analyze each task
        self._analyze_tasks()

        # Compute aggregated metrics
        aggregated = self._compute_aggregated()

        # Compute difficulty-based metrics
        easy_metrics, hard_metrics = self._compute_difficulty_metrics()

        # Find extreme instances
        extremes = self._find_extremes()

        return DABstepAnalysis(
            run_dir=str(self.run_dir),
            config=self.config,
            task_analyses=self.task_analyses,
            aggregated=aggregated,
            extremes=extremes,
            easy_metrics=easy_metrics,
            hard_metrics=hard_metrics,
        )

    def _load_config(self):
        """Load the run configuration."""
        config_file = self.run_dir / "config.json"
        if config_file.exists():
            with open(config_file) as f:
                self.config = json.load(f)

    def _analyze_tasks(self):
        """Analyze each task in the run directory."""
        for task_dir in sorted(self.run_dir.iterdir()):
            if not task_dir.is_dir() or not task_dir.name.startswith("task_"):
                continue

            task_id = task_dir.name.replace("task_", "")
            task_analysis = TaskAnalysis(task_id=task_id)

            # Load result.json
            result_file = task_dir / "result.json"
            if result_file.exists():
                with open(result_file) as f:
                    result = json.load(f)
                task_analysis.answer = result.get("answer", "")
                task_analysis.error = result.get("error")
                task_analysis.elapsed = result.get("elapsed", 0.0)
                task_analysis.score = result.get("score")

            # Load expected answer
            expected_file = task_dir / "expected.txt"
            if expected_file.exists():
                task_analysis.expected = expected_file.read_text().strip()

            # Analyze workflow
            workflow_file = task_dir / "workflow.json"
            if workflow_file.exists():
                try:
                    with open(workflow_file) as f:
                        workflow = json.load(f)
                    task_analysis.workflow_metrics = analyze_workflow(workflow)
                except Exception as e:
                    # Create empty metrics with error
                    task_analysis.workflow_metrics = WorkflowMetrics(error=str(e))

            # Analyze trace
            trace_file = task_dir / "trace.json"
            if trace_file.exists():
                try:
                    task_analysis.trace_metrics = analyze_trace(str(trace_file))
                except Exception as e:
                    # Create empty metrics with error
                    task_analysis.trace_metrics = TraceMetrics(parse_error=str(e))

            self.task_analyses.append(task_analysis)

    def _compute_aggregated(self) -> AggregatedMetrics:
        """Compute aggregated metrics across all tasks."""
        agg = AggregatedMetrics()

        if not self.task_analyses:
            return agg

        agg.total_tasks = len(self.task_analyses)

        # Collect values for stats
        elapsed_times = []
        operator_counts = []
        link_counts = []
        max_depths = []
        component_counts = []
        operator_type_totals: Dict[str, int] = defaultdict(int)
        shape_counts: Dict[str, int] = defaultdict(int)
        scores = []
        input_tokens_list = []
        steps_list = []
        tool_calls_list = []
        tool_usage_totals: Dict[str, int] = {}

        for ta in self.task_analyses:
            # Error tracking
            if ta.error:
                agg.errored_tasks += 1
            else:
                agg.successful_tasks += 1

            # Elapsed time
            if ta.elapsed > 0:
                elapsed_times.append(ta.elapsed)

            # Score tracking
            if ta.score is not None:
                scores.append(ta.score)
                agg.scored_tasks += 1
                if ta.score == 1:
                    agg.correct_count += 1

            # Workflow metrics
            if ta.workflow_metrics and not ta.workflow_metrics.error:
                wm = ta.workflow_metrics
                operator_counts.append(wm.num_operators)
                link_counts.append(wm.num_links)
                max_depths.append(wm.max_depth)
                component_counts.append(wm.num_components)
                shape_counts[wm.shape] += 1

                for op_type, count in wm.operator_counts.items():
                    operator_type_totals[op_type] += count

            # Trace metrics (focus on input tokens as output tokens are unreliable)
            if ta.trace_metrics and not ta.trace_metrics.parse_error:
                tm = ta.trace_metrics
                if tm.input_tokens > 0:
                    input_tokens_list.append(tm.input_tokens)
                if tm.step_count > 0:
                    steps_list.append(tm.step_count)
                if tm.total_tool_calls > 0:
                    tool_calls_list.append(tm.total_tool_calls)
                for tool_name, count in tm.tool_usage.items():
                    tool_usage_totals[tool_name] = tool_usage_totals.get(tool_name, 0) + count

        # Time stats
        if elapsed_times:
            agg.total_elapsed = sum(elapsed_times)
            agg.avg_elapsed = statistics.mean(elapsed_times)
            agg.min_elapsed = min(elapsed_times)
            agg.max_elapsed = max(elapsed_times)

        # Accuracy
        if scores:
            agg.accuracy = sum(scores) / len(scores)

        # Operator stats
        if operator_counts:
            agg.total_operators = sum(operator_counts)
            agg.avg_operators = statistics.mean(operator_counts)
            agg.min_operators = min(operator_counts)
            agg.max_operators = max(operator_counts)
            agg.operator_type_counts = dict(operator_type_totals)

        # Link stats
        if link_counts:
            agg.total_links = sum(link_counts)
            agg.avg_links = statistics.mean(link_counts)
            agg.min_links = min(link_counts)
            agg.max_links = max(link_counts)

        # Shape distribution
        agg.shape_counts = dict(shape_counts)

        # Depth stats
        if max_depths:
            agg.avg_max_depth = statistics.mean(max_depths)
            agg.max_max_depth = max(max_depths)

        # Component stats
        if component_counts:
            agg.avg_components = statistics.mean(component_counts)
            agg.max_components = max(component_counts)

        # Input token stats (output tokens are unreliable)
        if input_tokens_list:
            agg.total_input_tokens = sum(input_tokens_list)
            agg.avg_input_tokens = statistics.mean(input_tokens_list)
            agg.min_input_tokens = min(input_tokens_list)
            agg.max_input_tokens = max(input_tokens_list)
            agg.median_input_tokens = statistics.median(input_tokens_list)

        # Step stats
        if steps_list:
            agg.total_steps = sum(steps_list)
            agg.avg_steps = statistics.mean(steps_list)
            agg.min_steps = min(steps_list)
            agg.max_steps = max(steps_list)

        # Input tokens per step
        if agg.total_steps > 0:
            agg.avg_input_tokens_per_step = agg.total_input_tokens / agg.total_steps

        # Tool usage stats
        if tool_calls_list:
            agg.total_tool_calls = sum(tool_calls_list)
            agg.avg_tool_calls = statistics.mean(tool_calls_list)
            agg.min_tool_calls = min(tool_calls_list)
            agg.max_tool_calls = max(tool_calls_list)

        agg.tool_usage_totals = tool_usage_totals
        tasks_with_tools = len(tool_calls_list) if tool_calls_list else 1
        agg.tool_usage_avg = {
            tool: count / tasks_with_tools
            for tool, count in tool_usage_totals.items()
        }

        return agg

    def _compute_difficulty_metrics(self) -> Tuple[DifficultyMetrics, DifficultyMetrics]:
        """Compute metrics grouped by task difficulty (easy vs hard)."""
        easy = DifficultyMetrics(difficulty="easy")
        hard = DifficultyMetrics(difficulty="hard")

        if not self.task_analyses:
            return easy, hard

        # Collect values by difficulty
        easy_ops, hard_ops = [], []
        easy_links, hard_links = [], []
        easy_elapsed, hard_elapsed = [], []
        easy_scores, hard_scores = [], []
        easy_shapes: Dict[str, int] = defaultdict(int)
        hard_shapes: Dict[str, int] = defaultdict(int)
        easy_input_tokens, hard_input_tokens = [], []
        easy_steps, hard_steps = [], []
        easy_tool_calls, hard_tool_calls = [], []
        easy_tool_usage: Dict[str, int] = {}
        hard_tool_usage: Dict[str, int] = {}

        for ta in self.task_analyses:
            difficulty = get_task_difficulty(ta.task_id)
            metrics = easy if difficulty == "easy" else hard
            ops_list = easy_ops if difficulty == "easy" else hard_ops
            links_list = easy_links if difficulty == "easy" else hard_links
            elapsed_list = easy_elapsed if difficulty == "easy" else hard_elapsed
            scores_list = easy_scores if difficulty == "easy" else hard_scores
            shapes_dict = easy_shapes if difficulty == "easy" else hard_shapes
            input_tokens_list = easy_input_tokens if difficulty == "easy" else hard_input_tokens
            steps_list = easy_steps if difficulty == "easy" else hard_steps
            tool_calls_list = easy_tool_calls if difficulty == "easy" else hard_tool_calls
            tool_usage_dict = easy_tool_usage if difficulty == "easy" else hard_tool_usage

            metrics.task_count += 1

            if ta.error:
                metrics.errored_tasks += 1
            else:
                metrics.successful_tasks += 1

            if ta.elapsed > 0:
                elapsed_list.append(ta.elapsed)

            if ta.score is not None:
                scores_list.append(ta.score)
                metrics.scored_tasks += 1
                if ta.score == 1:
                    metrics.correct_count += 1

            if ta.workflow_metrics and not ta.workflow_metrics.error:
                wm = ta.workflow_metrics
                ops_list.append(wm.num_operators)
                links_list.append(wm.num_links)
                shapes_dict[wm.shape] += 1

            if ta.trace_metrics and not ta.trace_metrics.parse_error:
                tm = ta.trace_metrics
                if tm.input_tokens > 0:
                    input_tokens_list.append(tm.input_tokens)
                if tm.step_count > 0:
                    steps_list.append(tm.step_count)
                if tm.total_tool_calls > 0:
                    tool_calls_list.append(tm.total_tool_calls)
                for tool_name, count in tm.tool_usage.items():
                    tool_usage_dict[tool_name] = tool_usage_dict.get(tool_name, 0) + count

        # Compute stats for easy tasks
        if easy_ops:
            easy.total_operators = sum(easy_ops)
            easy.avg_operators = statistics.mean(easy_ops)
            easy.min_operators = min(easy_ops)
            easy.max_operators = max(easy_ops)
        if easy_links:
            easy.total_links = sum(easy_links)
            easy.avg_links = statistics.mean(easy_links)
            easy.min_links = min(easy_links)
            easy.max_links = max(easy_links)
        if easy_elapsed:
            easy.avg_elapsed = statistics.mean(easy_elapsed)
            easy.min_elapsed = min(easy_elapsed)
            easy.max_elapsed = max(easy_elapsed)
        if easy_scores:
            easy.accuracy = sum(easy_scores) / len(easy_scores)
        easy.shape_counts = dict(easy_shapes)
        # Token stats for easy tasks (focus on input tokens as output tokens are unreliable)
        if easy_input_tokens:
            easy.total_input_tokens = sum(easy_input_tokens)
            easy.avg_input_tokens = statistics.mean(easy_input_tokens)
            easy.min_input_tokens = min(easy_input_tokens)
            easy.max_input_tokens = max(easy_input_tokens)
        if easy_steps:
            easy.total_steps = sum(easy_steps)
            easy.avg_steps = statistics.mean(easy_steps)
            easy.min_steps = min(easy_steps)
            easy.max_steps = max(easy_steps)
        # Tool usage for easy tasks
        if easy_tool_calls:
            easy.total_tool_calls = sum(easy_tool_calls)
            easy.avg_tool_calls = statistics.mean(easy_tool_calls)
            easy.min_tool_calls = min(easy_tool_calls)
            easy.max_tool_calls = max(easy_tool_calls)
        easy.tool_usage_totals = easy_tool_usage

        # Compute stats for hard tasks
        if hard_ops:
            hard.total_operators = sum(hard_ops)
            hard.avg_operators = statistics.mean(hard_ops)
            hard.min_operators = min(hard_ops)
            hard.max_operators = max(hard_ops)
        if hard_links:
            hard.total_links = sum(hard_links)
            hard.avg_links = statistics.mean(hard_links)
            hard.min_links = min(hard_links)
            hard.max_links = max(hard_links)
        if hard_elapsed:
            hard.avg_elapsed = statistics.mean(hard_elapsed)
            hard.min_elapsed = min(hard_elapsed)
            hard.max_elapsed = max(hard_elapsed)
        if hard_scores:
            hard.accuracy = sum(hard_scores) / len(hard_scores)
        hard.shape_counts = dict(hard_shapes)
        # Token stats for hard tasks (focus on input tokens as output tokens are unreliable)
        if hard_input_tokens:
            hard.total_input_tokens = sum(hard_input_tokens)
            hard.avg_input_tokens = statistics.mean(hard_input_tokens)
            hard.min_input_tokens = min(hard_input_tokens)
            hard.max_input_tokens = max(hard_input_tokens)
        if hard_steps:
            hard.total_steps = sum(hard_steps)
            hard.avg_steps = statistics.mean(hard_steps)
            hard.min_steps = min(hard_steps)
            hard.max_steps = max(hard_steps)
        # Tool usage for hard tasks
        if hard_tool_calls:
            hard.total_tool_calls = sum(hard_tool_calls)
            hard.avg_tool_calls = statistics.mean(hard_tool_calls)
            hard.min_tool_calls = min(hard_tool_calls)
            hard.max_tool_calls = max(hard_tool_calls)
        hard.tool_usage_totals = hard_tool_usage

        return easy, hard

    def _find_extremes(self) -> ExtremeInstances:
        """Find extreme instances for various metrics."""
        extremes = ExtremeInstances()

        if not self.task_analyses:
            return extremes

        # Collect (task_id, value) tuples for sorting
        operators = []
        links = []
        depths = []
        elapsed = []
        components = []
        input_tokens = []
        steps = []
        tool_calls = []

        for ta in self.task_analyses:
            if ta.workflow_metrics and not ta.workflow_metrics.error:
                wm = ta.workflow_metrics
                operators.append((ta.task_id, wm.num_operators))
                links.append((ta.task_id, wm.num_links))
                depths.append((ta.task_id, wm.max_depth))
                components.append((ta.task_id, wm.num_components))

            if ta.elapsed > 0 and not ta.error:
                elapsed.append((ta.task_id, ta.elapsed))

            if ta.trace_metrics and not ta.trace_metrics.parse_error:
                tm = ta.trace_metrics
                if tm.input_tokens > 0:
                    input_tokens.append((ta.task_id, tm.input_tokens))
                if tm.step_count > 0:
                    steps.append((ta.task_id, tm.step_count))
                if tm.total_tool_calls > 0:
                    tool_calls.append((ta.task_id, tm.total_tool_calls))

        n = self.top_n

        # Most/fewest operators
        if operators:
            operators_sorted = sorted(operators, key=lambda x: x[1], reverse=True)
            extremes.most_operators = operators_sorted[:n]
            extremes.fewest_operators = sorted(operators, key=lambda x: x[1])[:n]

        # Most/fewest links
        if links:
            links_sorted = sorted(links, key=lambda x: x[1], reverse=True)
            extremes.most_links = links_sorted[:n]
            extremes.fewest_links = sorted(links, key=lambda x: x[1])[:n]

        # Deepest
        if depths:
            extremes.deepest = sorted(depths, key=lambda x: x[1], reverse=True)[:n]

        # Longest/shortest elapsed
        if elapsed:
            elapsed_sorted = sorted(elapsed, key=lambda x: x[1], reverse=True)
            extremes.longest_elapsed = elapsed_sorted[:n]
            extremes.shortest_elapsed = sorted(elapsed, key=lambda x: x[1])[:n]

        # Most components
        if components:
            extremes.most_components = sorted(
                components, key=lambda x: x[1], reverse=True
            )[:n]

        # Most/fewest input tokens
        if input_tokens:
            input_tokens_sorted = sorted(input_tokens, key=lambda x: x[1], reverse=True)
            extremes.most_input_tokens = input_tokens_sorted[:n]
            extremes.fewest_input_tokens = sorted(input_tokens, key=lambda x: x[1])[:n]

        # Most steps
        if steps:
            extremes.most_steps = sorted(steps, key=lambda x: x[1], reverse=True)[:n]

        # Most tool calls
        if tool_calls:
            extremes.most_tool_calls = sorted(tool_calls, key=lambda x: x[1], reverse=True)[:n]

        return extremes


def analyze_run(run_dir: str, top_n: int = 5) -> DABstepAnalysis:
    """
    Convenience function to analyze a benchmark run.

    Args:
        run_dir: Path to the run directory
        top_n: Number of extreme instances to track

    Returns:
        DABstepAnalysis object
    """
    analyzer = DABstepAnalyzer(Path(run_dir), top_n=top_n)
    return analyzer.analyze()


def print_analysis(analysis: DABstepAnalysis, detailed: bool = False):
    """
    Print analysis results in a readable format.

    Args:
        analysis: DABstepAnalysis object
        detailed: Whether to print per-task details
    """
    agg = analysis.aggregated
    ext = analysis.extremes

    print("=" * 70)
    print(f"DABstep Benchmark Analysis")
    print(f"Run Directory: {analysis.run_dir}")
    print("=" * 70)

    # Config summary
    if analysis.config:
        print(f"\nConfiguration:")
        print(f"  Model: {analysis.config.get('model', 'N/A')}")
        print(f"  Split: {analysis.config.get('split', 'N/A')}")
        print(f"  Max Steps: {analysis.config.get('max_steps', 'N/A')}")

    # Task summary
    print(f"\n{'='*30} Task Summary {'='*30}")
    print(f"  Total tasks:      {agg.total_tasks}")
    print(f"  Successful:       {agg.successful_tasks}")
    print(f"  Errored:          {agg.errored_tasks}")
    if agg.scored_tasks > 0:
        print(f"  Scored:           {agg.scored_tasks}")
        print(f"  Accuracy:         {agg.accuracy:.1%} ({agg.correct_count}/{agg.scored_tasks})")

    # Time stats
    print(f"\n{'='*30} Time Stats {'='*30}")
    print(f"  Total time:       {agg.total_elapsed:.1f}s ({agg.total_elapsed/60:.1f}m)")
    print(f"  Avg per task:     {agg.avg_elapsed:.1f}s")
    print(f"  Min/Max:          {agg.min_elapsed:.1f}s / {agg.max_elapsed:.1f}s")

    # Operator stats
    print(f"\n{'='*30} Operator Stats {'='*30}")
    print(f"  Total operators:  {agg.total_operators}")
    print(f"  Avg per task:     {agg.avg_operators:.1f}")
    print(f"  Min/Max:          {agg.min_operators} / {agg.max_operators}")
    if agg.operator_type_counts:
        print(f"  By type:")
        for op_type, count in sorted(agg.operator_type_counts.items(), key=lambda x: -x[1]):
            print(f"    {op_type}: {count}")

    # Link stats
    print(f"\n{'='*30} Link Stats {'='*30}")
    print(f"  Total links:      {agg.total_links}")
    print(f"  Avg per task:     {agg.avg_links:.1f}")
    print(f"  Min/Max:          {agg.min_links} / {agg.max_links}")

    # DAG structure
    print(f"\n{'='*30} DAG Structure {'='*30}")
    print(f"  Avg max depth:    {agg.avg_max_depth:.1f}")
    print(f"  Max depth:        {agg.max_max_depth}")
    print(f"  Avg components:   {agg.avg_components:.1f}")
    print(f"  Max components:   {agg.max_components}")
    if agg.shape_counts:
        print(f"  Shape distribution:")
        for shape, count in sorted(agg.shape_counts.items(), key=lambda x: -x[1]):
            pct = count / agg.total_tasks * 100
            print(f"    {shape}: {count} ({pct:.1f}%)")

    # Token stats (focus on input tokens as output tokens are unreliable)
    if agg.total_input_tokens > 0:
        print(f"\n{'='*30} Input Token Stats {'='*30}")
        print(f"  Total input:      {agg.total_input_tokens:,}")
        print(f"  Avg per task:     {agg.avg_input_tokens:,.1f}")
        print(f"  Min/Max:          {agg.min_input_tokens:,} / {agg.max_input_tokens:,}")
        print(f"  Median:           {agg.median_input_tokens:,.1f}")
        print(f"  Total steps:      {agg.total_steps:,}")
        print(f"  Avg steps:        {agg.avg_steps:.1f}")
        print(f"  Min/Max steps:    {agg.min_steps} / {agg.max_steps}")
        if agg.avg_input_tokens_per_step > 0:
            print(f"  Tokens/step:      {agg.avg_input_tokens_per_step:,.1f}")

    # Tool usage stats
    if agg.total_tool_calls > 0:
        print(f"\n{'='*30} Tool Usage Stats {'='*30}")
        print(f"  Total calls:      {agg.total_tool_calls:,}")
        print(f"  Avg per task:     {agg.avg_tool_calls:.1f}")
        print(f"  Min/Max:          {agg.min_tool_calls} / {agg.max_tool_calls}")
        if agg.tool_usage_totals:
            print(f"  By tool type:")
            for tool_name, count in sorted(agg.tool_usage_totals.items(), key=lambda x: -x[1]):
                avg = agg.tool_usage_avg.get(tool_name, 0)
                print(f"    {tool_name}: {count:,} (avg {avg:.1f}/task)")

    # Extreme instances
    print(f"\n{'='*30} Extreme Instances {'='*30}")
    if ext.most_operators:
        print(f"  Most operators:")
        for task_id, count in ext.most_operators[:3]:
            print(f"    Task {task_id}: {count} operators")
    if ext.most_links:
        print(f"  Most links:")
        for task_id, count in ext.most_links[:3]:
            print(f"    Task {task_id}: {count} links")
    if ext.deepest:
        print(f"  Deepest DAGs:")
        for task_id, depth in ext.deepest[:3]:
            print(f"    Task {task_id}: depth {depth}")
    if ext.longest_elapsed:
        print(f"  Longest elapsed:")
        for task_id, elapsed in ext.longest_elapsed[:3]:
            print(f"    Task {task_id}: {elapsed:.1f}s")
    if ext.most_input_tokens:
        print(f"  Most input tokens:")
        for task_id, tokens in ext.most_input_tokens[:3]:
            print(f"    Task {task_id}: {tokens:,} tokens")
    if ext.most_steps:
        print(f"  Most steps:")
        for task_id, steps in ext.most_steps[:3]:
            print(f"    Task {task_id}: {steps} steps")
    if ext.most_tool_calls:
        print(f"  Most tool calls:")
        for task_id, calls in ext.most_tool_calls[:3]:
            print(f"    Task {task_id}: {calls} calls")

    # Difficulty-based metrics
    easy = analysis.easy_metrics
    hard = analysis.hard_metrics

    print(f"\n{'='*30} Metrics by Difficulty {'='*30}")
    print(f"\n  EASY Tasks (1-{EASY_TASK_THRESHOLD}):")
    print(f"    Count:          {easy.task_count} ({easy.successful_tasks} ok, {easy.errored_tasks} err)")
    if easy.scored_tasks > 0:
        print(f"    Accuracy:       {easy.accuracy:.1%} ({easy.correct_count}/{easy.scored_tasks})")
    if easy.task_count > 0:
        print(f"    Operators:      avg={easy.avg_operators:.1f}, min={easy.min_operators}, max={easy.max_operators}")
        print(f"    Links:          avg={easy.avg_links:.1f}, min={easy.min_links}, max={easy.max_links}")
        print(f"    Elapsed:        avg={easy.avg_elapsed:.1f}s, min={easy.min_elapsed:.1f}s, max={easy.max_elapsed:.1f}s")
        if easy.shape_counts:
            easy_total = sum(easy.shape_counts.values())
            shapes_str = ", ".join(
                f"{s}={c}({c/easy_total*100:.0f}%)"
                for s, c in sorted(easy.shape_counts.items(), key=lambda x: -x[1])
            )
            print(f"    Shapes:         {shapes_str}")
        if easy.total_input_tokens > 0:
            print(f"    Input tokens:   total={easy.total_input_tokens:,}, avg={easy.avg_input_tokens:,.1f}, min={easy.min_input_tokens:,}, max={easy.max_input_tokens:,}")
            print(f"    Steps:          total={easy.total_steps}, avg={easy.avg_steps:.1f}, min={easy.min_steps}, max={easy.max_steps}")
        if easy.total_tool_calls > 0:
            print(f"    Tool calls:     total={easy.total_tool_calls:,}, avg={easy.avg_tool_calls:.1f}, min={easy.min_tool_calls}, max={easy.max_tool_calls}")
            if easy.tool_usage_totals:
                tools_str = ", ".join(f"{t}={c}" for t, c in sorted(easy.tool_usage_totals.items(), key=lambda x: -x[1]))
                print(f"    Tools by type:  {tools_str}")

    print(f"\n  HARD Tasks ({EASY_TASK_THRESHOLD + 1}+):")
    print(f"    Count:          {hard.task_count} ({hard.successful_tasks} ok, {hard.errored_tasks} err)")
    if hard.scored_tasks > 0:
        print(f"    Accuracy:       {hard.accuracy:.1%} ({hard.correct_count}/{hard.scored_tasks})")
    if hard.task_count > 0:
        print(f"    Operators:      avg={hard.avg_operators:.1f}, min={hard.min_operators}, max={hard.max_operators}")
        print(f"    Links:          avg={hard.avg_links:.1f}, min={hard.min_links}, max={hard.max_links}")
        print(f"    Elapsed:        avg={hard.avg_elapsed:.1f}s, min={hard.min_elapsed:.1f}s, max={hard.max_elapsed:.1f}s")
        if hard.shape_counts:
            hard_total = sum(hard.shape_counts.values())
            shapes_str = ", ".join(
                f"{s}={c}({c/hard_total*100:.0f}%)"
                for s, c in sorted(hard.shape_counts.items(), key=lambda x: -x[1])
            )
            print(f"    Shapes:         {shapes_str}")
        if hard.total_input_tokens > 0:
            print(f"    Input tokens:   total={hard.total_input_tokens:,}, avg={hard.avg_input_tokens:,.1f}, min={hard.min_input_tokens:,}, max={hard.max_input_tokens:,}")
            print(f"    Steps:          total={hard.total_steps}, avg={hard.avg_steps:.1f}, min={hard.min_steps}, max={hard.max_steps}")
        if hard.total_tool_calls > 0:
            print(f"    Tool calls:     total={hard.total_tool_calls:,}, avg={hard.avg_tool_calls:.1f}, min={hard.min_tool_calls}, max={hard.max_tool_calls}")
            if hard.tool_usage_totals:
                tools_str = ", ".join(f"{t}={c}" for t, c in sorted(hard.tool_usage_totals.items(), key=lambda x: -x[1]))
                print(f"    Tools by type:  {tools_str}")

    print("=" * 70)

    # Detailed per-task output
    if detailed:
        print(f"\n{'='*30} Per-Task Details {'='*30}")
        for ta in analysis.task_analyses:
            wm = ta.workflow_metrics
            tm = ta.trace_metrics
            status = "ERROR" if ta.error else "OK"
            score_str = f" score={ta.score}" if ta.score is not None else ""
            wm_str = ""
            if wm and not wm.error:
                wm_str = f" ops={wm.num_operators} links={wm.num_links} shape={wm.shape}"
            tm_str = ""
            if tm and not tm.parse_error and tm.input_tokens > 0:
                tm_str = f" input_tokens={tm.input_tokens:,} steps={tm.step_count}"
            print(f"  Task {ta.task_id}: {status}{score_str} elapsed={ta.elapsed:.1f}s{wm_str}{tm_str}")
