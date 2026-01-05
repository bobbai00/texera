# -*- coding: utf-8 -*-
"""
DataSciBench Benchmark Runner for Texera Agent Service

Runs the DataSciBench benchmark (https://github.com/THUDM/DataSciBench) using
DataflowAgent. This benchmark evaluates agents on multi-step data science tasks.

Task Types (by prefix):
    - bcb: BigCodeBench code generation tasks (167 tasks) - evaluated via unit tests
    - csv_excel: CSV/Excel data manipulation tasks (20 tasks)
    - dl: Deep learning tasks (10 tasks)
    - human: Human-written data science tasks (25 tasks)

Task Groupings:
    - exec: Execution output tasks (csv_excel + dl + human = 55 tasks)
            These are non-codegen tasks evaluated by checking output files
    - bcb: Code generation tasks evaluated via unit tests

Usage:
    # List available tasks
    python -m benchmarks.datascibench list

    # Run all execution output tasks (non-codegen)
    python -m benchmarks.datascibench run --task-type exec

    # Run specific task types
    python -m benchmarks.datascibench run --task-type human

    # Resume an interrupted run
    python -m benchmarks.datascibench resume runs/datascibench/20260104_120000_dataflow

    # Collect and evaluate results
    python -m benchmarks.datascibench collect runs/datascibench/20260104_120000_dataflow

    # Evaluate results using metric functions
    python -m benchmarks.datascibench evaluate runs/datascibench/20260104_120000_dataflow
"""

import os
import sys
import time
import json
import argparse
import threading
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any, Set

import yaml

from agents.dataflow_agent import (
    DataflowAgent, MessageResult, delete_all_agents, list_all_agents,
    get_agent_workflow, AGENT_MODEL_TYPE, AGENT_MAX_STEPS,
    AGENT_MAX_OPERATOR_RESULT_CHAR_LIMIT, AGENT_MAX_OPERATOR_RESULT_CELL_CHAR_LIMIT,
    AGENT_OPERATOR_RESULT_SERIALIZATION_MODE, AGENT_TOOL_TIMEOUT_SECONDS,
    AGENT_EXECUTION_TIMEOUT_MINUTES, AGENT_MODE, TEXERA_AGENT_SERVICE_ENDPOINT,
)

# =============================================================================
# Constants
# =============================================================================

DATASCIBENCH_DIR = Path(__file__).parent / "DataSciBench"
DATA_DIR = DATASCIBENCH_DIR / "data"
METRIC_DIR = DATASCIBENCH_DIR / "metric"
INPUT_DATA_DIR = DATASCIBENCH_DIR / "DataSciBench-data"
RUNS_DIR = Path(__file__).parent.parent / "runs" / "datascibench"

# HuggingFace dataset info
HF_DATASET_ID = "zd21/DataSciBench"
HF_DATA_FILE = "DataSciBench_GroundTruth_Data.zip"

# Task types - maps CLI option to task_id prefix
# These are based on task_id prefixes in the dataset
TASK_PREFIXES = {
    "bcb": "bcb",           # 167 tasks - BigCodeBench code generation (evaluated via unit tests)
    "csv_excel": "csv_excel",  # 20 tasks - CSV/Excel data manipulation
    "dl": "dl",             # 10 tasks - Deep learning tasks
    "human": "human",       # 25 tasks - Human-written data science tasks
}

# Special task type groupings
# "exec" = execution output tasks (non-codegen) - evaluated by checking output files
EXEC_PREFIXES = ["csv_excel", "dl", "human"]  # 55 tasks total

# Legacy data_source_type mapping (for reference)
DATA_SOURCE_TYPES = {
    "1=no dependency": "Self-contained tasks (data in prompt)",
    "1_bcb": "BigCodeBench code generation tasks",
    "2=open source data": "Tasks using public datasets",
    "2=has dependency": "Tasks with external dependencies",
    "3=human written data": "Tasks with custom datasets",
}

# Prompt template for DataSciBench tasks (type 1 - no input data)
PROMPT_TEMPLATE_NO_INPUT = """You are an expert data scientist. Complete the following data science task.

IMPORTANT: You MUST save all output files to this directory:
{output_dir}

For example, if the task asks you to save "output.csv", save it as:
{output_dir}/output.csv

Task:
{prompt}

Instructions:
1. Analyze the task requirements carefully
2. Write and execute code to complete the task
3. Save ALL outputs to the directory specified above (use the full absolute path)
4. Verify that the output files are created correctly
"""

