#!/usr/bin/env python3
"""
Evaluate DABstep benchmark results.

Usage:
    uv run python scripts/evaluate_results.py runs/dabstep/dataflow/20240101_120000_submission.jsonl
    uv run python scripts/evaluate_results.py runs/dabstep/dataflow/*.jsonl --split dev
"""

import argparse
import json
import glob
from pathlib import Path

import datasets
import pandas as pd

try:
    from dabstep_benchmark.utils import evaluate
    EVALUATION_AVAILABLE = True
except ImportError:
    EVALUATION_AVAILABLE = False
    print("Warning: dabstep_benchmark not installed")
    print("Install with: pip install git+https://git@hf.co/spaces/adyen/DABstep.git@main")


def load_results(filepath: str) -> list:
    """Load results from JSONL file."""
    results = []
    with open(filepath) as f:
        for line in f:
            if line.strip():
                results.append(json.loads(line))
    return results


def evaluate_file(filepath: str, split: str = "dev", verbose: bool = False):
    """Evaluate a results file."""
    print(f"\nEvaluating: {filepath}")
    print("-" * 60)

    # Load results
    results = load_results(filepath)
    print(f"Loaded {len(results)} results")

    if not EVALUATION_AVAILABLE:
        print("Cannot evaluate - dabstep_benchmark not installed")
        return

    # Load ground truth
    dataset = datasets.load_dataset("adyen/DABstep", name="tasks", split=split)
    tasks_df = dataset.to_pandas()

    # Create agent answers DataFrame
    agent_df = pd.DataFrame(results)
    if 'agent_answer' not in agent_df.columns and 'answer' in agent_df.columns:
        agent_df['agent_answer'] = agent_df['answer']

    # Ensure task_id is string
    agent_df['task_id'] = agent_df['task_id'].astype(str)
    tasks_df['task_id'] = tasks_df['task_id'].astype(str)

    # Filter to matching tasks
    matching_ids = set(agent_df['task_id']) & set(tasks_df['task_id'])
    print(f"Matching tasks: {len(matching_ids)}")

    if not matching_ids:
        print("No matching tasks found!")
        return

    agent_df = agent_df[agent_df['task_id'].isin(matching_ids)]
    tasks_df = tasks_df[tasks_df['task_id'].isin(matching_ids)]

    # Evaluate
    try:
        task_scores = evaluate(agent_answers=agent_df, tasks_with_gt=tasks_df)
        scores_df = pd.DataFrame(task_scores)

        # Summary
        total = len(scores_df)
        correct = (scores_df['score'] == 1).sum()
        accuracy = correct / total if total > 0 else 0

        print(f"\nResults:")
        print(f"  Total: {total}")
        print(f"  Correct: {correct}")
        print(f"  Accuracy: {accuracy:.1%}")

        # By level
        merged = scores_df.merge(tasks_df[['task_id', 'level']], on='task_id')
        print(f"\nBy level:")
        for level in merged['level'].unique():
            level_df = merged[merged['level'] == level]
            level_correct = (level_df['score'] == 1).sum()
            level_total = len(level_df)
            level_acc = level_correct / level_total if level_total > 0 else 0
            print(f"  {level}: {level_acc:.1%} ({level_correct}/{level_total})")

        # Verbose - show wrong answers
        if verbose:
            wrong = scores_df[scores_df['score'] != 1]
            if len(wrong) > 0:
                print(f"\nWrong answers ({len(wrong)}):")
                for _, row in wrong.iterrows():
                    task_id = row['task_id']
                    task = tasks_df[tasks_df['task_id'] == task_id].iloc[0]
                    agent = agent_df[agent_df['task_id'] == task_id].iloc[0]
                    print(f"\n  [{task_id}] {task['question'][:60]}...")
                    print(f"    Expected: {task['answer']}")
                    print(f"    Got: {agent['agent_answer'][:100]}")

    except Exception as e:
        print(f"Evaluation failed: {e}")


def main():
    parser = argparse.ArgumentParser(description="Evaluate DABstep results")
    parser.add_argument("files", nargs="+", help="Result files (JSONL)")
    parser.add_argument("--split", default="dev", help="Dataset split for ground truth")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show wrong answers")

    args = parser.parse_args()

    # Expand globs
    files = []
    for pattern in args.files:
        files.extend(glob.glob(pattern))

    if not files:
        print("No files found")
        return

    for filepath in sorted(files):
        if filepath.endswith('.jsonl'):
            evaluate_file(filepath, args.split, args.verbose)


if __name__ == "__main__":
    main()
