# -*- coding: utf-8 -*-
"""
DABstep Benchmark Runner for Texera Agent Service

Runs the DABstep benchmark (https://huggingface.co/spaces/adyen/DABstep) using
DataflowAgent or baseline CodeAgent (smolagents).

Usage:
    # Start a new run (dev split - 10 tasks)
    python -m benchmarks.dabstep run

    # Start a new run (default split - 450 tasks)
    python -m benchmarks.dabstep run --split default

    # Resume an interrupted run (runs tasks without result.json)
    python -m benchmarks.dabstep resume runs/dabstep/20260103_120000_default

    # Retry errored tasks (detects and re-runs tasks with errors)
    python -m benchmarks.dabstep retry runs/dabstep/20260103_120000_default

    # Collect results from a run into submission.jsonl
    python -m benchmarks.dabstep collect runs/dabstep/20260103_120000_default

    # Analyze workflow DAG structure and metrics
    python -m benchmarks.dabstep analyze runs/dabstep/20260103_120000_default
"""

import os
import sys
import time
import json
import argparse
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any, Set
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

import datasets
import pandas as pd
from huggingface_hub import hf_hub_download

# Evaluation - optional
try:
    from dabstep_benchmark.utils import evaluate
    EVALUATION_AVAILABLE = True
except ImportError:
    EVALUATION_AVAILABLE = False

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
from analyzer.dabstep_analyzer import (
    DABstepAnalyzer, analyze_run, print_analysis,
)

# =============================================================================
# Constants
# =============================================================================

CONTEXT_FILENAMES = [
    "data/context/acquirer_countries.csv",
    "data/context/payments-readme.md",
    "data/context/payments.csv",
    "data/context/merchant_category_codes.csv",
    "data/context/fees.json",
    "data/context/merchant_data.json",
    "data/context/manual.md",
]

DATA_DIR = "/tmp/DABstep-data"
RUNS_DIR = Path(__file__).parent.parent / "runs" / "dabstep"

PROMPT = """You are an expert data analyst. Answer factoid questions by analyzing the files below.

Available files:
{context_files}

Question: {question}

Guidelines: {guidelines}

Instructions:
1. Read relevant documentation files first
2. Analyze the data to find the answer
3. Follow the guidelines exactly for your answer format
4. Your final message must be ONLY the answer in the required format
"""

BASELINE_PROMPT = """You are an expert data analyst. Answer factoid questions by loading and analyzing files.

Available files:
{context_files}

Question: {question}

Guidelines: {guidelines}

Reference documentation before answering. Your final output must be ONLY the answer.
"""

# =============================================================================
# Data Loading
# =============================================================================

def download_context_files(data_dir: str = DATA_DIR, force: bool = False) -> List[str]:
    """Download DABstep context files from HuggingFace."""
    print(f"[DABstep] Downloading context files to {data_dir}...")
    local_files = []
    for filename in CONTEXT_FILENAMES:
        local_path = f"{data_dir}/{filename}"
        if os.path.exists(local_path) and not force:
            print(f"  [skip] {filename}")
            local_files.append(local_path)
            continue
        try:
            hf_hub_download(
                repo_id="adyen/DABstep", repo_type="dataset",
                filename=filename, local_dir=data_dir, force_download=force,
            )
            print(f"  [done] {filename}")
            local_files.append(local_path)
        except Exception as e:
            print(f"  [error] {filename}: {e}")
    return local_files


def load_dataset(split: str = "dev", max_tasks: Optional[int] = None) -> datasets.Dataset:
    """Load DABstep benchmark dataset."""
    split_str = f"{split}[:{max_tasks}]" if max_tasks else split
    print(f"[DABstep] Loading dataset: split={split_str}")
    dataset = datasets.load_dataset("adyen/DABstep", name="tasks", split=split_str)
    print(f"[DABstep] Loaded {len(dataset)} tasks")
    return dataset


# =============================================================================
# Run Directory Management
# =============================================================================

