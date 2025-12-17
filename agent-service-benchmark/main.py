# -*- coding: utf-8 -*-
"""
DABstep Benchmark Runner for Texera Agent Service

This script runs the DABstep benchmark using the DataflowAgent that interacts
with Texera's Agent Service. The agent builds and executes dataflow workflows
to answer data analysis questions.

Usage:
    python main.py                    # Run with defaults (3 dev tasks)
    python main.py --max-tasks 10     # Run with more tasks
    python main.py --split default    # Run full benchmark

Requirements:
    - Texera backend running on localhost:8080
    - Agent service running on localhost:3001
    - HuggingFace login (for dataset download)
"""

import os
import time
import json
import argparse
from datetime import datetime
from pathlib import Path
from typing import Optional

import datasets
import pandas as pd
from huggingface_hub import hf_hub_download

# Import evaluation function - optional, will gracefully degrade if not installed
try:
    from dabstep_benchmark.utils import evaluate
    EVALUATION_AVAILABLE = True
except ImportError:
    EVALUATION_AVAILABLE = False
    print("[Warning] dabstep_benchmark not installed, evaluation will be skipped")
    print("  Install with: pip install git+https://git@hf.co/spaces/adyen/DABstep.git@main")

from dataflow_agent import (
    DataflowAgent,
    MessageResult,
    delete_all_agents,
    list_all_agents,
    get_agent_workflow,
    AGENT_MODEL_TYPE,
    AGENT_MAX_STEPS,
    TEXERA_AGENT_SERVICE_ENDPOINT,
)


# ============================================================================
# Configuration
# ============================================================================

# DABstep Context Files
CONTEXT_FILENAMES = [
    "data/context/acquirer_countries.csv",
    "data/context/payments-readme.md",
    "data/context/payments.csv",
    "data/context/merchant_category_codes.csv",
    "data/context/fees.json",
    "data/context/merchant_data.json",
    "data/context/manual.md",
]

# Default data directory
DATA_DIR = "/tmp/DABstep-data"

# Output directory for results
RUNS_DIR = Path(__file__).parent / "runs"


# ============================================================================
# Prompt Template
# ============================================================================

# Prompt template for the dataflow agent
# This is different from the smolagents prompt - it instructs the agent to build
# workflows to answer questions rather than writing Python code directly.
PROMPT = """
You have these files available:
{context_files}
You will answer factoid questions by loading and referencing. Don't forget to reference any documentation in the data dir before answering a question.

Here is the question you need to answer:
{question}

Here are the guidelines you must follow when answering the question above:
{guidelines}

You MUST follow the guideline to format your answer and your last message MUST be the EXACT answer format
"""


# ============================================================================
# Utility Functions
# ============================================================================


def download_context_files(data_dir: str = DATA_DIR, force: bool = False) -> list[str]:
    """
    Download DABstep context files from HuggingFace.

    Args:
        data_dir: Directory to save files
        force: Force re-download even if files exist

    Returns:
        List of local file paths
    """
    print(f"[Benchmark] Downloading context files to {data_dir}...")

    local_files = []
    for filename in CONTEXT_FILENAMES:
        local_path = f"{data_dir}/{filename}"

        # Check if file exists and skip if not forcing
        if os.path.exists(local_path) and not force:
            print(f"  [skip] {filename} (already exists)")
            local_files.append(local_path)
            continue

        try:
            hf_hub_download(
                repo_id="adyen/DABstep",
                repo_type="dataset",
                filename=filename,
                local_dir=data_dir,
                force_download=force,
            )
            print(f"  [done] {filename}")
            local_files.append(local_path)
        except Exception as e:
            print(f"  [error] {filename}: {e}")

    # Verify files
    print("\n[Benchmark] Verifying downloaded files:")
    for filepath in local_files:
        exists = "OK" if os.path.exists(filepath) else "MISSING"
        print(f"  [{exists}] {filepath}")

    return local_files


def write_jsonl(data: list[dict], filepath: Path) -> None:
    """Write a list of dictionaries to a JSONL file."""
    filepath.parent.mkdir(parents=True, exist_ok=True)
    with open(filepath, "w") as f:
        for entry in data:
            f.write(json.dumps(entry) + "\n")
    print(f"[Benchmark] Results written to {filepath}")


