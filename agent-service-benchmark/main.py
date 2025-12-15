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
PROMPT = """You are an expert data analyst and you will answer factoid questions by loading and referencing the files/documents listed below.
You have these files available:
{context_files}
Don't forget to reference any documentation in the data dir before answering a question.

Here is the question you need to answer:
{question}

Here are the guidelines you must follow when answering the question above:
{guidelines}
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
    data_dir: str = DATA_DIR,
    model_type: str = AGENT_MODEL_TYPE,
    max_steps: int = AGENT_MAX_STEPS,
    verbosity_level: int = 1,
    retain: bool = False,
    relational_only: bool = False,
) -> dict:
    """
    Run a single benchmark task with a fresh agent and workflow.

    Each task creates a new workflow and agent to ensure clean state
    and proper isolation between test cases.

    Args:
        task: Task dictionary with task_id, question, guidelines
        context_files: List of context file paths
        base_run_dir: Base directory for runs
        timestamp: Timestamp string for folder naming
        data_dir: Directory containing context files
        model_type: LLM model type to use
        max_steps: Maximum agent steps
        verbosity_level: Logging verbosity
        retain: If True, do not delete the agent and workflow after task
        relational_only: If True, only allow relational operators

    Returns:
        Dictionary with task results
    """
    task_id = task["task_id"]
    question = task["question"]
    guidelines = task["guidelines"]

    print(f"\n[Task {task_id}] {question[:80]}...")

    # Create task-specific folder: {timestamp}_task{task_id}
    task_dir = base_run_dir / f"{timestamp}_task{task_id}"
    task_dir.mkdir(parents=True, exist_ok=True)

    # Format the prompt using PROMPT template
    context_files_str = "\n".join(f"  - {f}" for f in context_files)
    prompt = PROMPT.format(
        context_files=context_files_str,
        question=question,
        guidelines=guidelines,
    )

    # Create a new agent with fresh workflow for this task
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
    workflow_id = None
    agent_id = None
    workflow_content = None
    elapsed = 0.0

    try:
        # Setup agent (creates new workflow)
        agent.setup()
        workflow_id = agent._workflow_id
        agent_id = agent.agent_id
        print(f"[Task {task_id}] Created agent: {agent_id}, workflow: {workflow_id}")

        # Run the agent - returns MessageResult
        message_result = agent.run(prompt)
        elapsed = time.time() - start_time

        # The answer is the response text from MessageResult
        answer = message_result.response
        print(f"[Task {task_id}] Completed in {elapsed:.1f}s")
        print(f"[Task {task_id}] Answer: {answer[:200]}...")

        # Fetch the workflow after running
        try:
            workflow_content = get_agent_workflow(agent_id)
            workflow_data = workflow_content.get("workflow", workflow_content)
            num_operators = len(workflow_data.get("operators", []))
            num_links = len(workflow_data.get("links", []))
            print(f"[Task {task_id}] Fetched workflow with {num_operators} operators, {num_links} links")
        except Exception as e:
            print(f"[Task {task_id}] Failed to fetch workflow: {e}")
            workflow_content = None

    except Exception as e:
        elapsed = time.time() - start_time
        answer = f"ERROR: {e}"
        print(f"[Task {task_id}] Failed after {elapsed:.1f}s: {e}")
    finally:
        # Only cleanup if retain is False
        if not retain:
            agent.cleanup()
        else:
            print(f"[Task {task_id}] Retaining agent: {agent_id}, workflow: {workflow_id}")

    # Save files to task directory

    # 1. workflow.json - the workflow structure
    if workflow_content:
        workflow_file = task_dir / "workflow.json"
        with open(workflow_file, "w") as f:
            json.dump(workflow_content, f, indent=2)
        print(f"[Task {task_id}] Saved workflow.json")

    # 2. answer.txt - the final answer text
    answer_file = task_dir / "answer.txt"
    with open(answer_file, "w") as f:
        f.write(message_result.response if message_result else answer)
    print(f"[Task {task_id}] Saved answer.txt")

    # 3. parameter.csv - usage and stats from MessageResult
    if message_result:
        param_data = {
            "response_length": len(message_result.response),
            "stopped": message_result.stopped,
            "error": message_result.error or "",
            "elapsed_seconds": elapsed,
            "workflow_id": workflow_id,
            "agent_id": agent_id,
        }
        # Add usage fields
        for key, value in message_result.usage.items():
            param_data[f"usage_{key}"] = value
        # Add stats fields
        for key, value in message_result.stats.items():
            param_data[f"stats_{key}"] = value

        param_df = pd.DataFrame([param_data])
        param_file = task_dir / "parameter.csv"
        param_df.to_csv(param_file, index=False)
        print(f"[Task {task_id}] Saved parameter.csv")

    # 4. trace.json - the full messages array as trace
    if message_result:
        trace_data = {
            "response": message_result.response,
            "messages": message_result.messages,  # Full conversation messages
            "usage": message_result.usage,
            "stats": message_result.stats,
            "stopped": message_result.stopped,
            "error": message_result.error,
        }
        trace_file = task_dir / "trace.json"
        with open(trace_file, "w") as f:
            json.dump(trace_data, f, indent=2)
        print(f"[Task {task_id}] Saved trace.json")

    # 5. question.txt - the question text
    question_file = task_dir / "question.txt"
    with open(question_file, "w") as f:
        f.write(question)
    print(f"[Task {task_id}] Saved question.txt")

    # 6. correct_answer.txt - the ground truth answer
    correct_answer = task.get("answer", "")
    correct_answer_file = task_dir / "correct_answer.txt"
    with open(correct_answer_file, "w") as f:
        f.write(str(correct_answer))
    print(f"[Task {task_id}] Saved correct_answer.txt")

    # 7. Evaluate and save score.txt
    score = None
    if EVALUATION_AVAILABLE:
        try:
            agent_answer = message_result.response if message_result else answer
            # Create single-row DataFrames for evaluation
            agent_answers_df = pd.DataFrame([{
                "task_id": str(task_id),
                "agent_answer": str(agent_answer),
            }])
            # Include all required columns for evaluation (especially 'level')
            task_df = pd.DataFrame([{
                "task_id": task_id,
                "question": question,
                "guidelines": guidelines,
                "answer": correct_answer,
                "level": task.get("level", "unknown"),
            }])
            # Run evaluation
            task_scores = evaluate(agent_answers=agent_answers_df, tasks_with_gt=task_df)
            if task_scores and len(task_scores) > 0:
                score = task_scores[0].get("score", 0)
            else:
                score = 0

            # Save score.txt
            score_file = task_dir / "score.txt"
            with open(score_file, "w") as f:
                f.write(str(score))
            print(f"[Task {task_id}] Saved score.txt (score={score})")

            # Also save evaluation result as JSON for more details
            eval_file = task_dir / "evaluation.json"
            with open(eval_file, "w") as f:
                json.dump({
                    "task_id": str(task_id),
                    "score": score,
                    "agent_answer": str(agent_answer),
                    "correct_answer": str(correct_answer),
                    "question": question,
                }, f, indent=2)
            print(f"[Task {task_id}] Saved evaluation.json")

        except Exception as e:
            print(f"[Task {task_id}] Evaluation failed: {e}")
            score = None
    else:
        print(f"[Task {task_id}] Skipping evaluation (dabstep_benchmark not installed)")

    print(f"[Task {task_id}] All files saved to {task_dir}")

    return {
        "task_id": str(task_id),
        "task_dir": str(task_dir),
        "answer": message_result.response if message_result else answer,
        "correct_answer": correct_answer,
        "score": score,
        "workflow_id": workflow_id,
        "agent_id": agent_id,
        "elapsed_seconds": elapsed,
        "error": message_result.error if message_result else None,
    }


def run_benchmark(
    dataset: datasets.Dataset,
    context_files: list[str],
    base_run_dir: Path,
    timestamp: str,
    data_dir: str = DATA_DIR,
    model_type: str = AGENT_MODEL_TYPE,
    max_steps: int = AGENT_MAX_STEPS,
    verbosity_level: int = 1,
    retain: bool = False,
    relational_only: bool = False,
) -> list[dict]:
    """
    Run the full benchmark.

    Each task creates a fresh workflow and agent for proper isolation.
    Each task is saved to its own folder: {timestamp}_task{task_id}

    Args:
        dataset: HuggingFace Dataset with tasks
        context_files: List of context file paths
        base_run_dir: Base directory for runs
        timestamp: Timestamp string for folder naming
        data_dir: Directory containing context files
        model_type: LLM model type to use
        max_steps: Maximum agent steps per task
        verbosity_level: Logging verbosity
        retain: If True, do not delete agents and workflows after tasks
        relational_only: If True, only allow relational operators

    Returns:
        List of task results
    """
    results = []
    total_tasks = len(dataset)

    print(f"\n[Benchmark] Running {total_tasks} tasks...")
    print(f"[Benchmark] Each task will create a new workflow and agent")
    print(f"[Benchmark] Output format: {timestamp}_task{{task_id}}/")
    if retain:
        print(f"[Benchmark] RETAIN MODE: Agents and workflows will NOT be deleted")
    print("=" * 60)

    for i, task in enumerate(dataset):
        print(f"\n--- Task {i + 1}/{total_tasks} ---")
        result = run_single_task(
            task=task,
            context_files=context_files,
            base_run_dir=base_run_dir,
            timestamp=timestamp,
            data_dir=data_dir,
            model_type=model_type,
            max_steps=max_steps,
            verbosity_level=verbosity_level,
            retain=retain,
            relational_only=relational_only,
        )
        results.append(result)

    print("\n" + "=" * 60)
    print(f"[Benchmark] Completed {len(results)} tasks")

    # Print accuracy summary if evaluation was run
    scores = [r.get("score") for r in results if r.get("score") is not None]
    if scores:
        accuracy = sum(scores) / len(scores)
        correct_count = sum(1 for s in scores if s == 1)
        print(f"[Benchmark] Accuracy: {accuracy:.2%} ({correct_count}/{len(scores)} correct)")
    else:
        print("[Benchmark] No scores available (evaluation skipped or failed)")

    return results


# ============================================================================
# Evaluation (Optional - requires dabstep_benchmark package)
# ============================================================================


def evaluate_results(
    agent_answers: pd.DataFrame, tasks_df: pd.DataFrame
) -> Optional[pd.DataFrame]:
    """
    Evaluate benchmark results if dabstep_benchmark package is available.

    Args:
        agent_answers: DataFrame with task_id and agent_answer columns
        tasks_df: DataFrame with ground truth answers

    Returns:
        DataFrame with scores, or None if evaluation package not available
    """
    try:
        from dabstep_benchmark.utils import evaluate

        print("\n[Benchmark] Evaluating results...")
        task_scores = evaluate(agent_answers=agent_answers, tasks_with_gt=tasks_df)
        scores_df = pd.DataFrame(task_scores)
        scores_df["correct_answer"] = tasks_df["answer"].values
        scores_df["question"] = tasks_df["question"].values

        # Print summary
        accuracy = scores_df["score"].mean() if "score" in scores_df.columns else 0
        print(f"[Benchmark] Accuracy: {accuracy:.2%}")

        return scores_df

    except ImportError:
        print(
            "\n[Benchmark] dabstep_benchmark package not installed, skipping evaluation"
        )
        print(
            "  Install with: pip install git+https://git@hf.co/spaces/adyen/DABstep.git@main"
        )
        return None


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
    """
    Get a timestamp string for folder naming.

    Returns:
        Timestamp string in format YYYYMMDD_HHMMSS
    """
    from datetime import datetime
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

    # Step 3: Get timestamp for folder naming
    timestamp = get_timestamp()
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    print(f"\n[Benchmark] Output directory: {RUNS_DIR}")
    print(f"[Benchmark] Timestamp: {timestamp}")

    # Step 4: Run benchmark (each task creates its own agent and workflow)
    print("\n[Benchmark] Starting benchmark...")
    print(f"[Benchmark] Model: {args.model}, Max steps: {args.max_steps}")

    results = run_benchmark(
        dataset=dataset,
        context_files=context_files,
        base_run_dir=RUNS_DIR,
        timestamp=timestamp,
        data_dir=args.data_dir,
        model_type=args.model,
        max_steps=args.max_steps,
        verbosity_level=args.verbosity,
        retain=args.retain,
        relational_only=args.relational_only,
    )

    # Step 5: Print summary
    print("\n[Benchmark] Complete!")
    print(f"Timestamp: {timestamp}")
    print(f"Total tasks: {len(results)}")

    # Print detailed results with scores
    print(f"\nTask results:")
    for r in results:
        score_str = f"score={r.get('score', 'N/A')}" if r.get('score') is not None else "score=N/A"
        error_str = f" (ERROR: {r.get('error')})" if r.get('error') else ""
        print(f"  - Task {r['task_id']}: {score_str}{error_str}")
        print(f"      {r['task_dir']}")

    # Print final accuracy
    scores = [r.get("score") for r in results if r.get("score") is not None]
    if scores:
        accuracy = sum(scores) / len(scores)
        correct_count = sum(1 for s in scores if s == 1)
        print(f"\n[Benchmark] Final Accuracy: {accuracy:.2%} ({correct_count}/{len(scores)} correct)")


if __name__ == "__main__":
    main()
