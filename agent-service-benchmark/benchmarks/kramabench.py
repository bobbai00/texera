# -*- coding: utf-8 -*-
"""
KramaBench Benchmark Runner for Texera Agent Service

Runs the KramaBench benchmark (https://github.com/mitdbg/KramaBench) using
DataflowAgent or baseline CodeAgent (smolagents).

KramaBench is an end-to-end data science benchmark evaluating complete data
pipeline construction across 6 domains: Archaeology, Astronomy, Biomedical,
Environment, Legal, and Wildfire.

Usage:
    # Start a new run (quick-start domain - small test)
    python -m benchmarks.kramabench run --domain quick-start

    # Start a new run for a specific domain
    python -m benchmarks.kramabench run --domain environment

    # Start a new run for all domains
    python -m benchmarks.kramabench run --domain all

    # Resume an interrupted run
    python -m benchmarks.kramabench resume runs/kramabench/20260110_120000_environment

    # Retry errored tasks
    python -m benchmarks.kramabench retry runs/kramabench/20260110_120000_environment

    # Collect results
    python -m benchmarks.kramabench collect runs/kramabench/20260110_120000_environment

    # Evaluate results
    python -m benchmarks.kramabench evaluate runs/kramabench/20260110_120000_environment

    # Analyze workflow DAG structure
    python -m benchmarks.kramabench analyze runs/kramabench/20260110_120000_environment
"""

import os
import sys
import time
import json
import argparse
import subprocess
import re
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any, Set, Tuple
from dataclasses import dataclass, field
import threading

# Fallback: use rouge_score directly
ROUGE_AVAILABLE = False
try:
    from rouge_score import rouge_scorer
    ROUGE_AVAILABLE = True
except ImportError:
    pass

# KramaBench metrics will be imported lazily after data is downloaded
KRAMABENCH_METRICS_AVAILABLE = False
_kramabench_metrics_loaded = False

from agents.dataflow_agent import (
    DataflowAgent, MessageResult, delete_all_agents, list_all_agents,
    get_agent_workflow, AGENT_MODEL_TYPE, AGENT_MAX_STEPS,
    AGENT_MAX_OPERATOR_RESULT_CHAR_LIMIT, AGENT_MAX_OPERATOR_RESULT_CELL_CHAR_LIMIT,
    AGENT_OPERATOR_RESULT_SERIALIZATION_MODE, AGENT_TOOL_TIMEOUT_SECONDS,
    AGENT_EXECUTION_TIMEOUT_MINUTES, AGENT_MODE, TEXERA_AGENT_SERVICE_ENDPOINT,
)
from agents.code_agent import (
    CodeAgentWrapper, CodeAgentResult, CODE_AGENT_MODEL_TYPE, CODE_AGENT_MAX_STEPS,
)

# =============================================================================
# Constants
# =============================================================================

KRAMABENCH_REPO = "https://github.com/mitdbg/KramaBench.git"
DATA_DIR = "/tmp/KramaBench"
RUNS_DIR = Path(__file__).parent.parent / "runs" / "kramabench"

# Available domains in KramaBench
DOMAINS = [
    "archaeology",
    "astronomy",
    "biomedical",
    "environment",
    "legal",
    "wildfire",
]

# Quick-start for testing
QUICK_START_DOMAIN = "quick-start"

# Workload file mapping (domain -> filename)
WORKLOAD_FILES = {
    "archaeology": "archeology.json",  # Note: typo in original repo
    "astronomy": "astronomy.json",
    "biomedical": "biomedical.json",
    "environment": "environment.json",
    "legal": "legal.json",
    "wildfire": "wildfire.json",
    "quick-start": "quick-start-questions.json",
}

PROMPT = """You are an expert data scientist. Answer the question by analyzing the provided data files and building a data pipeline.

Domain: {domain}

Available data files:
{data_files}

Question: {query}

Expected answer type: {answer_type}

Instructions:
1. Load and examine the relevant data files listed above
2. Clean and preprocess the data as needed
3. Perform the necessary analysis or computation
4. Follow the expected answer type format exactly
5. Your final message must be ONLY the answer in the required format

Important: Pay attention to the answer type:
- numeric_exact: Provide the exact number
- numeric_approximate: Provide an approximate number
- list_exact: Provide a list in the exact format requested
- string: Provide a text answer
"""

BASELINE_PROMPT = """You are an expert data scientist. Answer the question by loading and analyzing data files.

Domain: {domain}

Available data files:
{data_files}

Question: {query}

Expected answer type: {answer_type}

Reference the data files to answer. Your final output must be ONLY the answer.
"""


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class KramaBenchTask:
    """A single KramaBench task."""
    id: str
    query: str
    answer: str
    answer_type: str
    data_sources: List[str]
    subtasks: List[Dict] = field(default_factory=list)
    domain: str = ""
    difficulty: str = ""

    @classmethod
    def from_dict(cls, d: Dict, domain: str = "") -> "KramaBenchTask":
        """Create from JSON dict."""
        # Parse difficulty from ID (e.g., "environment-easy-1" -> "easy")
        task_id = d.get("id", "")
        difficulty = ""
        for level in ["easy", "medium", "hard"]:
            if level in task_id.lower():
                difficulty = level
                break

        return cls(
            id=task_id,
            query=d.get("query", ""),
            answer=str(d.get("answer", "")),
            answer_type=d.get("answer_type", "string"),
            data_sources=d.get("data_sources", []),
            subtasks=d.get("subtasks", []),
            domain=domain,
            difficulty=difficulty,
        )


# =============================================================================
# Data Loading
# =============================================================================

def download_kramabench_data(data_dir: str = DATA_DIR, force: bool = False) -> Path:
    """Clone or update KramaBench repository."""
    data_path = Path(data_dir)

    if data_path.exists() and not force:
        print(f"[KramaBench] Data directory exists: {data_dir}")
        # Try to pull latest
        try:
            subprocess.run(
                ["git", "-C", str(data_path), "pull"],
                capture_output=True, check=True
            )
            print("[KramaBench] Updated repository")
        except subprocess.CalledProcessError:
            print("[KramaBench] Could not update, using existing data")
        return data_path

    if data_path.exists() and force:
        import shutil
        print(f"[KramaBench] Removing existing directory: {data_dir}")
        shutil.rmtree(data_path)

    print(f"[KramaBench] Cloning repository to {data_dir}...")
    try:
        subprocess.run(
            ["git", "clone", "--depth", "1", KRAMABENCH_REPO, str(data_path)],
            check=True
        )
        print("[KramaBench] Repository cloned successfully")
    except subprocess.CalledProcessError as e:
        print(f"[KramaBench] Error cloning repository: {e}")
        raise

    return data_path