# Prompt template for DataSciBench tasks (type 2/3 - with input data)
PROMPT_TEMPLATE_WITH_INPUT = """You are an expert data scientist. Complete the following data science task.

## Input Data Files
The following input data files are available for this task:
{input_files_section}

## Output Directory
IMPORTANT: You MUST save all output files to this directory:
{output_dir}

For example, if the task asks you to save "output.csv", save it as:
{output_dir}/output.csv

## Task
{prompt}

## Instructions
1. Read the input data files from the absolute paths provided above
2. Analyze the task requirements carefully
3. Write and execute code to complete the task
4. Save ALL outputs to the output directory specified above (use the full absolute path)
5. Verify that the output files are created correctly
"""


# =============================================================================
# Input Data Discovery
# =============================================================================

def get_input_data_files(task_id: str) -> List[str]:
    """Get list of absolute paths to input data files for a task.

    Looks in DataSciBench-data/{task_id}/ for input files.
    Excludes prompt.json and other metadata files.

    Returns:
        List of absolute file paths to input data files
    """
    input_dir = INPUT_DATA_DIR / task_id
    if not input_dir.exists():
        return []

    input_files = []
    excluded = {"prompt.json", ".DS_Store"}

    for item in input_dir.rglob("*"):
        if item.is_file() and item.name not in excluded:
            input_files.append(str(item.absolute()))

    return sorted(input_files)


def format_input_files_section(input_files: List[str]) -> str:
    """Format input files as a readable section for the prompt.

    Args:
        input_files: List of absolute file paths

    Returns:
        Formatted string listing files with their paths
    """
    if not input_files:
        return "No input data files available."

    lines = []
    for filepath in input_files:
        # Get just the filename for display
        filename = Path(filepath).name
        lines.append(f"- {filename}: {filepath}")

    return "\n".join(lines)


def build_task_prompt(task: Dict, output_dir: str) -> str:
    """Build the full prompt for a task, including input data paths if needed.

    Args:
        task: Task dictionary with prompt, data_source_type, task_id
        output_dir: Absolute path to output directory

    Returns:
        Complete prompt string
    """
    task_id = task["task_id"]
    data_source_type = task.get("data_source_type", "")

    # Check if this task type needs input data (type 2 or 3)
    needs_input_data = not data_source_type.startswith("1")

    if needs_input_data:
        # Get input files for this task
        input_files = get_input_data_files(task_id)

        if input_files:
            # Use template with input data section
            input_section = format_input_files_section(input_files)
            return PROMPT_TEMPLATE_WITH_INPUT.format(
                input_files_section=input_section,
                output_dir=output_dir,
                prompt=task["prompt"],
            )

    # Use simple template (no input data or type 1 task)
    return PROMPT_TEMPLATE_NO_INPUT.format(
        output_dir=output_dir,
        prompt=task["prompt"],
    )


# =============================================================================
# Data Loading
# =============================================================================

def load_tasks(
    task_type: Optional[str] = None,
    max_tasks: Optional[int] = None,
    task_ids: Optional[List[str]] = None,
) -> List[Dict]:
    """Load tasks from DataSciBench data directory.

    Args:
        task_type: Filter by task prefix (bcb, csv_excel, dl, human, exec) or 'all'
                   - 'exec' = execution output tasks (csv_excel, dl, human) - non-codegen
                   - 'bcb' = code generation tasks (evaluated via unit tests)
        max_tasks: Limit number of tasks to load
        task_ids: Specific task IDs to load (overrides task_type)
    """
    tasks = []

    # Get prefix filter(s) if specified
    prefix_filter = None
    prefix_list = None  # For multi-prefix filters like "exec"
    if task_type and task_type != "all":
        if task_type == "exec":
            # "exec" = execution output tasks (non-codegen)
            prefix_list = EXEC_PREFIXES
        else:
            prefix_filter = TASK_PREFIXES.get(task_type)

    for task_dir in sorted(DATA_DIR.iterdir()):
        if not task_dir.is_dir():
            continue

        task_id = task_dir.name
        prompt_file = task_dir / "prompt.json"
        metric_file = METRIC_DIR / task_id / "metric.yaml"

        # Skip tasks without prompt or metric
        if not prompt_file.exists():
            continue
        if not metric_file.exists():
            continue

        # Filter by task_ids if specified (takes precedence)
        if task_ids and task_id not in task_ids:
            continue

        # Filter by prefix if specified
        if prefix_filter and not task_id.startswith(prefix_filter):
            continue
        # Filter by prefix list if specified (for "exec" type)
        if prefix_list and not any(task_id.startswith(p) for p in prefix_list):
            continue

        # Load prompt
        with open(prompt_file) as f:
            prompt_data = json.load(f)

        data_source_type = prompt_data.get("data_source_type", "unknown")

        tasks.append({
            "task_id": task_id,
            "prompt": prompt_data.get("prompt", ""),
            "data_source_type": data_source_type,
            "task_dir": str(task_dir),
            "metric_file": str(metric_file),
        })

        if max_tasks and len(tasks) >= max_tasks:
            break

    return tasks