def load_benchmark_dataset(
    split: str = "dev", max_tasks: Optional[int] = None
) -> datasets.Dataset:
    """
    Load DABstep benchmark dataset.

    Args:
        split: Dataset split ("dev" or "default")
        max_tasks: Maximum number of tasks to load (None for all)

    Returns:
        HuggingFace Dataset
    """
    if max_tasks:
        split_str = f"{split}[:{max_tasks}]"
    else:
        split_str = split

    print(f"[Benchmark] Loading dataset: adyen/DABstep, split={split_str}")
    dataset = datasets.load_dataset("adyen/DABstep", name="tasks", split=split_str)
    print(f"[Benchmark] Loaded {len(dataset)} tasks")
    return dataset


# ============================================================================
# Benchmark Runner
# ============================================================================


def run_single_task(
    task: dict,
    context_files: list[str],
    base_run_dir: Path,
    timestamp: str,
    model_type: str = AGENT_MODEL_TYPE,
    max_steps: int = AGENT_MAX_STEPS,
    verbosity_level: int = 1,
    retain: bool = False,
    relational_only: bool = False,
) -> dict:
    """
    Run a single benchmark task with a fresh agent and workflow.
    """
    task_id = task["task_id"]
    question = task["question"]
    guidelines = task["guidelines"]
    correct_answer = task.get("answer", "")

    print(f"\n[Task {task_id}] {question[:80]}...")

    # Create task-specific folder
    task_dir = base_run_dir / f"{timestamp}_task{task_id}"
    task_dir.mkdir(parents=True, exist_ok=True)

    # Format prompt
    context_files_str = "\n".join(f"  - {f}" for f in context_files)
    prompt = PROMPT.format(
        context_files=context_files_str,
        question=question,
        guidelines=guidelines,
    )

    # Create agent
    agent = DataflowAgent(
        model_type=model_type,
        max_steps=max_steps,
        verbosity_level=verbosity_level,
        workflow_name=f"Benchmark Task {task_id}",
        agent_name=f"task-{task_id}",
        only_use_relational_operators=relational_only,
    )

    start_time = time.time()
    message_result: Optional[MessageResult] = None
    workflow_content = None
    answer = ""
    elapsed = 0.0
    error = None

    try:
        agent.setup()
        print(f"[Task {task_id}] Created agent: {agent.agent_id}, workflow: {agent._workflow_id}")

        message_result = agent.run(prompt)
        elapsed = time.time() - start_time
        answer = agent_response_to_answer(message_result.response)
        error = message_result.error
        print(f"[Task {task_id}] Completed in {elapsed:.1f}s")

        # Fetch workflow (API now returns content directly)
        try:
            workflow_content = get_agent_workflow(agent.agent_id)
            print(f"[Task {task_id}] Workflow: {len(workflow_content.get('operators', []))} operators")
        except Exception as e:
            print(f"[Task {task_id}] Failed to fetch workflow: {e}")

    except Exception as e:
        elapsed = time.time() - start_time
        answer = f"ERROR: {e}"
        error = str(e)
        print(f"[Task {task_id}] Failed after {elapsed:.1f}s: {e}")
    finally:
        if not retain:
            agent.cleanup()

    # Save files
    _save_file(task_dir / "prompt.txt", prompt)
    _save_file(task_dir / "question.txt", question)
    _save_file(task_dir / "answer.txt", answer)
    _save_file(task_dir / "correct_answer.txt", str(correct_answer))

    if workflow_content:
        _save_json(task_dir / "workflow.json", workflow_content)

    if message_result:
        _save_json(task_dir / "trace.json", {
            "response": message_result.response,
            "messages": message_result.messages,
            "usage": message_result.usage,
            "stats": message_result.stats,
            "stopped": message_result.stopped,
            "error": message_result.error,
        })

    # Evaluate
    score = _evaluate_task(task_id, answer, correct_answer, question, guidelines, task, task_dir)

    return {
        "task_id": str(task_id),
        "task_dir": str(task_dir),
        "answer": answer,
        "correct_answer": correct_answer,
        "score": score,
        "workflow_id": agent._workflow_id,
        "agent_id": agent.agent_id,
        "elapsed_seconds": elapsed,
        "error": error,
    }