def load_workload(domain: str, data_dir: str = DATA_DIR) -> List[KramaBenchTask]:
    """Load task definitions from domain JSON file."""
    workload_file = WORKLOAD_FILES.get(domain.lower())
    if not workload_file:
        raise ValueError(f"Unknown domain: {domain}. Available: {list(WORKLOAD_FILES.keys())}")

    workload_path = Path(data_dir) / "workload" / workload_file
    if not workload_path.exists():
        raise FileNotFoundError(f"Workload file not found: {workload_path}")

    print(f"[KramaBench] Loading workload: {workload_path}")
    with open(workload_path) as f:
        data = json.load(f)

    # Handle both list and dict formats
    if isinstance(data, list):
        tasks = [KramaBenchTask.from_dict(t, domain=domain) for t in data]
    elif isinstance(data, dict):
        # Some files might have tasks under a key
        tasks_data = data.get("tasks", data.get("questions", [data]))
        if isinstance(tasks_data, list):
            tasks = [KramaBenchTask.from_dict(t, domain=domain) for t in tasks_data]
        else:
            tasks = [KramaBenchTask.from_dict(tasks_data, domain=domain)]
    else:
        tasks = []

    print(f"[KramaBench] Loaded {len(tasks)} tasks from {domain}")
    return tasks


def get_task_data_files(task: KramaBenchTask, data_dir: str = DATA_DIR) -> List[str]:
    """Get full paths to task data files.

    KramaBench data is organized as:
    - dr-input/{domain}/{task_id}/{filename} - task-specific data
    - data/{domain}/input/{filename} - shared domain data
    """
    data_path = Path(data_dir)
    files = []

    # Extract domain from task ID (e.g., "environment-easy-1" -> "environment")
    task_domain = task.id.split("-")[0] if "-" in task.id else task.domain

    for source in task.data_sources:
        # Try different path combinations in order of specificity
        candidates = [
            # Task-specific data (dr-input)
            data_path / "dr-input" / task_domain / task.id / source,
            # Shared domain data
            data_path / "data" / task_domain / "input" / source,
            # Alternative: domain from task object
            data_path / "dr-input" / task.domain / task.id / source,
            data_path / "data" / task.domain / "input" / source,
            # Fallback: direct paths
            data_path / "data" / source,
            data_path / source,
        ]

        found = False
        for candidate in candidates:
            if candidate.exists():
                files.append(str(candidate))
                found = True
                break

        if not found:
            # File not found, include best-guess path for error visibility
            files.append(str(data_path / "data" / task_domain / "input" / source))

    return files


# =============================================================================
# Run Directory Management
# =============================================================================