def load_metric(metric_file: str) -> Dict:
    """Load metric configuration from YAML file."""
    with open(metric_file) as f:
        content = f.read()

    # Handle the special format of metric.yaml
    try:
        data = yaml.safe_load(content)
        return data
    except Exception:
        return {}


# =============================================================================
# Run Directory Management
# =============================================================================

def create_run_dir(task_type: str = "no_dependency") -> Path:
    """Create a new run directory."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_name = f"{timestamp}_{task_type}_dataflow"
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
            except Exception:
                pass
    return completed


def save_task_result(run_dir: Path, task_id: str, result: Dict):
    """Save a single task result to its directory."""
    task_dir = run_dir / f"task_{task_id}"
    task_dir.mkdir(parents=True, exist_ok=True)
    result_file = task_dir / "result.json"
    with open(result_file, 'w') as f:
        json.dump(result, f, indent=2)


# =============================================================================
# Task Runner
# =============================================================================

def run_dataflow_task(
    task: Dict,
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
) -> Dict:
    """Run a single task with DataflowAgent."""
    task_id = task["task_id"]
    task_dir = run_dir / f"task_{task_id}"
    task_dir.mkdir(parents=True, exist_ok=True)

    # Build prompt with absolute output directory path and input data files
    output_dir = str(task_dir.absolute())
    prompt = build_task_prompt(task, output_dir)

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
        workflow_name=f"DataSciBench-{task_id}",
        agent_name=f"datascibench-{task_id}",
    )

    start = time.time()
    result = {
        "task_id": task_id,
        "data_source_type": task["data_source_type"],
        "response": "",
        "error": None,
        "elapsed": 0,
        "outputs": [],
    }

    try:
        agent.setup()
        msg_result = agent.run(prompt)
        result["response"] = msg_result.response or ""
        result["error"] = msg_result.error

        # Save task files
        _save_task_files(task_dir, task, prompt, result, msg_result, agent)

        # Detect output files created by the agent
        output_files = _detect_output_files(task_dir)
        result["outputs"] = output_files

    except Exception as e:
        result["error"] = str(e)
    finally:
        result["elapsed"] = time.time() - start
        if not retain:
            agent.cleanup()

    # Save result immediately
    save_task_result(run_dir, task_id, result)
    return result


def _detect_output_files(task_dir: Path) -> List[str]:
    """Detect output files created by the agent (excluding trace files)."""
    trace_files = {"prompt.txt", "response.txt", "result.json", "trace.json", "workflow.json"}
    output_files = []
    for f in task_dir.iterdir():
        if f.is_file() and f.name not in trace_files:
            output_files.append(f.name)
    return output_files


def _save_task_files(
    task_dir: Path,
    task: Dict,
    prompt: str,
    result: Dict,
    msg_result: MessageResult,
    agent: DataflowAgent
):
    """Save task-level files for debugging."""
    # Save prompt
    with open(task_dir / "prompt.txt", 'w') as f:
        f.write(prompt)

    # Save response
    with open(task_dir / "response.txt", 'w') as f:
        f.write(result.get("response", ""))

    # Save trace
    if msg_result:
        with open(task_dir / "trace.json", 'w') as f:
            json.dump({
                "response": msg_result.response,
                "messages": msg_result.messages,
                "usage": msg_result.usage,
                "stats": msg_result.stats,
            }, f, indent=2)

    # Save workflow
    try:
        workflow = get_agent_workflow(agent.agent_id)
        with open(task_dir / "workflow.json", 'w') as f:
            json.dump(workflow, f, indent=2)
    except Exception:
        pass


# =============================================================================
# Benchmark Runner
# =============================================================================

_print_lock = threading.Lock()


def _log(msg: str):
    with _print_lock:
        print(msg)


def run_benchmark(
    tasks: List[Dict],
    run_dir: Path,
    skip_task_ids: Optional[Set[str]] = None,
    **agent_kwargs,
) -> List[Dict]:
    """Run the benchmark sequentially, skipping completed tasks."""
    skip_task_ids = skip_task_ids or set()

    # Filter tasks
    tasks_to_run = [t for t in tasks if t["task_id"] not in skip_task_ids]
    total = len(tasks)
    skipped = len(skip_task_ids)

    print(f"\n[DataSciBench] Running {len(tasks_to_run)} tasks")
    if skipped:
        print(f"[DataSciBench] Skipping {skipped} already completed tasks")

    results = []
    for i, task in enumerate(tasks_to_run):
        task_num = skipped + i + 1
        _log(f"\n[{task_num}/{total}] Task {task['task_id']}: {task['prompt'][:60]}...")
        result = run_dataflow_task(task, run_dir, **agent_kwargs)
        results.append(result)

        status = "ERROR" if result.get("error") else "OK"
        _log(f"  Status: {status} ({result['elapsed']:.1f}s)")

    return results


def cleanup_agents():
    """Delete all existing agents."""
    try:
        agents = list_all_agents(TEXERA_AGENT_SERVICE_ENDPOINT)
        if agents:
            print(f"[DataSciBench] Cleaning up {len(agents)} agents...")
            delete_all_agents(TEXERA_AGENT_SERVICE_ENDPOINT)
    except Exception as e:
        print(f"[DataSciBench] Cleanup failed: {e}")


# =============================================================================
# Result Collection
# =============================================================================

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


# =============================================================================
# Evaluation
# =============================================================================

def evaluate_task(task_id: str, task_dir: Path) -> Dict:
    """Evaluate a single task using its metric functions."""
    metric_file = METRIC_DIR / task_id / "metric.yaml"
    if not metric_file.exists():
        return {"task_id": task_id, "error": "No metric file found", "scores": []}

    # Load metric
    metric_data = load_metric(str(metric_file))
    tmc_list = metric_data.get("TMC-list", [])

    if not tmc_list:
        return {"task_id": task_id, "error": "No metrics defined", "scores": []}

    scores = []
    original_cwd = os.getcwd()

    try:
        # Change to task directory for evaluation
        os.chdir(task_dir)

        for metric in tmc_list:
            metric_name = metric.get("metric", "unknown")
            code = metric.get("code", "")
            ground_truth = metric.get("ground_truth", "")

            if not code:
                scores.append({
                    "metric": metric_name,
                    "score": 0,
                    "error": "No evaluation code",
                })
                continue

            try:
                # Execute the metric function
                local_vars = {}
                exec(code, {"__builtins__": __builtins__}, local_vars)

                # Find and call the function
                func_name = None
                for name, obj in local_vars.items():
                    if callable(obj) and not name.startswith("_"):
                        func_name = name
                        break

                if func_name:
                    func = local_vars[func_name]
                    # Pass ground truth path if specified
                    if ground_truth:
                        gt_path = METRIC_DIR / task_id / ground_truth
                        if gt_path.exists():
                            result = func(str(gt_path))
                        else:
                            result = func(ground_truth)
                    else:
                        result = func(None)

                    # Convert result to score (2 for pass, 0 for fail)
                    if isinstance(result, bool):
                        score = 2 if result else 0
                    elif isinstance(result, (int, float)):
                        score = 2 if result >= 1 else 0
                    else:
                        score = 2 if result else 0

                    scores.append({
                        "metric": metric_name,
                        "score": score,
                        "result": str(result),
                    })
                else:
                    scores.append({
                        "metric": metric_name,
                        "score": 0,
                        "error": "No function found in metric code",
                    })

            except Exception as e:
                scores.append({
                    "metric": metric_name,
                    "score": 0,
                    "error": str(e),
                })

    finally:
        os.chdir(original_cwd)

    # Calculate completion rate (CR)
    total_possible = len(scores) * 2
    total_score = sum(s.get("score", 0) for s in scores)
    cr = total_score / total_possible if total_possible > 0 else 0

    return {
        "task_id": task_id,
        "scores": scores,
        "completion_rate": cr,
    }


def evaluate_run(run_dir: Path) -> List[Dict]:
    """Evaluate all tasks in a run directory."""
    evaluations = []

    for task_dir in sorted(run_dir.iterdir()):
        if not task_dir.is_dir() or not task_dir.name.startswith("task_"):
            continue

        task_id = task_dir.name.replace("task_", "")
        print(f"  Evaluating {task_id}...", end=" ")

        eval_result = evaluate_task(task_id, task_dir)
        evaluations.append(eval_result)

        if eval_result.get("error"):
            print(f"ERROR: {eval_result['error']}")
        else:
            print(f"CR: {eval_result['completion_rate']:.2f}")

    return evaluations


# =============================================================================
# Data Setup
# =============================================================================

def download_and_extract_data(force: bool = False) -> bool:
    """Download and extract DataSciBench data from HuggingFace.

    Downloads two things:
    1. DataSciBench_GroundTruth_Data.zip - Contains gt_data/ (ground truth outputs)
    2. DataSciBench-data/ folder - Contains input data files for type 2/3 tasks
    """
    from huggingface_hub import hf_hub_download, snapshot_download

    # Check if data already exists
    data_marker = DATASCIBENCH_DIR / "data" / ".data_downloaded"
    if data_marker.exists() and not force:
        print("[DataSciBench] Data already downloaded. Use --force to re-download.")
        return True

    print("=" * 60)
    print("DataSciBench - Setup")
    print("=" * 60)
    print(f"\nDownloading data from HuggingFace: {HF_DATASET_ID}")
    print("Note: This is a gated dataset. You must be logged in to HuggingFace.")
    print("      Run 'huggingface-cli login' if you haven't already.\n")

    try:
        # 1. Download the ground truth zip file
        print(f"[DataSciBench] Downloading {HF_DATA_FILE} (ground truth outputs)...")
        zip_path = hf_hub_download(
            repo_id=HF_DATASET_ID,
            repo_type="dataset",
            filename=HF_DATA_FILE,
            local_dir=DATASCIBENCH_DIR,
        )
        print(f"[DataSciBench] Downloaded to: {zip_path}")

        # Extract the zip file
        print(f"[DataSciBench] Extracting {HF_DATA_FILE}...")
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            contents = zip_ref.namelist()
            print(f"[DataSciBench] Archive contains {len(contents)} files/folders")
            zip_ref.extractall(DATASCIBENCH_DIR)
        print(f"[DataSciBench] Extracted gt_data/ to: {DATASCIBENCH_DIR}")

        # 2. Download input data folder (for type 2/3 tasks)
        print(f"\n[DataSciBench] Downloading DataSciBench-data/ (input files for type 2/3 tasks)...")
        snapshot_download(
            repo_id=HF_DATASET_ID,
            repo_type="dataset",
            allow_patterns=["DataSciBench-data/*"],
            local_dir=DATASCIBENCH_DIR,
        )
        print(f"[DataSciBench] Downloaded input data to: {INPUT_DATA_DIR}")

        # Create marker file
        data_marker.parent.mkdir(parents=True, exist_ok=True)
        data_marker.write_text(f"Downloaded: {datetime.now().isoformat()}\n")

        # Show what was extracted
        print("\n[DataSciBench] Checking extracted data...")
        _show_data_summary()

        return True

    except Exception as e:
        print(f"\n[DataSciBench] Error: {e}")
        if "401" in str(e) or "403" in str(e) or "gated" in str(e).lower():
            print("\nThis is a gated dataset. Please:")
            print("  1. Run: huggingface-cli login")
            print("  2. Visit: https://huggingface.co/datasets/zd21/DataSciBench")
            print("  3. Accept the terms to access the dataset")
        return False


def _show_data_summary():
    """Show summary of available data files."""
    print("\nData directories:")

    # Ground truth outputs
    gt_dir = DATASCIBENCH_DIR / "gt_data"
    if gt_dir.exists():
        task_dirs = [d for d in gt_dir.iterdir() if d.is_dir()]
        print(f"  gt_data/: {len(task_dirs)} task directories (ground truth outputs)")

    # Input data for type 2/3 tasks
    if INPUT_DATA_DIR.exists():
        files = list(INPUT_DATA_DIR.rglob("*"))
        file_count = sum(1 for f in files if f.is_file())
        print(f"  DataSciBench-data/: {file_count} input files (for type 2/3 tasks)")

    # Task prompts
    if DATA_DIR.exists():
        task_dirs = [d for d in DATA_DIR.iterdir() if d.is_dir()]
        print(f"  data/: {len(task_dirs)} task directories (prompts)")


# =============================================================================
# CLI Commands
# =============================================================================

def cmd_setup(args):
    """Download and setup DataSciBench data files."""
    success = download_and_extract_data(force=args.force)
    if success:
        print("\n[DataSciBench] Setup complete!")
    else:
        print("\n[DataSciBench] Setup failed.")
        sys.exit(1)


def cmd_list(args):
    """List available tasks."""
    print("=" * 60)
    print("DataSciBench - Available Tasks")
    print("=" * 60)

    all_tasks = load_tasks(task_type="all")

    # Count by prefix (CLI task types)
    prefix_counts = {prefix: 0 for prefix in TASK_PREFIXES.keys()}
    for task in all_tasks:
        for prefix_name, prefix in TASK_PREFIXES.items():
            if task["task_id"].startswith(prefix):
                prefix_counts[prefix_name] += 1
                break

    print("\nTask counts by type (--task-type options):")
    print("  --- Individual types ---")
    for prefix_name, count in prefix_counts.items():
        desc = {
            "bcb": "BigCodeBench code generation (evaluated via unit tests)",
            "csv_excel": "CSV/Excel data manipulation",
            "dl": "Deep learning tasks",
            "human": "Human-written data science",
        }.get(prefix_name, "")
        print(f"  {count:4d}  {prefix_name:12s} - {desc}")

    # Show exec grouping (non-codegen tasks)
    exec_count = sum(prefix_counts.get(p, 0) for p in EXEC_PREFIXES)
    print("  --- Grouped types ---")
    print(f"  {exec_count:4d}  {'exec':12s} - Execution output tasks (csv_excel + dl + human, non-codegen)")
    print(f"  {prefix_counts.get('bcb', 0):4d}  {'bcb':12s} - Code generation tasks (evaluated via unit tests)")
    print(f"\n  Total: {len(all_tasks)} tasks")

    if args.verbose:
        print("\nTask IDs:")
        for task in all_tasks[:20]:
            print(f"  {task['task_id']}: {task['data_source_type']}")
        if len(all_tasks) > 20:
            print(f"  ... and {len(all_tasks) - 20} more")


def cmd_run(args):
    """Run a new benchmark."""
    print("=" * 60)
    print("DataSciBench Benchmark")
    print(f"Task type: {args.task_type} | Max tasks: {args.max_tasks or 'all'} | Model: {args.model}")
    print("=" * 60)

    # Cleanup
    if not args.no_cleanup:
        cleanup_agents()

    # Load tasks
    task_ids = args.task_ids.split(",") if args.task_ids else None
    tasks = load_tasks(
        task_type=args.task_type,
        max_tasks=args.max_tasks,
        task_ids=task_ids,
    )

    if not tasks:
        print("[DataSciBench] No tasks found matching criteria")
        sys.exit(1)

    print(f"[DataSciBench] Loaded {len(tasks)} tasks")

    # Create run directory
    run_dir = create_run_dir(args.task_type)
    print(f"[DataSciBench] Run directory: {run_dir}")

    # Save config
    config = {
        "task_type": args.task_type,
        "max_tasks": args.max_tasks,
        "task_ids": task_ids,
        "model": args.model,
        "max_steps": args.max_steps,
        "agent_mode": args.agent_mode,
        "result_format": args.result_format,
        "max_result_chars": args.max_result_chars,
        "max_cell_chars": args.max_cell_chars,
        "tool_timeout": args.tool_timeout,
        "exec_timeout": args.exec_timeout,
        "created_at": datetime.now().isoformat(),
    }
    save_run_config(run_dir, config)

    # Build agent kwargs
    agent_kwargs = {
        "model_type": args.model,
        "max_steps": args.max_steps,
        "verbosity": args.verbosity,
        "agent_mode": args.agent_mode,
        "result_format": args.result_format,
        "max_result_chars": args.max_result_chars,
        "max_cell_chars": args.max_cell_chars,
        "tool_timeout": args.tool_timeout,
        "exec_timeout": args.exec_timeout,
        "retain": args.retain,
    }

    # Run benchmark
    start_time = time.time()
    results = run_benchmark(tasks, run_dir, **agent_kwargs)
    total_time = time.time() - start_time

    # Summary
    _print_summary(run_dir, results, total_time)


def cmd_resume(args):
    """Resume an interrupted benchmark run."""
    run_dir = Path(args.run_dir)
    if not run_dir.exists():
        print(f"[DataSciBench] Error: Run directory not found: {run_dir}")
        sys.exit(1)

    # Load config
    config = load_run_config(run_dir)
    print("=" * 60)
    print("DataSciBench Benchmark - Resuming")
    print(f"Run directory: {run_dir}")
    print(f"Task type: {config.get('task_type')} | Model: {config.get('model')}")
    print("=" * 60)

    # Get completed tasks
    completed = get_completed_task_ids(run_dir)
    print(f"[DataSciBench] Found {len(completed)} completed tasks")

    # Cleanup
    if not args.no_cleanup:
        cleanup_agents()

    # Load tasks
    tasks = load_tasks(
        task_type=config.get("task_type"),
        max_tasks=config.get("max_tasks"),
        task_ids=config.get("task_ids"),
    )

    # Check if already complete
    if len(completed) >= len(tasks):
        print(f"[DataSciBench] All {len(tasks)} tasks already completed!")
        _print_summary(run_dir)
        return

    # Build agent kwargs from config
    agent_kwargs = {
        "model_type": config.get("model", AGENT_MODEL_TYPE),
        "max_steps": config.get("max_steps", AGENT_MAX_STEPS),
        "verbosity": args.verbosity,
        "agent_mode": config.get("agent_mode", AGENT_MODE),
        "result_format": config.get("result_format", AGENT_OPERATOR_RESULT_SERIALIZATION_MODE),
        "max_result_chars": config.get("max_result_chars", AGENT_MAX_OPERATOR_RESULT_CHAR_LIMIT),
        "max_cell_chars": config.get("max_cell_chars", AGENT_MAX_OPERATOR_RESULT_CELL_CHAR_LIMIT),
        "tool_timeout": config.get("tool_timeout", AGENT_TOOL_TIMEOUT_SECONDS),
        "exec_timeout": config.get("exec_timeout", AGENT_EXECUTION_TIMEOUT_MINUTES),
        "retain": False,
    }

    # Run benchmark, skipping completed
    start_time = time.time()
    results = run_benchmark(tasks, run_dir, skip_task_ids=completed, **agent_kwargs)
    total_time = time.time() - start_time

    # Summary
    _print_summary(run_dir, total_time=total_time)


def cmd_collect(args):
    """Collect results from a run directory."""
    run_dir = Path(args.run_dir)
    if not run_dir.exists():
        print(f"[DataSciBench] Error: Run directory not found: {run_dir}")
        sys.exit(1)

    print("=" * 60)
    print("DataSciBench - Collect Results")
    print(f"Run directory: {run_dir}")
    print("=" * 60)

    # Collect results
    results = collect_results(run_dir)
    print(f"[DataSciBench] Collected {len(results)} task results")

    if not results:
        print("[DataSciBench] No results found!")
        return

    # Write detailed results
    results_file = run_dir / "results.json"
    with open(results_file, 'w') as f:
        json.dump(results, f, indent=2)
    print(f"[DataSciBench] Results saved to: {results_file}")

    # Summary
    _print_summary(run_dir, results)


def cmd_evaluate(args):
    """Evaluate results using metric functions."""
    run_dir = Path(args.run_dir)
    if not run_dir.exists():
        print(f"[DataSciBench] Error: Run directory not found: {run_dir}")
        sys.exit(1)

    print("=" * 60)
    print("DataSciBench - Evaluate Results")
    print(f"Run directory: {run_dir}")
    print("=" * 60)

    print("\n[DataSciBench] Running metric evaluations...")
    evaluations = evaluate_run(run_dir)

    # Save evaluations
    eval_file = run_dir / "evaluations.json"
    with open(eval_file, 'w') as f:
        json.dump(evaluations, f, indent=2)
    print(f"\n[DataSciBench] Evaluations saved to: {eval_file}")

    # Calculate overall metrics
    valid_evals = [e for e in evaluations if not e.get("error")]
    if valid_evals:
        avg_cr = sum(e["completion_rate"] for e in valid_evals) / len(valid_evals)
        print(f"\n[DataSciBench] Overall Completion Rate: {avg_cr:.2%}")
        print(f"[DataSciBench] Tasks evaluated: {len(valid_evals)}/{len(evaluations)}")


def _print_summary(run_dir: Path, results: List[Dict] = None, total_time: float = None):
    """Print run summary."""
    if results is None:
        results = collect_results(run_dir)

    print("\n" + "=" * 60)
    print(f"Run directory: {run_dir}")
    print(f"Completed: {len(results)} tasks")

    errors = sum(1 for r in results if r.get("error"))
    if errors:
        print(f"Errors: {errors}")

    if total_time:
        print(f"Total time: {total_time:.1f}s")
    else:
        task_time = sum(r.get("elapsed", 0) for r in results)
        print(f"Task time: {task_time:.1f}s")

    print("=" * 60)


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="DataSciBench Benchmark Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # List available tasks
  python -m benchmarks.datascibench list

  # Run no-dependency tasks (6 tasks)
  python -m benchmarks.datascibench run

  # Run specific task types
  python -m benchmarks.datascibench run --task-type bcb --max-tasks 5

  # Run specific tasks by ID
  python -m benchmarks.datascibench run --task-ids csv_excel_0,csv_excel_3

  # Resume an interrupted run
  python -m benchmarks.datascibench resume runs/datascibench/20260104_120000_dataflow

  # Collect and evaluate results
  python -m benchmarks.datascibench collect runs/datascibench/20260104_120000_dataflow
  python -m benchmarks.datascibench evaluate runs/datascibench/20260104_120000_dataflow
        """
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # === setup command ===
    setup_parser = subparsers.add_parser("setup", help="Download DataSciBench data files")
    setup_parser.add_argument("--force", action="store_true", help="Force re-download")

    # === list command ===
    list_parser = subparsers.add_parser("list", help="List available tasks")
    list_parser.add_argument("-v", "--verbose", action="store_true", help="Show task IDs")

    # === run command ===
    run_parser = subparsers.add_parser("run", help="Start a new benchmark run")
    run_parser.add_argument("--task-type", default="all",
                           choices=["all", "exec", "bcb", "csv_excel", "dl", "human"],
                           help="Type of tasks to run: 'exec' = execution output tasks (non-codegen), 'bcb' = code generation")
    run_parser.add_argument("--task-ids", help="Comma-separated task IDs to run")
    run_parser.add_argument("--max-tasks", type=int, help="Limit number of tasks")
    run_parser.add_argument("--model", default=AGENT_MODEL_TYPE, help="Model type")
    run_parser.add_argument("--max-steps", type=int, default=AGENT_MAX_STEPS, help="Max agent steps")
    run_parser.add_argument("--agent-mode", choices=["code", "general"], default=AGENT_MODE)
    run_parser.add_argument("--result-format", choices=["json", "table", "toon"],
                           default=AGENT_OPERATOR_RESULT_SERIALIZATION_MODE)
    run_parser.add_argument("--max-result-chars", type=int, default=AGENT_MAX_OPERATOR_RESULT_CHAR_LIMIT)
    run_parser.add_argument("--max-cell-chars", type=int, default=AGENT_MAX_OPERATOR_RESULT_CELL_CHAR_LIMIT)
    run_parser.add_argument("--tool-timeout", type=int, default=AGENT_TOOL_TIMEOUT_SECONDS)
    run_parser.add_argument("--exec-timeout", type=int, default=AGENT_EXECUTION_TIMEOUT_MINUTES)
    run_parser.add_argument("--retain", action="store_true", help="Keep agents after tasks")
    run_parser.add_argument("--no-cleanup", action="store_true", help="Skip initial cleanup")
    run_parser.add_argument("--verbosity", type=int, default=1, help="0=quiet, 1=normal, 2=verbose")

    # === resume command ===
    resume_parser = subparsers.add_parser("resume", help="Resume an interrupted run")
    resume_parser.add_argument("run_dir", help="Path to run directory")
    resume_parser.add_argument("--no-cleanup", action="store_true", help="Skip initial cleanup")
    resume_parser.add_argument("--verbosity", type=int, default=1, help="0=quiet, 1=normal, 2=verbose")

    # === collect command ===
    collect_parser = subparsers.add_parser("collect", help="Collect results from a run")
    collect_parser.add_argument("run_dir", help="Path to run directory")

    # === evaluate command ===
    eval_parser = subparsers.add_parser("evaluate", help="Evaluate results using metrics")
    eval_parser.add_argument("run_dir", help="Path to run directory")

    args = parser.parse_args()

    if args.command == "setup":
        cmd_setup(args)
    elif args.command == "list":
        cmd_list(args)
    elif args.command == "run":
        cmd_run(args)
    elif args.command == "resume":
        cmd_resume(args)
    elif args.command == "collect":
        cmd_collect(args)
    elif args.command == "evaluate":
        cmd_evaluate(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