def agent_response_to_answer(response: str) -> str:
    """Extract the answer from agent response (last non-empty line)."""
    lines = response.strip().split("\n")
    # Find last non-empty line
    for line in reversed(lines):
        stripped = line.strip()
        if stripped:
            return stripped
    return response.strip()


def _save_file(path: Path, content: str) -> None:
    """Save text content to a file."""
    with open(path, "w") as f:
        f.write(content)


def _save_json(path: Path, data: dict) -> None:
    """Save JSON data to a file."""
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def _evaluate_task(
    task_id: str,
    agent_answer: str,
    correct_answer: str,
    question: str,
    guidelines: str,
    task: dict,
    task_dir: Path,
) -> Optional[float]:
    """Evaluate a task and save score."""
    if not EVALUATION_AVAILABLE:
        return None

    try:
        agent_answers_df = pd.DataFrame([{
            "task_id": str(task_id),
            "agent_answer": str(agent_answer),
        }])
        task_df = pd.DataFrame([{
            "task_id": task_id,
            "question": question,
            "guidelines": guidelines,
            "answer": correct_answer,
            "level": task.get("level", "unknown"),
        }])
        task_scores = evaluate(agent_answers=agent_answers_df, tasks_with_gt=task_df)
        score = task_scores[0].get("score", 0) if task_scores else 0

        _save_file(task_dir / "score.txt", str(score))
        _save_json(task_dir / "evaluation.json", {
            "task_id": str(task_id),
            "score": score,
            "agent_answer": str(agent_answer),
            "correct_answer": str(correct_answer),
        })
        print(f"[Task {task_id}] Score: {score}")
        return score
    except Exception as e:
        print(f"[Task {task_id}] Evaluation failed: {e}")
        return None


def run_benchmark(
    dataset: datasets.Dataset,
    context_files: list[str],
    base_run_dir: Path,
    timestamp: str,
    model_type: str = AGENT_MODEL_TYPE,
    max_steps: int = AGENT_MAX_STEPS,
    verbosity_level: int = 1,
    retain: bool = False,
    relational_only: bool = False,
) -> list[dict]:
    """Run the full benchmark. Each task creates a fresh workflow and agent."""
    results = []
    total = len(dataset)

    print(f"\n[Benchmark] Running {total} tasks (model={model_type}, max_steps={max_steps})")
    if retain:
        print("[Benchmark] RETAIN MODE: Agents and workflows will NOT be deleted")

    for i, task in enumerate(dataset):
        print(f"\n--- Task {i + 1}/{total} ---")
        result = run_single_task(
            task=task,
            context_files=context_files,
            base_run_dir=base_run_dir,
            timestamp=timestamp,
            model_type=model_type,
            max_steps=max_steps,
            verbosity_level=verbosity_level,
            retain=retain,
            relational_only=relational_only,
        )
        results.append(result)

    # Print summary
    scores = [r["score"] for r in results if r.get("score") is not None]
    if scores:
        accuracy = sum(scores) / len(scores)
        print(f"\n[Benchmark] Accuracy: {accuracy:.2%} ({sum(1 for s in scores if s == 1)}/{len(scores)} correct)")

    return results


# ============================================================================
# Main Entry Point
# ============================================================================


def cleanup_existing_agents() -> int:
    """
    Delete all existing agents in the agent service.

    Returns:
        Number of agents deleted
    """
    print("\n[Benchmark] Cleaning up existing agents...")
    try:
        agents = list_all_agents(TEXERA_AGENT_SERVICE_ENDPOINT)
        if not agents:
            print("[Benchmark] No existing agents found")
            return 0

        print(f"[Benchmark] Found {len(agents)} existing agents, deleting...")
        deleted = delete_all_agents(TEXERA_AGENT_SERVICE_ENDPOINT)
        print(f"[Benchmark] Deleted {deleted} agents")
        return deleted
    except Exception as e:
        print(f"[Benchmark] Failed to cleanup agents: {e}")
        return 0