def create_run_dir(domain: str, baseline: bool = False) -> Path:
    """Create a new run directory."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    mode = "baseline" if baseline else "dataflow"
    run_name = f"{timestamp}_{domain}_{mode}"
    run_dir = RUNS_DIR / run_name
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


def save_run_config(run_dir: Path, config: Dict):
    """Save run configuration."""
    config_file = run_dir / "config.json"
    with open(config_file, 'w') as f:
        json.dump(config, f, indent=2)


def load_run_config(run_dir: Path) -> Dict:
    """Load run configuration."""
    config_file = run_dir / "config.json"
    if not config_file.exists():
        raise FileNotFoundError(f"No config.json found in {run_dir}")
    with open(config_file) as f:
        return json.load(f)


def get_completed_task_ids(run_dir: Path) -> Set[str]:
    """Get set of completed task IDs from run directory."""
    completed = set()
    for task_dir in run_dir.iterdir():
        if not task_dir.is_dir() or not task_dir.name.startswith("task_"):
            continue
        result_file = task_dir / "result.json"
        if result_file.exists():
            try:
                with open(result_file) as f:
                    result = json.load(f)
                    completed.add(str(result["task_id"]))
            except:
                pass
    return completed


def get_errored_task_ids(run_dir: Path) -> Set[str]:
    """Get set of task IDs that have errors from run directory."""
    errored = set()
    for task_dir in run_dir.iterdir():
        if not task_dir.is_dir() or not task_dir.name.startswith("task_"):
            continue
        result_file = task_dir / "result.json"
        if result_file.exists():
            try:
                with open(result_file) as f:
                    result = json.load(f)
                    if result.get("error"):
                        errored.add(str(result["task_id"]))
            except:
                pass
    return errored


def delete_task_results(run_dir: Path, task_ids: Set[str]):
    """Delete result files for specified task IDs so they can be re-run."""
    import shutil
    for task_id in task_ids:
        # Handle task IDs with special characters
        safe_id = task_id.replace("/", "_").replace("\\", "_")
        task_dir = run_dir / f"task_{safe_id}"
        if task_dir.exists():
            shutil.rmtree(task_dir)


def save_task_result(run_dir: Path, task_id: str, result: Dict):
    """Save a single task result to its directory."""
    safe_id = task_id.replace("/", "_").replace("\\", "_")
    task_dir = run_dir / f"task_{safe_id}"
    task_dir.mkdir(parents=True, exist_ok=True)
    result_file = task_dir / "result.json"
    with open(result_file, 'w') as f:
        json.dump(result, f, indent=2)


# =============================================================================
# Result Handling
# =============================================================================

def extract_answer(response: str, messages: List[Dict] = None) -> str:
    """Extract answer from response or messages."""
    if response and response.strip():
        lines = response.strip().split("\n")
        for line in reversed(lines):
            if line.strip():
                return line.strip()
    if messages:
        for msg in reversed(messages):
            if msg.get('role') != 'assistant':
                continue
            content = msg.get('content', '')
            if isinstance(content, str) and content.strip():
                return content.strip().split("\n")[-1].strip()
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get('type') == 'text':
                        text = item.get('text', '').strip()
                        if text:
                            return text.split("\n")[-1].strip()
    return response.strip() if response else ""


def collect_results(run_dir: Path) -> List[Dict]:
    """Collect all task results from run directory."""
    results = []
    for task_dir in sorted(run_dir.iterdir()):
        if not task_dir.is_dir() or not task_dir.name.startswith("task_"):
            continue
        result_file = task_dir / "result.json"
        if result_file.exists():
            with open(result_file) as f:
                results.append(json.load(f))
    return results


def write_results_json(results: List[Dict], output_file: Path):
    """Write results to JSON file."""
    with open(output_file, 'w') as f:
        json.dump(results, f, indent=2)


# =============================================================================
# Evaluation
# =============================================================================

def _load_kramabench_metrics():
    """Lazily load KramaBench metrics after data is downloaded.

    Note: KramaBench's metrics.py has dependencies on LLM tools (openai, ollama, etc.)
    which we don't want to require. Our local implementation follows the exact same
    logic from KramaBench's metrics.py (Success, RAEScore, RougeScore, F1) so we
    use the local implementation by default.
    """
    global KRAMABENCH_METRICS_AVAILABLE, _kramabench_metrics_loaded
    global _kb_Success, _kb_RAEScore, _kb_RougeScore, _kb_F1, _kb_metric_factory

    if _kramabench_metrics_loaded:
        return KRAMABENCH_METRICS_AVAILABLE

    _kramabench_metrics_loaded = True

    # KramaBench metrics have heavy dependencies (openai, ollama, etc.)
    # Our local implementation follows the same logic, so we use it by default
    # Set this to False to always use local implementation
    KRAMABENCH_METRICS_AVAILABLE = False
    return False


def str_to_float(num_string: str) -> float:
    """Convert string to float, handling percentage format."""
    num_string = str(num_string).strip()
    if num_string.endswith("%"):
        return float(num_string.strip("%")) / 100
    return float(num_string)


def compute_rae_score(predicted: str, expected: str) -> float:
    """Compute RAE Score: 1/(1+RAE) where RAE is relative absolute error.

    This matches KramaBench's RAEScore metric.
    Returns value in [0, 1] where 1 is perfect match.
    """
    try:
        pred_val = str_to_float(predicted)
        exp_val = str_to_float(expected)

        if exp_val == 0:
            return 1.0 if pred_val == 0 else 0.0

        rae = abs(pred_val - exp_val) / abs(exp_val)
        return 1.0 / (1.0 + rae)
    except (ValueError, TypeError):
        return 0.0


def compute_success_numeric(predicted: str, expected: str) -> bool:
    """Check if numeric prediction matches expected with tiny tolerance.

    This matches KramaBench's Success metric for numeric_exact.
    """
    try:
        pred_val = str_to_float(predicted)
        exp_val = str_to_float(expected)

        if exp_val == 0:
            return pred_val == 0

        rae = abs(pred_val - exp_val) / abs(exp_val)
        # Also check if user gave percentage when answer was decimal
        rae_percent = abs(pred_val * 100 - exp_val) / abs(exp_val)
        return rae < 0.000001 or rae_percent < 0.000001
    except (ValueError, TypeError):
        return False


def compute_success_string(predicted: str, expected: str) -> bool:
    """Check if string prediction matches expected (case-insensitive).

    This matches KramaBench's Success metric for string_exact.
    """
    return predicted.strip().lower() == expected.strip().lower()


def compute_rouge_score(predicted: str, expected: str) -> float:
    """Compute ROUGE-1 F1 score for text answers.

    This matches KramaBench's RougeScore metric.
    """
    if not ROUGE_AVAILABLE:
        return 0.0

    try:
        scorer = rouge_scorer.RougeScorer(['rouge1'], use_stemmer=False)
        scores = scorer.score(
            target=str(expected).strip().lower(),
            prediction=str(predicted).strip().lower()
        )
        return scores['rouge1'].fmeasure
    except Exception:
        return 0.0


def compute_f1_list(predicted: Any, expected: Any) -> float:
    """Compute F1 score for list answers.

    This matches KramaBench's F1 metric for list_exact.
    """
    try:
        # Parse lists if strings
        if isinstance(predicted, str):
            try:
                predicted = json.loads(predicted)
            except json.JSONDecodeError:
                predicted = [predicted]
        if isinstance(expected, str):
            try:
                expected = json.loads(expected)
            except json.JSONDecodeError:
                expected = [expected]

        if not isinstance(predicted, list):
            predicted = [predicted]
        if not isinstance(expected, list):
            expected = [expected]

        if len(expected) == 0:
            return 1.0 if len(predicted) == 0 else 0.0

        # Count matches
        matched_predicted = set()
        recall_cnt = 0

        for t in expected:
            for j, p in enumerate(predicted):
                if isinstance(t, str):
                    if str(t).strip().lower() == str(p).strip().lower():
                        matched_predicted.add(j)
                        recall_cnt += 1
                        break
                elif isinstance(t, (float, int)):
                    try:
                        pp = str_to_float(str(p))
                        if abs(pp - t) / max(abs(t), 1e-12) < 1e-6:
                            matched_predicted.add(j)
                            recall_cnt += 1
                            break
                    except (ValueError, TypeError):
                        continue

        recall = recall_cnt / len(expected)
        precision = len(matched_predicted) / len(predicted) if predicted else 0.0

        if precision + recall == 0:
            return 0.0
        return 2 * precision * recall / (precision + recall)
    except Exception:
        return 0.0


def evaluate_answer_kramabench(predicted: str, expected: str, answer_type: str) -> Dict:
    """Evaluate using KramaBench's actual metrics (when available)."""
    answer_type = answer_type.lower()
    result = {
        "predicted": str(predicted).strip(),
        "expected": str(expected).strip(),
        "answer_type": answer_type,
        "using_kramabench_metrics": True,
    }

    try:
        if answer_type == "numeric_exact":
            score, _, _, _ = _kb_Success()(predicted, expected)
            result["success"] = bool(score)
            result["exact_match"] = bool(score)
            result["score"] = float(score)

        elif answer_type == "numeric_approximate":
            rae_score, _, _, _ = _kb_RAEScore()(predicted, expected)
            success, _, _, _ = _kb_Success()(predicted, expected)
            result["rae_score"] = float(rae_score) if rae_score else 0.0
            result["exact_match"] = bool(success)
            result["score"] = float(rae_score) if rae_score else 0.0

        elif answer_type == "string_exact":
            score, _, _, _ = _kb_Success()(predicted, expected)
            result["success"] = bool(score)
            result["exact_match"] = bool(score)
            result["score"] = float(score)

        elif answer_type == "string_approximate":
            # KramaBench uses LLM paraphrase, we use ROUGE as fallback
            rouge_score, _, _, _ = _kb_RougeScore()(predicted, expected)
            success, _, _, _ = _kb_Success()(predicted, expected)
            result["rouge"] = float(rouge_score) if rouge_score else 0.0
            result["exact_match"] = bool(success)
            result["score"] = 1.0 if success else (float(rouge_score) if rouge_score else 0.0)

        elif answer_type in ("list_exact", "list_approximate"):
            f1_score, _, _, _ = _kb_F1()(predicted, expected)
            result["f1"] = float(f1_score) if f1_score else 0.0
            result["exact_match"] = f1_score == 1.0
            result["score"] = float(f1_score) if f1_score else 0.0

        else:
            # Default fallback
            success, _, _, _ = _kb_Success()(predicted, expected)
            result["success"] = bool(success)
            result["exact_match"] = bool(success)
            result["score"] = float(success)

    except Exception as e:
        result["error"] = str(e)
        result["score"] = 0.0
        result["exact_match"] = False

    return result


