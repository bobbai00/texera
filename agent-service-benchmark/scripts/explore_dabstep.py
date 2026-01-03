#!/usr/bin/env python3
"""
Explore DABstep dataset and context files.

Usage:
    uv run python scripts/explore_dabstep.py              # Show dataset overview
    uv run python scripts/explore_dabstep.py --tasks      # Show all tasks
    uv run python scripts/explore_dabstep.py --files      # Show context files
    uv run python scripts/explore_dabstep.py --task 5     # Show specific task
"""

import argparse
import os
import json
import datasets
import pandas as pd
from pathlib import Path

DATA_DIR = "/tmp/DABstep-data"
CONTEXT_FILES = [
    "data/context/acquirer_countries.csv",
    "data/context/payments-readme.md",
    "data/context/payments.csv",
    "data/context/merchant_category_codes.csv",
    "data/context/fees.json",
    "data/context/merchant_data.json",
    "data/context/manual.md",
]


def show_overview():
    """Show dataset overview."""
    print("=" * 60)
    print("DABstep Dataset Overview")
    print("=" * 60)

    # Dev split
    dev = datasets.load_dataset("adyen/DABstep", name="tasks", split="dev")
    print(f"\nDev split: {len(dev)} tasks")
    print(f"Columns: {dev.column_names}")

    # Default split
    default = datasets.load_dataset("adyen/DABstep", name="tasks", split="default")
    print(f"\nDefault split: {len(default)} tasks")

    # Level distribution
    df = default.to_pandas()
    print(f"\nTask levels:")
    for level, count in df['level'].value_counts().items():
        print(f"  {level}: {count}")

    # Sample questions
    print(f"\nSample questions (first 3):")
    for task in dev.select(range(3)):
        print(f"  [{task['task_id']}] {task['question'][:70]}...")


def show_tasks(split: str = "dev"):
    """Show all tasks in a split."""
    dataset = datasets.load_dataset("adyen/DABstep", name="tasks", split=split)
    df = dataset.to_pandas()

    print(f"\nAll {len(df)} tasks in '{split}' split:")
    print("-" * 80)

    for _, row in df.iterrows():
        print(f"\n[{row['task_id']}] Level: {row['level']}")
        print(f"Q: {row['question']}")
        print(f"A: {row['answer']}")
        print(f"Guidelines: {row['guidelines'][:100]}...")


def show_task(task_id: str):
    """Show a specific task."""
    # Try dev first, then default
    for split in ["dev", "default"]:
        dataset = datasets.load_dataset("adyen/DABstep", name="tasks", split=split)
        for task in dataset:
            if str(task['task_id']) == str(task_id):
                print(f"\nTask {task_id} (from {split} split)")
                print("=" * 60)
                print(f"Level: {task['level']}")
                print(f"\nQuestion:\n{task['question']}")
                print(f"\nAnswer:\n{task['answer']}")
                print(f"\nGuidelines:\n{task['guidelines']}")
                return

    print(f"Task {task_id} not found")


def show_files():
    """Show context files info."""
    print("\nContext Files:")
    print("=" * 60)

    for filename in CONTEXT_FILES:
        filepath = Path(DATA_DIR) / filename
        if filepath.exists():
            size = filepath.stat().st_size
            print(f"\n{filename} ({size:,} bytes)")

            if filename.endswith('.csv'):
                df = pd.read_csv(filepath)
                print(f"  Rows: {len(df)}, Columns: {list(df.columns)}")
            elif filename.endswith('.json'):
                with open(filepath) as f:
                    data = json.load(f)
                if isinstance(data, list):
                    print(f"  Items: {len(data)}")
                elif isinstance(data, dict):
                    print(f"  Keys: {list(data.keys())[:5]}...")
            elif filename.endswith('.md'):
                with open(filepath) as f:
                    content = f.read()
                print(f"  Lines: {len(content.splitlines())}")
        else:
            print(f"\n{filename} (NOT DOWNLOADED)")


def main():
    parser = argparse.ArgumentParser(description="Explore DABstep dataset")
    parser.add_argument("--tasks", action="store_true", help="Show all tasks")
    parser.add_argument("--files", action="store_true", help="Show context files")
    parser.add_argument("--task", type=str, help="Show specific task by ID")
    parser.add_argument("--split", default="dev", help="Dataset split (dev/default)")

    args = parser.parse_args()

    if args.task:
        show_task(args.task)
    elif args.tasks:
        show_tasks(args.split)
    elif args.files:
        show_files()
    else:
        show_overview()


if __name__ == "__main__":
    main()
