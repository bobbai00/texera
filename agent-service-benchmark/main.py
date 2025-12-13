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

from dataflow_agent import (
    DataflowAgent,
    clean_reasoning_trace,
    AGENT_MODEL_TYPE,
    AGENT_MAX_STEPS,
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
DATAFLOW_PROMPT = """You are an expert data analyst working with the Texera dataflow platform.
You will answer factoid questions by building and executing dataflow workflows.

## Available Context Files
The following files contain the data you need to analyze:
{context_files}

## File Descriptions
- payments.csv: Transaction payment records with fields like merchant, amount, currency, etc.
- acquirer_countries.csv: Mapping of acquirer codes to country names
- merchant_category_codes.csv: Mapping of MCC codes to category descriptions
- fees.json: Fee structure and pricing rules
- merchant_data.json: Merchant profile information
- manual.md: Documentation about the payment system
- payments-readme.md: Description of the payments.csv schema

## Instructions
1. First, understand what data you need by examining the relevant files
2. Build a workflow using CSVFileScan to load the required CSV files
3. Use PythonUDFV2 operators to process and analyze the data
4. Execute the workflow to get results
5. Provide a clear, concise answer based on the results

## Your Task
Question: {question}

Guidelines: {guidelines}

Please build a workflow to answer this question and provide your final answer.
"""

# Alternative simpler prompt that focuses on direct Python analysis
SIMPLE_PROMPT = """You are an expert data analyst. You will answer factoid questions by analyzing data files.

Available files in {data_dir}:
{context_files}

The key files are:
- payments.csv: Payment transaction records
- fees.json: Fee structure rules
- merchant_data.json: Merchant information
- manual.md & payments-readme.md: Documentation

Question: {question}

Guidelines: {guidelines}

Analyze the data and provide your answer. Be concise and follow the guidelines exactly.
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
    data_dir: str = DATA_DIR,
    model_type: str = AGENT_MODEL_TYPE,
    max_steps: int = AGENT_MAX_STEPS,
    verbosity_level: int = 1,
) -> dict:
    """
    Run a single benchmark task with a fresh agent and workflow.

    Each task creates a new workflow and agent to ensure clean state
    and proper isolation between test cases.

    Args:
        task: Task dictionary with task_id, question, guidelines
        context_files: List of context file paths
        data_dir: Directory containing context files
        model_type: LLM model type to use
        max_steps: Maximum agent steps
        verbosity_level: Logging verbosity

    Returns:
        Dictionary with task_id, agent_answer, reasoning_trace
    """
    task_id = task["task_id"]
    question = task["question"]
    guidelines = task["guidelines"]

    print(f"\n[Task {task_id}] {question[:80]}...")

    # Format the prompt
    context_files_str = "\n".join(f"  - {f}" for f in context_files)
    prompt = SIMPLE_PROMPT.format(
        data_dir=data_dir,
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
    )

    start_time = time.time()
    answer = ""
    logs = []

    try:
        # Setup agent (creates new workflow)
        agent.setup()
        print(f"[Task {task_id}] Created agent: {agent.agent_id}")

        # Run the agent
        answer = agent.run(prompt)
        logs = agent.logs
        elapsed = time.time() - start_time
        print(f"[Task {task_id}] Completed in {elapsed:.1f}s")
        print(f"[Task {task_id}] Answer: {str(answer)[:200]}...")
    except Exception as e:
        elapsed = time.time() - start_time
        answer = f"ERROR: {e}"
        logs = agent.logs if agent else []
        print(f"[Task {task_id}] Failed after {elapsed:.1f}s: {e}")
    finally:
        # Always cleanup the agent and workflow
        agent.cleanup()

    return {
        "task_id": str(task_id),
        "agent_answer": str(answer),
        "reasoning_trace": str(clean_reasoning_trace(logs)),
    }


def run_benchmark(
    dataset: datasets.Dataset,
    context_files: list[str],
    data_dir: str = DATA_DIR,
    model_type: str = AGENT_MODEL_TYPE,
    max_steps: int = AGENT_MAX_STEPS,
    verbosity_level: int = 1,
) -> list[dict]:
    """
    Run the full benchmark.

    Each task creates a fresh workflow and agent for proper isolation.

    Args:
        dataset: HuggingFace Dataset with tasks
        context_files: List of context file paths
        data_dir: Directory containing context files
        model_type: LLM model type to use
        max_steps: Maximum agent steps per task
        verbosity_level: Logging verbosity

    Returns:
        List of task results
    """
    results = []
    total_tasks = len(dataset)

    print(f"\n[Benchmark] Running {total_tasks} tasks...")
    print(f"[Benchmark] Each task will create a new workflow and agent")
    print("=" * 60)

    for i, task in enumerate(dataset):
        print(f"\n--- Task {i + 1}/{total_tasks} ---")
        result = run_single_task(
            task=task,
            context_files=context_files,
            data_dir=data_dir,
            model_type=model_type,
            max_steps=max_steps,
            verbosity_level=verbosity_level,
        )
        results.append(result)

    print("\n" + "=" * 60)
    print(f"[Benchmark] Completed {len(results)} tasks")

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

    args = parser.parse_args()

    print("=" * 60)
    print("DABstep Benchmark - Texera Agent Service")
    print("=" * 60)
    print(f"Split: {args.split}")
    print(f"Max tasks: {args.max_tasks}")
    print(f"Model: {args.model}")
    print(f"Max steps: {args.max_steps}")
    print(f"Data dir: {args.data_dir}")
    print("=" * 60)

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

    # Step 3: Run benchmark (each task creates its own agent and workflow)
    print("\n[Benchmark] Starting benchmark...")
    print(f"[Benchmark] Model: {args.model}, Max steps: {args.max_steps}")

    agent_answers = run_benchmark(
        dataset=dataset,
        context_files=context_files,
        data_dir=args.data_dir,
        model_type=args.model,
        max_steps=args.max_steps,
        verbosity_level=args.verbosity,
    )

    # Step 4: Save results
    run_id = int(time.time())
    results_file = RUNS_DIR / f"{run_id}.jsonl"
    write_jsonl(agent_answers, results_file)

    # Also save as DataFrame for inspection
    results_df = pd.DataFrame(agent_answers)
    csv_file = RUNS_DIR / f"{run_id}.csv"
    results_df.to_csv(csv_file, index=False)
    print(f"[Benchmark] Results also saved to {csv_file}")

    # Step 5: Evaluate (optional)
    if args.evaluate:
        tasks_df = dataset.to_pandas()
        scores = evaluate_results(results_df, tasks_df)
        if scores is not None:
            scores_file = RUNS_DIR / f"{run_id}_scores.csv"
            scores.to_csv(scores_file, index=False)
            print(f"[Benchmark] Scores saved to {scores_file}")

    print("\n[Benchmark] Complete!")
    print(f"Run ID: {run_id}")
    print(f"Results: {results_file}")


if __name__ == "__main__":
    main()