def evaluate_answer(predicted: str, expected: str, answer_type: str) -> Dict:
    """Evaluate a single answer using KramaBench-compatible metrics.

    Uses KramaBench's actual metrics when available, otherwise falls back to
    local implementation.

    Answer types and their metrics (from KramaBench answer_type_fixtures.json):
    - numeric_exact: success (exact match with tiny tolerance)
    - numeric_approximate: rae_score = 1/(1+RAE)
    - string_exact: success (case-insensitive exact match)
    - string_approximate: rouge (fallback since we don't use GPT)
    - list_exact: f1 score
    - list_approximate: f1 score
    """
    # Try to use KramaBench's metrics if available
    if _load_kramabench_metrics():
        return evaluate_answer_kramabench(predicted, expected, answer_type)

    # Fallback to local implementation
    predicted = str(predicted).strip()
    expected_str = str(expected).strip()
    answer_type = answer_type.lower()

    result = {
        "predicted": predicted,
        "expected": expected_str,
        "answer_type": answer_type,
        "using_kramabench_metrics": False,
    }

    if answer_type == "numeric_exact":
        success = compute_success_numeric(predicted, expected_str)
        result["success"] = success
        result["exact_match"] = success
        result["score"] = 1.0 if success else 0.0

    elif answer_type == "numeric_approximate":
        rae_score = compute_rae_score(predicted, expected_str)
        result["rae_score"] = rae_score
        result["exact_match"] = compute_success_numeric(predicted, expected_str)
        result["score"] = rae_score

    elif answer_type == "string_exact":
        success = compute_success_string(predicted, expected_str)
        result["success"] = success
        result["exact_match"] = success
        result["score"] = 1.0 if success else 0.0

    elif answer_type == "string_approximate":
        # Use ROUGE as fallback (KramaBench uses LLM paraphrase which requires GPT API)
        rouge = compute_rouge_score(predicted, expected_str)
        exact = compute_success_string(predicted, expected_str)
        result["rouge"] = rouge
        result["exact_match"] = exact
        result["score"] = 1.0 if exact else rouge

    elif answer_type in ("list_exact", "list_approximate"):
        f1 = compute_f1_list(predicted, expected)
        result["f1"] = f1
        result["exact_match"] = f1 == 1.0
        result["score"] = f1

    else:
        # Default: try numeric first, then string
        if re.match(r'^-?\d+\.?\d*%?$', predicted) and re.match(r'^-?\d+\.?\d*%?$', expected_str):
            success = compute_success_numeric(predicted, expected_str)
            result["success"] = success
            result["exact_match"] = success
            result["score"] = 1.0 if success else compute_rae_score(predicted, expected_str)
        else:
            success = compute_success_string(predicted, expected_str)
            result["success"] = success
            result["exact_match"] = success
            result["score"] = 1.0 if success else compute_rouge_score(predicted, expected_str)

    return result


def evaluate_results(results: List[Dict], tasks: List[KramaBenchTask]) -> List[Dict]:
    """Evaluate all results against ground truth."""
    task_map = {t.id: t for t in tasks}

    for result in results:
        task_id = result.get("task_id")
        task = task_map.get(task_id)

        if not task:
            result["evaluation"] = {"error": "Task not found"}
            continue

        eval_result = evaluate_answer(
            result.get("answer", ""),
            task.answer,
            task.answer_type,
        )
        result["evaluation"] = eval_result
        result["score"] = eval_result.get("score", 0)

    return results


# =============================================================================
# Task Runners
# =============================================================================

def run_dataflow_task(
    task: KramaBenchTask,
    data_dir: str,
    run_dir: Path,
    model_type: str = AGENT_MODEL_TYPE,
    max_steps: int = AGENT_MAX_STEPS,
    max_result_chars: int = AGENT_MAX_OPERATOR_RESULT_CHAR_LIMIT,
    max_cell_chars: int = AGENT_MAX_OPERATOR_RESULT_CELL_CHAR_LIMIT,
    result_format: str = AGENT_OPERATOR_RESULT_SERIALIZATION_MODE,
    tool_timeout: int = AGENT_TOOL_TIMEOUT_SECONDS,
    exec_timeout: int = AGENT_EXECUTION_TIMEOUT_MINUTES,
    agent_mode: str = AGENT_MODE,
    verbosity: int = 1,
    retain: bool = False,
    relational_only: bool = True,
) -> Dict:
    """Run a single task with DataflowAgent."""
    safe_id = task.id.replace("/", "_").replace("\\", "_")
    task_dir = run_dir / f"task_{safe_id}"
    task_dir.mkdir(parents=True, exist_ok=True)

    # Get data files
    data_files = get_task_data_files(task, data_dir)
    data_files_str = "\n".join(f"  - {f}" for f in data_files)

    prompt = PROMPT.format(
        domain=task.domain,
        data_files=data_files_str,
        query=task.query,
        answer_type=task.answer_type,
    )

    agent = DataflowAgent(
        model_type=model_type,
        max_steps=max_steps,
        max_operator_result_char_limit=max_result_chars,
        max_operator_result_cell_char_limit=max_cell_chars,
        operator_result_serialization_mode=result_format,
        tool_timeout_seconds=tool_timeout,
        execution_timeout_minutes=exec_timeout,
        agent_mode=agent_mode,
        verbosity_level=verbosity,
        workflow_name=f"KramaBench-{safe_id}",
        agent_name=f"kramabench-{safe_id}",
        only_use_relational_operators=relational_only,
    )

    start = time.time()
    result = {
        "task_id": task.id,
        "domain": task.domain,
        "difficulty": task.difficulty,
        "answer_type": task.answer_type,
        "answer": "",
        "expected": task.answer,
        "error": None,
        "elapsed": 0,
    }

    try:
        agent.setup()
        msg_result = agent.run(prompt)
        result["answer"] = extract_answer(msg_result.response, msg_result.messages)
        result["error"] = msg_result.error

        # Save task files
        _save_task_files(task_dir, task, prompt, result, msg_result, agent)
    except Exception as e:
        result["answer"] = f"ERROR: {e}"
        result["error"] = str(e)
    finally:
        result["elapsed"] = time.time() - start
        if not retain:
            agent.cleanup()

    # Save result immediately
    save_task_result(run_dir, task.id, result)
    return result


def run_baseline_task(
    task: KramaBenchTask,
    data_dir: str,
    run_dir: Path,
    model_type: str = CODE_AGENT_MODEL_TYPE,
    max_steps: int = CODE_AGENT_MAX_STEPS,
    verbosity: int = 1,
) -> Dict:
    """Run a single task with baseline CodeAgent."""
    safe_id = task.id.replace("/", "_").replace("\\", "_")
    task_dir = run_dir / f"task_{safe_id}"
    task_dir.mkdir(parents=True, exist_ok=True)

    # Get data files
    data_files = get_task_data_files(task, data_dir)
    data_files_str = "\n".join(f"  - {f}" for f in data_files)

    prompt = BASELINE_PROMPT.format(
        domain=task.domain,
        data_files=data_files_str,
        query=task.query,
        answer_type=task.answer_type,
    )

    agent = CodeAgentWrapper(
        model_type=model_type,
        max_steps=max_steps,
        verbosity_level=verbosity,
        agent_name=f"baseline-{safe_id}",
    )

    start = time.time()
    result = {
        "task_id": task.id,
        "domain": task.domain,
        "difficulty": task.difficulty,
        "answer_type": task.answer_type,
        "answer": "",
        "expected": task.answer,
        "error": None,
        "elapsed": 0,
    }

    try:
        agent.setup()
        code_result = agent.run(prompt)
        result["answer"] = extract_answer(code_result.response)
        result["error"] = code_result.error

        # Save prompt
        with open(task_dir / "prompt.txt", 'w') as f:
            f.write(prompt)
        with open(task_dir / "answer.txt", 'w') as f:
            f.write(result["answer"])
        with open(task_dir / "expected.txt", 'w') as f:
            f.write(task.answer)
    except Exception as e:
        result["answer"] = f"ERROR: {e}"
        result["error"] = str(e)
    finally:
        result["elapsed"] = time.time() - start
        agent.cleanup()

    save_task_result(run_dir, task.id, result)
    return result