def create_run_dir(split: str, baseline: bool = False) -> Path:
    """Create a new run directory."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    mode = "baseline" if baseline else "dataflow"
    run_name = f"{timestamp}_{split}_{mode}"
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
        task_dir = run_dir / f"task_{task_id}"
        if task_dir.exists():
            shutil.rmtree(task_dir)


def save_task_result(run_dir: Path, task_id: str, result: Dict):
    """Save a single task result to its directory."""
    task_dir = run_dir / f"task_{task_id}"
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


def write_submission_jsonl(results: List[Dict], output_file: Path):
    """Write results in submission JSONL format."""
    with open(output_file, 'w') as f:
        for r in results:
            f.write(json.dumps({
                "task_id": str(r["task_id"]),
                "agent_answer": str(r["answer"]),
            }) + "\n")


def evaluate_results(results: List[Dict], dataset: datasets.Dataset) -> List[Dict]:
    """Evaluate results against ground truth."""
    if not EVALUATION_AVAILABLE:
        print("[DABstep] Evaluation unavailable (dabstep_benchmark not installed)")
        return results
    try:
        agent_df = pd.DataFrame([{
            "task_id": str(r["task_id"]),
            "agent_answer": str(r["answer"]),
        } for r in results])
        tasks_df = dataset.to_pandas()
        task_scores = evaluate(agent_answers=agent_df, tasks_with_gt=tasks_df)
        score_map = {str(s["task_id"]): s["score"] for s in task_scores}
        for r in results:
            r["score"] = score_map.get(str(r["task_id"]), 0)
        return results
    except Exception as e:
        print(f"[DABstep] Evaluation failed: {e}")
        return results


# =============================================================================
# Task Runners
# =============================================================================

def run_dataflow_task(
    task: Dict,
    context_files: List[str],
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
    task_id = str(task["task_id"])
    task_dir = run_dir / f"task_{task_id}"
    task_dir.mkdir(parents=True, exist_ok=True)

    context_str = "\n".join(f"  - {f}" for f in context_files)
    prompt = PROMPT.format(
        context_files=context_str,
        question=task["question"],
        guidelines=task["guidelines"],
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
        workflow_name=f"DABstep-{task_id}",
        agent_name=f"dabstep-{task_id}",
        only_use_relational_operators=relational_only,
    )

    start = time.time()
    result = {"task_id": task_id, "answer": "", "error": None, "elapsed": 0}

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
    save_task_result(run_dir, task_id, result)
    return result


def run_baseline_task(
    task: Dict,
    context_files: List[str],
    run_dir: Path,
    model_type: str = CODE_AGENT_MODEL_TYPE,
    max_steps: int = CODE_AGENT_MAX_STEPS,
    verbosity: int = 1,
) -> Dict:
    """Run a single task with baseline CodeAgent."""
    task_id = str(task["task_id"])
    task_dir = run_dir / f"task_{task_id}"
    task_dir.mkdir(parents=True, exist_ok=True)

    context_str = "\n".join(f"  - {f}" for f in context_files)
    prompt = BASELINE_PROMPT.format(
        context_files=context_str,
        question=task["question"],
        guidelines=task["guidelines"],
    )

    agent = CodeAgentWrapper(
        model_type=model_type,
        max_steps=max_steps,
        verbosity_level=verbosity,
        agent_name=f"baseline-{task_id}",
    )

    start = time.time()
    result = {"task_id": task_id, "answer": "", "error": None, "elapsed": 0}

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
    except Exception as e:
        result["answer"] = f"ERROR: {e}"
        result["error"] = str(e)
    finally:
        result["elapsed"] = time.time() - start
        agent.cleanup()

    save_task_result(run_dir, task_id, result)
    return result


def _save_task_files(task_dir: Path, task: Dict, prompt: str, result: Dict,
                     msg_result: MessageResult, agent: DataflowAgent):
    """Save task-level files for debugging."""
    with open(task_dir / "prompt.txt", 'w') as f:
        f.write(prompt)
    with open(task_dir / "answer.txt", 'w') as f:
        f.write(result["answer"])
    with open(task_dir / "expected.txt", 'w') as f:
        f.write(str(task.get("answer", "")))

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
    dataset: datasets.Dataset,
    context_files: List[str],
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
    tasks_to_run = [t for t in dataset if str(t["task_id"]) not in skip_task_ids]

    # Reverse order if requested
    if reverse:
        tasks_to_run = list(reversed(tasks_to_run))
    total = len(dataset)
    skipped = len(skip_task_ids)

    order_str = " (reverse order)" if reverse else ""
    print(f"\n[DABstep] Running {len(tasks_to_run)} tasks ({mode}){order_str}")
    if skipped:
        print(f"[DABstep] Skipping {skipped} already completed tasks")

    results = []
    for i, task in enumerate(tasks_to_run):
        task_num = skipped + i + 1
        _log(f"\n[{task_num}/{total}] Task {task['task_id']}: {task['question'][:60]}...")
        result = runner(task, context_files, run_dir, **agent_kwargs)
        results.append(result)
        _log(f"  Answer: {result['answer'][:80]}{'...' if len(result['answer']) > 80 else ''} ({result['elapsed']:.1f}s)")

    return results


def cleanup_agents():
    """Delete all existing agents."""
    try:
        agents = list_all_agents(TEXERA_AGENT_SERVICE_ENDPOINT)
        if agents:
            print(f"[DABstep] Cleaning up {len(agents)} agents...")
            delete_all_agents(TEXERA_AGENT_SERVICE_ENDPOINT)
    except Exception as e:
        print(f"[DABstep] Cleanup failed: {e}")


# =============================================================================
# CLI Commands
# =============================================================================

def cmd_run(args):
    """Run a new benchmark."""
    print("=" * 60)
    print(f"DABstep Benchmark - {'Baseline (smolagents)' if args.baseline else 'Texera Agent'}")
    print(f"Split: {args.split} | Max tasks: {args.max_tasks or 'all'} | Model: {args.model}")
    print("=" * 60)

    # Cleanup
    if not args.no_cleanup and not args.baseline:
        cleanup_agents()

    # Download context files
    context_files = (
        [f"{args.data_dir}/{f}" for f in CONTEXT_FILENAMES] if args.skip_download
        else download_context_files(args.data_dir)
    )

    # Load dataset
    dataset = load_dataset(args.split, args.max_tasks)

    # Create run directory
    run_dir = create_run_dir(args.split, args.baseline)
    print(f"[DABstep] Run directory: {run_dir}")

    # Save config
    config = {
        "split": args.split,
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
            "relational_only": True,
        })

    # Run benchmark
    results = run_benchmark(
        dataset, context_files, run_dir,
        baseline=args.baseline,
        reverse=args.reverse,
        **agent_kwargs,
    )

    # Summary
    _print_summary(run_dir, results)


def cmd_resume(args):
    """Resume an interrupted benchmark run."""
    run_dir = Path(args.run_dir)
    if not run_dir.exists():
        print(f"[DABstep] Error: Run directory not found: {run_dir}")
        sys.exit(1)

    # Load config
    config = load_run_config(run_dir)
    print("=" * 60)
    print(f"DABstep Benchmark - Resuming")
    print(f"Run directory: {run_dir}")
    print(f"Split: {config['split']} | Model: {config['model']}")
    print("=" * 60)

    # Handle --rerun-tasks: delete specified tasks so they will be re-run
    rerun_ids = None
    if args.rerun_tasks:
        rerun_ids = set(args.rerun_tasks.split(","))
        print(f"[DABstep] Deleting {len(rerun_ids)} tasks to re-run: {sorted(rerun_ids, key=lambda x: int(x))}")
        delete_task_results(run_dir, rerun_ids)

    # Get completed tasks
    completed = get_completed_task_ids(run_dir)
    print(f"[DABstep] Found {len(completed)} completed tasks")

    # Cleanup
    if not args.no_cleanup and not config.get("baseline"):
        cleanup_agents()

    # Download context files
    data_dir = config.get("data_dir", DATA_DIR)
    context_files = download_context_files(data_dir)

    # Load full dataset
    dataset = load_dataset(config["split"], config.get("max_tasks"))

    # Handle --only: skip all tasks except those specified in --rerun-tasks
    if args.only:
        if not rerun_ids:
            print("[DABstep] Error: --only requires --rerun-tasks to specify which tasks to run")
            sys.exit(1)
        # Skip all tasks except the specified ones
        all_task_ids = set(str(t["task_id"]) for t in dataset)
        completed = all_task_ids - rerun_ids
        print(f"[DABstep] --only mode: will run only {len(rerun_ids)} specified tasks")

    # Check if already complete
    if len(completed) >= len(dataset):
        print(f"[DABstep] All {len(dataset)} tasks already completed!")
        _print_summary(run_dir)
        return

    # Build agent kwargs from config
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

    # Run benchmark, skipping completed
    results = run_benchmark(
        dataset, context_files, run_dir,
        baseline=baseline,
        skip_task_ids=completed,
        reverse=args.reverse,
        **agent_kwargs,
    )

    # Summary
    _print_summary(run_dir)


def cmd_retry(args):
    """Retry errored tasks from a benchmark run."""
    run_dir = Path(args.run_dir)
    if not run_dir.exists():
        print(f"[DABstep] Error: Run directory not found: {run_dir}")
        sys.exit(1)

    # Load config
    config = load_run_config(run_dir)

    # Get errored tasks
    errored = get_errored_task_ids(run_dir)
    if not errored:
        print(f"[DABstep] No errored tasks found in {run_dir}")
        return

    print("=" * 60)
    print(f"DABstep Benchmark - Retry Errored Tasks")
    print(f"Run directory: {run_dir}")
    print(f"Split: {config['split']} | Model: {config['model']}")
    print(f"Errored tasks to retry: {len(errored)}")
    print(f"Task IDs: {sorted(errored, key=lambda x: int(x))}")
    print("=" * 60)

    # Delete errored task directories so they can be re-run
    print(f"[DABstep] Deleting {len(errored)} errored task directories...")
    delete_task_results(run_dir, errored)

    # Get remaining completed tasks (to skip)
    completed = get_completed_task_ids(run_dir)
    print(f"[DABstep] Skipping {len(completed)} successfully completed tasks")

    # Cleanup
    if not args.no_cleanup and not config.get("baseline"):
        cleanup_agents()

    # Download context files
    data_dir = config.get("data_dir", DATA_DIR)
    context_files = download_context_files(data_dir)

    # Load full dataset
    dataset = load_dataset(config["split"], config.get("max_tasks"))

    # Build agent kwargs from config
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

    # Run benchmark, skipping completed (successful) tasks
    results = run_benchmark(
        dataset, context_files, run_dir,
        baseline=baseline,
        skip_task_ids=completed,
        reverse=args.reverse,
        **agent_kwargs,
    )

    # Summary
    _print_summary(run_dir)


def cmd_collect(args):
    """Collect results from a run directory into submission.jsonl."""
    run_dir = Path(args.run_dir)
    if not run_dir.exists():
        print(f"[DABstep] Error: Run directory not found: {run_dir}")
        sys.exit(1)

    print("=" * 60)
    print(f"DABstep Benchmark - Collect Results")
    print(f"Run directory: {run_dir}")
    print("=" * 60)

    # Collect results
    results = collect_results(run_dir)
    print(f"[DABstep] Collected {len(results)} task results")

    if not results:
        print("[DABstep] No results found!")
        return

    # Write submission file
    submission_file = run_dir / "submission.jsonl"
    write_submission_jsonl(results, submission_file)
    print(f"[DABstep] Submission file: {submission_file}")

    # Write detailed results
    results_file = run_dir / "results.json"
    with open(results_file, 'w') as f:
        json.dump(results, f, indent=2)
    print(f"[DABstep] Detailed results: {results_file}")

    # Optionally evaluate
    if args.evaluate:
        config = load_run_config(run_dir)
        dataset = load_dataset(config["split"], config.get("max_tasks"))
        results = evaluate_results(results, dataset)
        # Re-save with scores
        with open(results_file, 'w') as f:
            json.dump(results, f, indent=2)

    # Summary
    _print_summary(run_dir, results)


def cmd_analyze(args):
    """Analyze workflow results from a benchmark run."""
    run_dir = Path(args.run_dir)
    if not run_dir.exists():
        print(f"[DABstep] Error: Run directory not found: {run_dir}")
        sys.exit(1)

    print("=" * 60)
    print(f"DABstep Benchmark - Analyze Workflows")
    print(f"Run directory: {run_dir}")
    print("=" * 60)

    # Run analysis
    analysis = analyze_run(str(run_dir), top_n=args.top_n)

    # Print results
    print_analysis(analysis, detailed=args.detailed)

    # Optionally save to file
    if args.output:
        output_file = Path(args.output)
        with open(output_file, 'w') as f:
            json.dump(analysis.to_dict(), f, indent=2)
        print(f"\n[DABstep] Analysis saved to: {output_file}")
    else:
        # Save to run directory by default
        output_file = run_dir / "analysis.json"
        with open(output_file, 'w') as f:
            json.dump(analysis.to_dict(), f, indent=2)
        print(f"\n[DABstep] Analysis saved to: {output_file}")


def _print_summary(run_dir: Path, results: List[Dict] = None):
    """Print run summary."""
    if results is None:
        results = collect_results(run_dir)

    print("\n" + "=" * 60)
    print(f"Run directory: {run_dir}")
    print(f"Completed: {len(results)} tasks")

    scores = [r.get("score") for r in results if r.get("score") is not None]
    if scores:
        accuracy = sum(scores) / len(scores)
        correct = sum(1 for s in scores if s == 1)
        print(f"Accuracy: {accuracy:.1%} ({correct}/{len(scores)} correct)")

    errors = sum(1 for r in results if r.get("error"))
    if errors:
        print(f"Errors: {errors}")

    total_time = sum(r.get("elapsed", 0) for r in results)
    print(f"Total time: {total_time:.1f}s")
    print("=" * 60)


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="DABstep Benchmark Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Start a new run with dev split (10 tasks)
  python -m benchmarks.dabstep run

  # Start a new run with default split (450 tasks), limited to 5 tasks
  python -m benchmarks.dabstep run --split default --max-tasks 5

  # Resume an interrupted run
  python -m benchmarks.dabstep resume runs/dabstep/20260103_120000_default_dataflow

  # Collect results into submission.jsonl
  python -m benchmarks.dabstep collect runs/dabstep/20260103_120000_default_dataflow
        """
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # === run command ===
    run_parser = subparsers.add_parser("run", help="Start a new benchmark run")
    run_parser.add_argument("--split", default="dev", help="Dataset split: dev (10) or default (450)")
    run_parser.add_argument("--max-tasks", type=int, help="Limit number of tasks")
    run_parser.add_argument("--data-dir", default=DATA_DIR, help="Context files directory")
    run_parser.add_argument("--skip-download", action="store_true", help="Skip file download")
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
    run_parser.add_argument("--verbosity", type=int, default=1, help="0=quiet, 1=normal, 2=verbose")
    run_parser.add_argument("--reverse", action="store_true", help="Run tasks in reverse order")

    # === resume command ===
    resume_parser = subparsers.add_parser("resume", help="Resume an interrupted run")
    resume_parser.add_argument("run_dir", help="Path to run directory")
    resume_parser.add_argument("--rerun-tasks", help="Comma-separated task IDs to delete and re-run (e.g., '65,1280,1302')")
    resume_parser.add_argument("--only", action="store_true", help="Only run tasks specified by --rerun-tasks (ignore other incomplete tasks)")
    resume_parser.add_argument("--no-cleanup", action="store_true", help="Skip initial cleanup")
    resume_parser.add_argument("--verbosity", type=int, default=1, help="0=quiet, 1=normal, 2=verbose")
    resume_parser.add_argument("--reverse", action="store_true", help="Run tasks in reverse order")

    # === retry command ===
    retry_parser = subparsers.add_parser("retry", help="Retry errored tasks from a run")
    retry_parser.add_argument("run_dir", help="Path to run directory")
    retry_parser.add_argument("--no-cleanup", action="store_true", help="Skip initial cleanup")
    retry_parser.add_argument("--verbosity", type=int, default=1, help="0=quiet, 1=normal, 2=verbose")
    retry_parser.add_argument("--reverse", action="store_true", help="Run tasks in reverse order")

    # === collect command ===
    collect_parser = subparsers.add_parser("collect", help="Collect results into submission.jsonl")
    collect_parser.add_argument("run_dir", help="Path to run directory")
    collect_parser.add_argument("--evaluate", action="store_true", help="Evaluate results against ground truth")

    # === analyze command ===
    analyze_parser = subparsers.add_parser("analyze", help="Analyze workflow DAG structure and metrics")
    analyze_parser.add_argument("run_dir", help="Path to run directory")
    analyze_parser.add_argument("--detailed", action="store_true", help="Show per-task details")
    analyze_parser.add_argument("--top-n", type=int, default=5, help="Number of extreme instances to show")
    analyze_parser.add_argument("--output", "-o", help="Output file for JSON analysis (default: run_dir/analysis.json)")

    args = parser.parse_args()

    if args.command == "run":
        cmd_run(args)
    elif args.command == "resume":
        cmd_resume(args)
    elif args.command == "retry":
        cmd_retry(args)
    elif args.command == "collect":
        cmd_collect(args)
    elif args.command == "analyze":
        cmd_analyze(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
