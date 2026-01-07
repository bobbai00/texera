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

        for ta in self.task_analyses:
            difficulty = get_task_difficulty(ta.task_id)
            metrics = easy if difficulty == "easy" else hard
            ops_list = easy_ops if difficulty == "easy" else hard_ops
            links_list = easy_links if difficulty == "easy" else hard_links
            elapsed_list = easy_elapsed if difficulty == "easy" else hard_elapsed
            scores_list = easy_scores if difficulty == "easy" else hard_scores
            shapes_dict = easy_shapes if difficulty == "easy" else hard_shapes

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

        for ta in self.task_analyses:
            if ta.workflow_metrics and not ta.workflow_metrics.error:
                wm = ta.workflow_metrics
                operators.append((ta.task_id, wm.num_operators))
                links.append((ta.task_id, wm.num_links))
                depths.append((ta.task_id, wm.max_depth))
                components.append((ta.task_id, wm.num_components))

            if ta.elapsed > 0 and not ta.error:
                elapsed.append((ta.task_id, ta.elapsed))

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

    print("=" * 70)

    # Detailed per-task output
    if detailed:
        print(f"\n{'='*30} Per-Task Details {'='*30}")
        for ta in analysis.task_analyses:
            wm = ta.workflow_metrics
            status = "ERROR" if ta.error else "OK"
            score_str = f" score={ta.score}" if ta.score is not None else ""
            wm_str = ""
            if wm and not wm.error:
                wm_str = f" ops={wm.num_operators} links={wm.num_links} shape={wm.shape}"
            print(f"  Task {ta.task_id}: {status}{score_str} elapsed={ta.elapsed:.1f}s{wm_str}")