def _save_task_files(task_dir: Path, task: KramaBenchTask, prompt: str, result: Dict,
                     msg_result: MessageResult, agent: DataflowAgent):
    """Save task-level files for debugging."""
    with open(task_dir / "prompt.txt", 'w') as f:
        f.write(prompt)
    with open(task_dir / "answer.txt", 'w') as f:
        f.write(result["answer"])
    with open(task_dir / "expected.txt", 'w') as f:
        f.write(task.answer)

    # Save subtasks info
    if task.subtasks:
        with open(task_dir / "subtasks.json", 'w') as f:
            json.dump(task.subtasks, f, indent=2)

    if msg_result:
        with open(task_dir / "trace.json", 'w') as f:
            json.dump({
                "response": msg_result.response,
                "messages": msg_result.messages,
                "usage": msg_result.usage,
                "stats": msg_result.stats,
            }, f, indent=2)

    try:
        workflow = get_agent_workflow(agent.agent_id)
        with open(task_dir / "workflow.json", 'w') as f:
            json.dump(workflow, f, indent=2)
    except:
        pass


# =============================================================================
# Benchmark Runners
# =============================================================================

_print_lock = threading.Lock()


def _log(msg: str):
    with _print_lock:
        print(msg)


def run_benchmark(
    tasks: List[KramaBenchTask],
    data_dir: str,
    run_dir: Path,
    baseline: bool = False,
    skip_task_ids: Set[str] = None,
    reverse: bool = False,
    **agent_kwargs,
) -> List[Dict]:
    """Run the benchmark sequentially, skipping completed tasks."""
    skip_task_ids = skip_task_ids or set()
    runner = run_baseline_task if baseline else run_dataflow_task
    mode = "baseline" if baseline else "dataflow"

    # Filter tasks
    tasks_to_run = [t for t in tasks if t.id not in skip_task_ids]

    # Reverse order if requested
    if reverse:
        tasks_to_run = list(reversed(tasks_to_run))

    total = len(tasks)
    skipped = len(skip_task_ids)

    order_str = " (reverse order)" if reverse else ""
    print(f"\n[KramaBench] Running {len(tasks_to_run)} tasks ({mode}){order_str}")
    if skipped:
        print(f"[KramaBench] Skipping {skipped} already completed tasks")

    results = []
    for i, task in enumerate(tasks_to_run):
        task_num = skipped + i + 1
        query_preview = task.query[:60] + "..." if len(task.query) > 60 else task.query
        _log(f"\n[{task_num}/{total}] Task {task.id}: {query_preview}")

        result = runner(task, data_dir, run_dir, **agent_kwargs)
        results.append(result)

        answer_preview = result['answer'][:80] + '...' if len(result['answer']) > 80 else result['answer']
        _log(f"  Answer: {answer_preview} ({result['elapsed']:.1f}s)")

    return results


def cleanup_agents():
    """Delete all existing agents."""
    try:
        agents = list_all_agents(TEXERA_AGENT_SERVICE_ENDPOINT)
        if agents:
            print(f"[KramaBench] Cleaning up {len(agents)} agents...")
            delete_all_agents(TEXERA_AGENT_SERVICE_ENDPOINT)
    except Exception as e:
        print(f"[KramaBench] Cleanup failed: {e}")


# =============================================================================
# CLI Commands
# =============================================================================

def cmd_run(args):
    """Run a new benchmark."""
    domain = args.domain.lower()

    # Validate domain
    valid_domains = list(WORKLOAD_FILES.keys()) + ["all"]
    if domain not in valid_domains:
        print(f"[KramaBench] Error: Invalid domain '{domain}'")
        print(f"[KramaBench] Available domains: {valid_domains}")
        sys.exit(1)

    print("=" * 60)
    print(f"KramaBench Benchmark - {'Baseline (smolagents)' if args.baseline else 'Texera Agent'}")
    print(f"Domain: {domain} | Max tasks: {args.max_tasks or 'all'} | Model: {args.model}")
    print("=" * 60)

    # Cleanup
    if not args.no_cleanup and not args.baseline:
        cleanup_agents()

    # Download data
    if not args.skip_download:
        download_kramabench_data(args.data_dir, force=args.force_download)
    else:
        print(f"[KramaBench] Using existing data at {args.data_dir}")

    # Load tasks for selected domain(s)
    if domain == "all":
        all_tasks = []
        for d in DOMAINS:
            try:
                all_tasks.extend(load_workload(d, args.data_dir))
            except Exception as e:
                print(f"[KramaBench] Warning: Could not load {d}: {e}")
        tasks = all_tasks
    else:
        tasks = load_workload(domain, args.data_dir)

    # Filter by difficulty if specified
    if args.difficulty:
        tasks = [t for t in tasks if t.difficulty == args.difficulty]
        print(f"[KramaBench] Filtered to {len(tasks)} {args.difficulty} tasks")

    # Limit tasks if specified
    if args.max_tasks:
        tasks = tasks[:args.max_tasks]

    if not tasks:
        print("[KramaBench] No tasks to run!")
        sys.exit(1)

    # Create run directory
    run_dir = create_run_dir(domain, args.baseline)
    print(f"[KramaBench] Run directory: {run_dir}")

    # Save config
    config = {
        "domain": domain,
        "difficulty": args.difficulty,
        "max_tasks": args.max_tasks,
        "baseline": args.baseline,
        "model": args.model,
        "max_steps": args.max_steps,
        "agent_mode": args.agent_mode,
        "result_format": args.result_format,
        "max_result_chars": args.max_result_chars,
        "max_cell_chars": args.max_cell_chars,
        "tool_timeout": args.tool_timeout,
        "exec_timeout": args.exec_timeout,
        "data_dir": args.data_dir,
        "created_at": datetime.now().isoformat(),
    }
    save_run_config(run_dir, config)

    # Build agent kwargs
    agent_kwargs = {
        "model_type": args.model,
        "max_steps": args.max_steps,
        "verbosity": args.verbosity,
    }
    if not args.baseline:
        agent_kwargs.update({
            "agent_mode": args.agent_mode,
            "result_format": args.result_format,
            "max_result_chars": args.max_result_chars,
            "max_cell_chars": args.max_cell_chars,
            "tool_timeout": args.tool_timeout,
            "exec_timeout": args.exec_timeout,
            "retain": args.retain,
            "relational_only": not args.allow_non_relational,
        })

    # Run benchmark
    results = run_benchmark(
        tasks, args.data_dir, run_dir,
        baseline=args.baseline,
        reverse=args.reverse,
        **agent_kwargs,
    )

    # Summary
    _print_summary(run_dir, results, tasks)