def get_timestamp() -> str:
    """Get a timestamp string in format YYYYMMDD_HHMMSS."""
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def main():
    parser = argparse.ArgumentParser(
        description="Run DABstep benchmark with Texera Agent Service"
    )
    parser.add_argument(
        "--split",
        type=str,
        default="dev",
        help="Dataset split to use (dev or default)",
    )
    parser.add_argument(
        "--max-tasks",
        type=int,
        default=3,
        help="Maximum number of tasks to run (default: 3)",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=AGENT_MODEL_TYPE,
        help=f"Model type to use (default: {AGENT_MODEL_TYPE})",
    )
    parser.add_argument(
        "--max-steps",
        type=int,
        default=AGENT_MAX_STEPS,
        help=f"Maximum agent steps per task (default: {AGENT_MAX_STEPS})",
    )
    parser.add_argument(
        "--data-dir",
        type=str,
        default=DATA_DIR,
        help=f"Directory for context files (default: {DATA_DIR})",
    )
    parser.add_argument(
        "--force-download",
        action="store_true",
        help="Force re-download of context files",
    )
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Skip downloading context files (assume already present)",
    )
    parser.add_argument(
        "--evaluate",
        action="store_true",
        help="Evaluate results after benchmark (requires dabstep_benchmark package)",
    )
    parser.add_argument(
        "--verbosity",
        type=int,
        default=1,
        help="Agent verbosity level (0=quiet, 1=normal, 2=verbose)",
    )
    parser.add_argument(
        "-r",
        "--retain",
        action="store_true",
        help="Retain agents and workflows after each task (do not delete)",
    )
    parser.add_argument(
        "--no-cleanup",
        action="store_true",
        help="Skip initial cleanup of existing agents",
    )
    parser.add_argument(
        "--relational-only",
        action="store_true",
        help="Only allow relational operators (Aggregate, Projection, Join, etc.)",
    )

    args = parser.parse_args()

    print("=" * 60)
    print("DABstep Benchmark - Texera Agent Service")
    print("=" * 60)
    print(f"Split: {args.split}")
    print(f"Max tasks: {args.max_tasks}")
    print(f"Model: {args.model}")
    print(f"Max steps: {args.max_steps}")
    print(f"Data dir: {args.data_dir}")
    print(f"Retain mode: {args.retain}")
    print(f"Relational only: {args.relational_only}")
    print("=" * 60)

    # Step 0: Cleanup existing agents (unless --no-cleanup is specified)
    if not args.no_cleanup:
        cleanup_existing_agents()

    # Step 1: Download context files
    if not args.skip_download:
        context_files = download_context_files(
            data_dir=args.data_dir,
            force=args.force_download,
        )
    else:
        context_files = [f"{args.data_dir}/{f}" for f in CONTEXT_FILENAMES]
        print("[Benchmark] Skipping download, using existing files")

    # Step 2: Load benchmark dataset
    dataset = load_benchmark_dataset(
        split=args.split,
        max_tasks=args.max_tasks,
    )

    # Run benchmark
    timestamp = get_timestamp()
    RUNS_DIR.mkdir(parents=True, exist_ok=True)

    results = run_benchmark(
        dataset=dataset,
        context_files=context_files,
        base_run_dir=RUNS_DIR,
        timestamp=timestamp,
        model_type=args.model,
        max_steps=args.max_steps,
        verbosity_level=args.verbosity,
        retain=args.retain,
        relational_only=args.relational_only,
    )

    # Print summary
    print(f"\n[Benchmark] Complete! {len(results)} tasks, timestamp: {timestamp}")
    for r in results:
        score = r.get("score", "N/A")
        err = f" ERROR: {r['error']}" if r.get("error") else ""
        print(f"  Task {r['task_id']}: score={score}{err}")

    scores = [r["score"] for r in results if r.get("score") is not None]
    if scores:
        accuracy = sum(scores) / len(scores)
        correct_count = sum(1 for s in scores if s == 1)
        print(f"\n[Benchmark] Final Accuracy: {accuracy:.2%} ({correct_count}/{len(scores)} correct)")


if __name__ == "__main__":
    main()