def cmd_resume(args):
    """Resume an interrupted benchmark run."""
    run_dir = Path(args.run_dir)
    if not run_dir.exists():
        print(f"[KramaBench] Error: Run directory not found: {run_dir}")
        sys.exit(1)

    # Load config
    config = load_run_config(run_dir)
    print("=" * 60)
    print(f"KramaBench Benchmark - Resuming")
    print(f"Run directory: {run_dir}")
    print(f"Domain: {config['domain']} | Model: {config['model']}")
    print("=" * 60)

    # Handle --rerun-tasks
    rerun_ids = None
    if args.rerun_tasks:
        rerun_ids = set(args.rerun_tasks.split(","))
        print(f"[KramaBench] Deleting {len(rerun_ids)} tasks to re-run: {sorted(rerun_ids)}")
        delete_task_results(run_dir, rerun_ids)

    # Get completed tasks
    completed = get_completed_task_ids(run_dir)
    print(f"[KramaBench] Found {len(completed)} completed tasks")

    # Cleanup
    if not args.no_cleanup and not config.get("baseline"):
        cleanup_agents()

    # Load tasks
    data_dir = config.get("data_dir", DATA_DIR)
    domain = config.get("domain", "quick-start")

    if domain == "all":
        tasks = []
        for d in DOMAINS:
            try:
                tasks.extend(load_workload(d, data_dir))
            except:
                pass
    else:
        tasks = load_workload(domain, data_dir)

    # Filter by difficulty if configured
    if config.get("difficulty"):
        tasks = [t for t in tasks if t.difficulty == config["difficulty"]]

    # Limit tasks if configured
    if config.get("max_tasks"):
        tasks = tasks[:config["max_tasks"]]

    # Handle --only mode
    if args.only:
        if not rerun_ids:
            print("[KramaBench] Error: --only requires --rerun-tasks")
            sys.exit(1)
        all_task_ids = set(t.id for t in tasks)
        completed = all_task_ids - rerun_ids
        print(f"[KramaBench] --only mode: will run only {len(rerun_ids)} specified tasks")

    # Check if already complete
    if len(completed) >= len(tasks):
        print(f"[KramaBench] All {len(tasks)} tasks already completed!")
        _print_summary(run_dir, tasks=tasks)
        return

    # Build agent kwargs
    baseline = config.get("baseline", False)
    agent_kwargs = {
        "model_type": config.get("model", AGENT_MODEL_TYPE),
        "max_steps": config.get("max_steps", AGENT_MAX_STEPS),
        "verbosity": args.verbosity,
    }
    if not baseline:
        agent_kwargs.update({
            "agent_mode": config.get("agent_mode", AGENT_MODE),
            "result_format": config.get("result_format", AGENT_OPERATOR_RESULT_SERIALIZATION_MODE),
            "max_result_chars": config.get("max_result_chars", AGENT_MAX_OPERATOR_RESULT_CHAR_LIMIT),
            "max_cell_chars": config.get("max_cell_chars", AGENT_MAX_OPERATOR_RESULT_CELL_CHAR_LIMIT),
            "tool_timeout": config.get("tool_timeout", AGENT_TOOL_TIMEOUT_SECONDS),
            "exec_timeout": config.get("exec_timeout", AGENT_EXECUTION_TIMEOUT_MINUTES),
            "retain": False,
            "relational_only": True,
        })

    # Run benchmark
    results = run_benchmark(
        tasks, data_dir, run_dir,
        baseline=baseline,
        skip_task_ids=completed,
        reverse=args.reverse,
        **agent_kwargs,
    )

    # Summary
    _print_summary(run_dir, tasks=tasks)


def cmd_retry(args):
    """Retry errored tasks from a benchmark run."""
    run_dir = Path(args.run_dir)
    if not run_dir.exists():
        print(f"[KramaBench] Error: Run directory not found: {run_dir}")
        sys.exit(1)

    # Load config
    config = load_run_config(run_dir)

    # Get errored tasks
    errored = get_errored_task_ids(run_dir)
    if not errored:
        print(f"[KramaBench] No errored tasks found in {run_dir}")
        return

    print("=" * 60)
    print(f"KramaBench Benchmark - Retry Errored Tasks")
    print(f"Run directory: {run_dir}")
    print(f"Domain: {config['domain']} | Model: {config['model']}")
    print(f"Errored tasks to retry: {len(errored)}")
    print(f"Task IDs: {sorted(errored)}")
    print("=" * 60)

    # Delete errored task directories
    print(f"[KramaBench] Deleting {len(errored)} errored task directories...")
    delete_task_results(run_dir, errored)

    # Get remaining completed tasks
    completed = get_completed_task_ids(run_dir)
    print(f"[KramaBench] Skipping {len(completed)} successfully completed tasks")

    # Cleanup
    if not args.no_cleanup and not config.get("baseline"):
        cleanup_agents()

    # Load tasks
    data_dir = config.get("data_dir", DATA_DIR)
    domain = config.get("domain", "quick-start")

    if domain == "all":
        tasks = []
        for d in DOMAINS:
            try:
                tasks.extend(load_workload(d, data_dir))
            except:
                pass
    else:
        tasks = load_workload(domain, data_dir)

    if config.get("difficulty"):
        tasks = [t for t in tasks if t.difficulty == config["difficulty"]]
    if config.get("max_tasks"):
        tasks = tasks[:config["max_tasks"]]

    # Build agent kwargs
    baseline = config.get("baseline", False)
    agent_kwargs = {
        "model_type": config.get("model", AGENT_MODEL_TYPE),
        "max_steps": config.get("max_steps", AGENT_MAX_STEPS),
        "verbosity": args.verbosity,
    }
    if not baseline:
        agent_kwargs.update({
            "agent_mode": config.get("agent_mode", AGENT_MODE),
            "result_format": config.get("result_format", AGENT_OPERATOR_RESULT_SERIALIZATION_MODE),
            "max_result_chars": config.get("max_result_chars", AGENT_MAX_OPERATOR_RESULT_CHAR_LIMIT),
            "max_cell_chars": config.get("max_cell_chars", AGENT_MAX_OPERATOR_RESULT_CELL_CHAR_LIMIT),
            "tool_timeout": config.get("tool_timeout", AGENT_TOOL_TIMEOUT_SECONDS),
            "exec_timeout": config.get("exec_timeout", AGENT_EXECUTION_TIMEOUT_MINUTES),
            "retain": False,
            "relational_only": True,
        })

    # Run benchmark
    results = run_benchmark(
        tasks, data_dir, run_dir,
        baseline=baseline,
        skip_task_ids=completed,
        reverse=args.reverse,
        **agent_kwargs,
    )

    # Summary
    _print_summary(run_dir, tasks=tasks)


def cmd_collect(args):
    """Collect results from a run directory."""
    run_dir = Path(args.run_dir)
    if not run_dir.exists():
        print(f"[KramaBench] Error: Run directory not found: {run_dir}")
        sys.exit(1)

    print("=" * 60)
    print(f"KramaBench Benchmark - Collect Results")
    print(f"Run directory: {run_dir}")
    print("=" * 60)

    # Collect results
    results = collect_results(run_dir)
    print(f"[KramaBench] Collected {len(results)} task results")

    if not results:
        print("[KramaBench] No results found!")
        return

    # Write detailed results
    results_file = run_dir / "results.json"
    write_results_json(results, results_file)
    print(f"[KramaBench] Results saved to: {results_file}")

    # Summary
    _print_summary(run_dir, results)


def cmd_evaluate(args):
    """Evaluate results against ground truth."""
    run_dir = Path(args.run_dir)
    if not run_dir.exists():
        print(f"[KramaBench] Error: Run directory not found: {run_dir}")
        sys.exit(1)

    print("=" * 60)
    print(f"KramaBench Benchmark - Evaluate Results")
    print(f"Run directory: {run_dir}")
    print("=" * 60)

    # Load config and tasks
    config = load_run_config(run_dir)
    data_dir = config.get("data_dir", DATA_DIR)
    domain = config.get("domain", "quick-start")

    if domain == "all":
        tasks = []
        for d in DOMAINS:
            try:
                tasks.extend(load_workload(d, data_dir))
            except:
                pass
    else:
        tasks = load_workload(domain, data_dir)

    if config.get("difficulty"):
        tasks = [t for t in tasks if t.difficulty == config["difficulty"]]
    if config.get("max_tasks"):
        tasks = tasks[:config["max_tasks"]]

    # Collect and evaluate results
    results = collect_results(run_dir)
    print(f"[KramaBench] Evaluating {len(results)} results...")

    results = evaluate_results(results, tasks)

    # Save evaluated results
    results_file = run_dir / "results_evaluated.json"
    write_results_json(results, results_file)
    print(f"[KramaBench] Evaluated results saved to: {results_file}")

    # Print evaluation summary
    _print_evaluation_summary(results)


def cmd_analyze(args):
    """Analyze workflow results from a benchmark run."""
    run_dir = Path(args.run_dir)
    if not run_dir.exists():
        print(f"[KramaBench] Error: Run directory not found: {run_dir}")
        sys.exit(1)

    print("=" * 60)
    print(f"KramaBench Benchmark - Analyze Workflows")
    print(f"Run directory: {run_dir}")
    print("=" * 60)

    # Try to use the workflow analyzer
    try:
        from analyzer.workflow_analyzer import WorkflowAnalyzer

        workflows = []
        for task_dir in sorted(run_dir.iterdir()):
            if not task_dir.is_dir() or not task_dir.name.startswith("task_"):
                continue
            workflow_file = task_dir / "workflow.json"
            if workflow_file.exists():
                with open(workflow_file) as f:
                    workflows.append({
                        "task_id": task_dir.name.replace("task_", ""),
                        "workflow": json.load(f),
                    })

        print(f"[KramaBench] Analyzing {len(workflows)} workflows...")

        # Aggregate metrics
        total_operators = 0
        total_links = 0
        operator_counts = {}
        shapes = {}

        for w in workflows:
            analyzer = WorkflowAnalyzer(w["workflow"])
            metrics = analyzer.analyze()

            total_operators += metrics.num_operators
            total_links += metrics.num_links

            for op_type, count in metrics.operator_counts.items():
                operator_counts[op_type] = operator_counts.get(op_type, 0) + count

            shape = metrics.shape
            shapes[shape] = shapes.get(shape, 0) + 1

        print(f"\n=== Workflow Analysis ===")
        print(f"Total workflows: {len(workflows)}")
        print(f"Total operators: {total_operators}")
        print(f"Total links: {total_links}")
        print(f"Avg operators/workflow: {total_operators / len(workflows):.1f}" if workflows else "N/A")

        print(f"\nOperator distribution:")
        for op_type, count in sorted(operator_counts.items(), key=lambda x: -x[1]):
            print(f"  {op_type}: {count}")

        print(f"\nWorkflow shapes:")
        for shape, count in sorted(shapes.items(), key=lambda x: -x[1]):
            print(f"  {shape}: {count}")

        # Save analysis
        analysis_file = run_dir / "analysis.json"
        with open(analysis_file, 'w') as f:
            json.dump({
                "total_workflows": len(workflows),
                "total_operators": total_operators,
                "total_links": total_links,
                "operator_counts": operator_counts,
                "shapes": shapes,
            }, f, indent=2)
        print(f"\n[KramaBench] Analysis saved to: {analysis_file}")

    except ImportError:
        print("[KramaBench] Workflow analyzer not available")
        print("[KramaBench] Collecting basic workflow statistics...")

        # Basic stats without analyzer
        workflow_count = 0
        for task_dir in run_dir.iterdir():
            if task_dir.is_dir() and task_dir.name.startswith("task_"):
                if (task_dir / "workflow.json").exists():
                    workflow_count += 1

        print(f"[KramaBench] Found {workflow_count} workflow files")


def _print_summary(run_dir: Path, results: List[Dict] = None, tasks: List[KramaBenchTask] = None):
    """Print run summary."""
    if results is None:
        results = collect_results(run_dir)

    print("\n" + "=" * 60)
    print(f"Run directory: {run_dir}")
    print(f"Completed: {len(results)} tasks")

    # Domain breakdown
    domain_counts = {}
    for r in results:
        d = r.get("domain", "unknown")
        domain_counts[d] = domain_counts.get(d, 0) + 1
    if len(domain_counts) > 1:
        print(f"By domain: {domain_counts}")

    # Difficulty breakdown
    difficulty_counts = {}
    for r in results:
        diff = r.get("difficulty", "unknown")
        if diff:
            difficulty_counts[diff] = difficulty_counts.get(diff, 0) + 1
    if difficulty_counts:
        print(f"By difficulty: {difficulty_counts}")

    # Scores if available
    scores = [r.get("score") for r in results if r.get("score") is not None]
    if scores:
        avg_score = sum(scores) / len(scores)
        print(f"Average score: {avg_score:.2%}")

    # Errors
    errors = sum(1 for r in results if r.get("error"))
    if errors:
        print(f"Errors: {errors}")

    # Total time
    total_time = sum(r.get("elapsed", 0) for r in results)
    print(f"Total time: {total_time:.1f}s")
    print("=" * 60)


def _print_evaluation_summary(results: List[Dict]):
    """Print evaluation summary."""
    print("\n" + "=" * 60)
    print("Evaluation Summary")
    print("=" * 60)

    # Overall stats
    scores = [r.get("score", 0) for r in results if "evaluation" in r]
    exact_matches = sum(1 for r in results if r.get("evaluation", {}).get("exact_match", False))

    print(f"Total evaluated: {len(scores)}")
    print(f"Exact matches: {exact_matches} ({exact_matches / len(scores):.1%})" if scores else "")
    print(f"Average score: {sum(scores) / len(scores):.2%}" if scores else "N/A")

    # By answer type
    by_type = {}
    for r in results:
        if "evaluation" not in r:
            continue
        atype = r.get("answer_type", "unknown")
        if atype not in by_type:
            by_type[atype] = {"scores": [], "exact": 0}
        by_type[atype]["scores"].append(r.get("score", 0))
        if r.get("evaluation", {}).get("exact_match"):
            by_type[atype]["exact"] += 1

    if by_type:
        print("\nBy answer type:")
        for atype, data in sorted(by_type.items()):
            avg = sum(data["scores"]) / len(data["scores"]) if data["scores"] else 0
            print(f"  {atype}: {avg:.2%} avg, {data['exact']}/{len(data['scores'])} exact")

    # By difficulty
    by_diff = {}
    for r in results:
        if "evaluation" not in r:
            continue
        diff = r.get("difficulty", "unknown")
        if not diff:
            continue
        if diff not in by_diff:
            by_diff[diff] = {"scores": [], "exact": 0}
        by_diff[diff]["scores"].append(r.get("score", 0))
        if r.get("evaluation", {}).get("exact_match"):
            by_diff[diff]["exact"] += 1

    if by_diff:
        print("\nBy difficulty:")
        for diff in ["easy", "medium", "hard"]:
            if diff in by_diff:
                data = by_diff[diff]
                avg = sum(data["scores"]) / len(data["scores"]) if data["scores"] else 0
                print(f"  {diff}: {avg:.2%} avg, {data['exact']}/{len(data['scores'])} exact")

    print("=" * 60)


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="KramaBench Benchmark Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Start a new run with quick-start domain (small test)
  python -m benchmarks.kramabench run --domain quick-start

  # Start a new run for environment domain
  python -m benchmarks.kramabench run --domain environment

  # Run with specific model and limited tasks
  python -m benchmarks.kramabench run --domain environment --model claude-haiku-4.5 --max-tasks 5

  # Run only easy tasks
  python -m benchmarks.kramabench run --domain environment --difficulty easy

  # Resume an interrupted run
  python -m benchmarks.kramabench resume runs/kramabench/20260110_120000_environment_dataflow

  # Evaluate results
  python -m benchmarks.kramabench evaluate runs/kramabench/20260110_120000_environment_dataflow
        """
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # === run command ===
    run_parser = subparsers.add_parser("run", help="Start a new benchmark run")
    run_parser.add_argument("--domain", default="quick-start",
                           help=f"Domain to run: {', '.join(WORKLOAD_FILES.keys())}, or 'all'")
    run_parser.add_argument("--difficulty", choices=["easy", "medium", "hard"],
                           help="Filter tasks by difficulty")
    run_parser.add_argument("--max-tasks", type=int, help="Limit number of tasks")
    run_parser.add_argument("--data-dir", default=DATA_DIR, help="Data directory")
    run_parser.add_argument("--skip-download", action="store_true", help="Skip data download")
    run_parser.add_argument("--force-download", action="store_true", help="Force re-download data")
    run_parser.add_argument("--model", default=AGENT_MODEL_TYPE, help="Model type")
    run_parser.add_argument("--max-steps", type=int, default=AGENT_MAX_STEPS, help="Max agent steps")
    run_parser.add_argument("--agent-mode", choices=["code", "general"], default=AGENT_MODE)
    run_parser.add_argument("--result-format", choices=["json", "table", "toon"],
                           default=AGENT_OPERATOR_RESULT_SERIALIZATION_MODE)
    run_parser.add_argument("--max-result-chars", type=int, default=AGENT_MAX_OPERATOR_RESULT_CHAR_LIMIT)
    run_parser.add_argument("--max-cell-chars", type=int, default=AGENT_MAX_OPERATOR_RESULT_CELL_CHAR_LIMIT)
    run_parser.add_argument("--tool-timeout", type=int, default=AGENT_TOOL_TIMEOUT_SECONDS)
    run_parser.add_argument("--exec-timeout", type=int, default=AGENT_EXECUTION_TIMEOUT_MINUTES)
    run_parser.add_argument("--baseline", action="store_true", help="Use smolagents CodeAgent")
    run_parser.add_argument("--retain", action="store_true", help="Keep agents after tasks")
    run_parser.add_argument("--no-cleanup", action="store_true", help="Skip initial cleanup")
    run_parser.add_argument("--allow-non-relational", action="store_true",
                           help="Allow non-relational operators")
    run_parser.add_argument("--verbosity", type=int, default=1, help="0=quiet, 1=normal, 2=verbose")
    run_parser.add_argument("--reverse", action="store_true", help="Run tasks in reverse order")

    # === resume command ===
    resume_parser = subparsers.add_parser("resume", help="Resume an interrupted run")
    resume_parser.add_argument("run_dir", help="Path to run directory")
    resume_parser.add_argument("--rerun-tasks", help="Comma-separated task IDs to re-run")
    resume_parser.add_argument("--only", action="store_true",
                              help="Only run tasks specified by --rerun-tasks")
    resume_parser.add_argument("--no-cleanup", action="store_true", help="Skip initial cleanup")
    resume_parser.add_argument("--verbosity", type=int, default=1)
    resume_parser.add_argument("--reverse", action="store_true")

    # === retry command ===
    retry_parser = subparsers.add_parser("retry", help="Retry errored tasks from a run")
    retry_parser.add_argument("run_dir", help="Path to run directory")
    retry_parser.add_argument("--no-cleanup", action="store_true", help="Skip initial cleanup")
    retry_parser.add_argument("--verbosity", type=int, default=1)
    retry_parser.add_argument("--reverse", action="store_true")

    # === collect command ===
    collect_parser = subparsers.add_parser("collect", help="Collect results")
    collect_parser.add_argument("run_dir", help="Path to run directory")

    # === evaluate command ===
    evaluate_parser = subparsers.add_parser("evaluate", help="Evaluate results against ground truth")
    evaluate_parser.add_argument("run_dir", help="Path to run directory")

    # === analyze command ===
    analyze_parser = subparsers.add_parser("analyze", help="Analyze workflow DAG structure")
    analyze_parser.add_argument("run_dir", help="Path to run directory")

    args = parser.parse_args()

    if args.command == "run":
        cmd_run(args)
    elif args.command == "resume":
        cmd_resume(args)
    elif args.command == "retry":
        cmd_retry(args)
    elif args.command == "collect":
        cmd_collect(args)
    elif args.command == "evaluate":
        cmd_evaluate(args)
    elif args.command == "analyze":
        cmd_analyze(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
