# -*- coding: utf-8 -*-
"""
Spider2-DBT Benchmark Runner for Texera Agent Service

This script runs the Spider2-DBT benchmark using the DataflowAgent that interacts
with Texera's Agent Service. Spider2-DBT contains 69 examples of DuckDB data
transformation projects that require complex SQL generation and code comprehension.

Usage:
    uv run python -m benchmarks.spider_2_dbt                    # Run with defaults
    uv run python -m benchmarks.spider_2_dbt --max-tasks 10     # Run with more tasks
    uv run python -m benchmarks.spider_2_dbt --baseline         # Run with smolagents

Requirements:
    - Texera backend running on localhost:8080
    - Agent service running on localhost:3001
    - Spider2-DBT data downloaded (run with --setup first)

Reference:
    https://github.com/xlang-ai/Spider2/tree/main/spider2-dbt
"""

import os
import time
import json
import shutil
import zipfile
import argparse
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

import pandas as pd

from agents.dataflow_agent import (
    DataflowAgent,
    MessageResult,
    delete_all_agents,
    list_all_agents,
    get_agent_workflow,
    AGENT_MODEL_TYPE,
    AGENT_MAX_STEPS,
    AGENT_MAX_OPERATOR_RESULT_CHAR_LIMIT,
    AGENT_MAX_OPERATOR_RESULT_CELL_CHAR_LIMIT,
    AGENT_OPERATOR_RESULT_SERIALIZATION_MODE,
    AGENT_TOOL_TIMEOUT_SECONDS,
    AGENT_EXECUTION_TIMEOUT_MINUTES,
    AGENT_MODE,
    TEXERA_AGENT_SERVICE_ENDPOINT,
)

from agents.code_agent import (
    CodeAgentWrapper,
    CodeAgentResult,
    CODE_AGENT_MODEL_TYPE,
    CODE_AGENT_MAX_STEPS,
)


# ============================================================================
# Configuration
# ============================================================================

# Spider2-DBT Repository and Data URLs
SPIDER2_REPO = "https://github.com/xlang-ai/Spider2"
SPIDER2_DBT_RAW_BASE = "https://raw.githubusercontent.com/xlang-ai/Spider2/main/spider2-dbt"

# Google Drive IDs for downloading data (from Spider2 README)
# These are the file IDs for gdown
DBT_START_DB_GDRIVE_ID = "1gSF_XNCm0XfaIouz_6O0l_VVdJjbRRCY"
DBT_GOLD_GDRIVE_ID = "1VENqqGK_GVCkhzfyH9J0e1H6lHvJpB2Y"

# Default data directory
DATA_DIR = Path("/tmp/spider2-dbt-data")

# Output directory for results
RUNS_DIR = Path(__file__).parent.parent / "runs" / "spider2-dbt"

# JSONL task file
TASKS_JSONL = "examples/spider2-dbt.jsonl"

# Evaluation gold data
EVAL_GOLD_JSONL = "evaluation_suite/gold/spider2_eval.jsonl"


# ============================================================================
# Prompt Template
# ============================================================================

# Prompt template for the dataflow agent
PROMPT = """You are an expert data engineer working on a DuckDB data transformation project.

## Task
{instruction}

## Project Context
You have access to the following project directory:
{project_path}

The project contains DuckDB database files and may include dbt models, SQL files, and documentation.

## Available Files
{file_list}

## Guidelines
1. Analyze the project structure and understand the data schema
2. Read any documentation or SQL files to understand the transformation logic
3. Write SQL queries or dbt models to complete the transformation task
4. Execute your solution and verify the results
5. Your final answer should be the result of the transformation (e.g., a CSV table or specific values)

## Important
- Use DuckDB SQL syntax for queries
- If the task asks for a file output, save it with the specified filename
- Provide clear explanations of your approach

Your final response should contain the answer or indicate the output file location.
"""

# Prompt template for the baseline code agent (smolagents)
BASELINE_PROMPT = """You are an expert data engineer working on a DuckDB data transformation project.

## Task
{instruction}

## Project Context
You have access to the following project directory:
{project_path}

## Available Files
{file_list}

## Guidelines
1. Use Python with DuckDB to analyze and transform data
2. Read documentation and SQL files to understand the schema
3. Execute SQL queries using duckdb.connect() and duckdb.sql()
4. Save results as CSV files when required
5. Your final answer should be the transformation result

Use the following imports:
- import duckdb
- import pandas as pd
- import json, csv, os

Your final response should contain the answer or the path to the output file.
"""


# ============================================================================
# Setup Functions
# ============================================================================


def setup_spider2_dbt(data_dir: Path = DATA_DIR, force: bool = False) -> bool:
    """
    Setup Spider2-DBT benchmark data.

    This function:
    1. Clones/downloads necessary files from the Spider2 repository
    2. Downloads the DuckDB database files using gdown
    3. Extracts and organizes the data

    Args:
        data_dir: Directory to store benchmark data
        force: Force re-download even if data exists

    Returns:
        True if setup was successful
    """
    print(f"[Spider2-DBT] Setting up benchmark data in {data_dir}...")

    data_dir.mkdir(parents=True, exist_ok=True)

    # Check if already set up
    examples_dir = data_dir / "examples"
    eval_dir = data_dir / "evaluation_suite"

    if examples_dir.exists() and eval_dir.exists() and not force:
        print("[Spider2-DBT] Data already exists. Use --force to re-download.")
        return True

    # Step 1: Download JSONL task file
    print("[Spider2-DBT] Downloading task definitions...")
    jsonl_url = f"{SPIDER2_DBT_RAW_BASE}/{TASKS_JSONL}"
    jsonl_path = data_dir / TASKS_JSONL
    jsonl_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        import requests
        response = requests.get(jsonl_url)
        response.raise_for_status()
        with open(jsonl_path, 'w') as f:
            f.write(response.text)
        print(f"  [done] {TASKS_JSONL}")
    except Exception as e:
        print(f"  [error] Failed to download task file: {e}")
        return False

    # Step 2: Download evaluation gold JSONL
    print("[Spider2-DBT] Downloading evaluation metadata...")
    eval_jsonl_url = f"{SPIDER2_DBT_RAW_BASE}/{EVAL_GOLD_JSONL}"
    eval_jsonl_path = data_dir / EVAL_GOLD_JSONL
    eval_jsonl_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        response = requests.get(eval_jsonl_url)
        response.raise_for_status()
        with open(eval_jsonl_path, 'w') as f:
            f.write(response.text)
        print(f"  [done] {EVAL_GOLD_JSONL}")
    except Exception as e:
        print(f"  [error] Failed to download eval file: {e}")
        # Continue anyway, evaluation might not be available

    # Step 3: Download DuckDB database files using gdown
    print("[Spider2-DBT] Downloading DuckDB database files...")
    print("  NOTE: This requires 'gdown' package and may take a while.")

    try:
        import gdown

        # Download start databases
        start_db_zip = data_dir / "DBT_start_db.zip"
        if not start_db_zip.exists() or force:
            print("  Downloading DBT_start_db.zip...")
            gdown.download(id=DBT_START_DB_GDRIVE_ID, output=str(start_db_zip), quiet=False)

        # Download gold databases
        gold_db_zip = data_dir / "dbt_gold.zip"
        if not gold_db_zip.exists() or force:
            print("  Downloading dbt_gold.zip...")
            gdown.download(id=DBT_GOLD_GDRIVE_ID, output=str(gold_db_zip), quiet=False)

        # Extract files
        print("[Spider2-DBT] Extracting database files...")
        _extract_dbt_data(data_dir, start_db_zip, gold_db_zip)

        print("[Spider2-DBT] Setup complete!")
        return True

    except ImportError:
        print("  [error] gdown not installed. Install with: pip install gdown")
        print("  [info] You can manually download the files from Google Drive:")
        print(f"         - DBT_start_db.zip: https://drive.google.com/uc?id={DBT_START_DB_GDRIVE_ID}")
        print(f"         - dbt_gold.zip: https://drive.google.com/uc?id={DBT_GOLD_GDRIVE_ID}")
        return False
    except Exception as e:
        print(f"  [error] Failed to download database files: {e}")
        return False


def _extract_dbt_data(data_dir: Path, start_db_zip: Path, gold_db_zip: Path):
    """Extract and organize DuckDB database files."""
    examples_dir = data_dir / "examples"
    gold_dir = data_dir / "evaluation_suite" / "gold"

    examples_dir.mkdir(parents=True, exist_ok=True)
    gold_dir.mkdir(parents=True, exist_ok=True)

    # Extract start databases to examples
    if start_db_zip.exists():
        temp_dir = data_dir / "temp_start"
        with zipfile.ZipFile(start_db_zip, 'r') as zip_ref:
            zip_ref.extractall(temp_dir)

        # Move .duckdb files to appropriate folders
        for folder in temp_dir.iterdir():
            if folder.name == "__MACOSX":
                continue
            if folder.is_dir():
                target = examples_dir / folder.name
                target.mkdir(parents=True, exist_ok=True)
                for db_file in folder.rglob("*.duckdb"):
                    shutil.move(str(db_file), str(target / db_file.name))

        shutil.rmtree(temp_dir)
        print(f"  [done] Extracted start databases to {examples_dir}")

    # Extract gold databases
    if gold_db_zip.exists():
        temp_dir = data_dir / "temp_gold"
        with zipfile.ZipFile(gold_db_zip, 'r') as zip_ref:
            zip_ref.extractall(temp_dir)

        for folder in temp_dir.iterdir():
            if folder.name == "__MACOSX":
                continue
            if folder.is_dir():
                target = gold_dir / folder.name
                target.mkdir(parents=True, exist_ok=True)
                for db_file in folder.rglob("*.duckdb"):
                    shutil.move(str(db_file), str(target / db_file.name))

        shutil.rmtree(temp_dir)
        print(f"  [done] Extracted gold databases to {gold_dir}")


# ============================================================================
# Task Loading
# ============================================================================


def load_tasks(
    data_dir: Path = DATA_DIR,
    max_tasks: Optional[int] = None,
    task_filter: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Load Spider2-DBT tasks from JSONL file.

    Args:
        data_dir: Base directory containing benchmark data
        max_tasks: Maximum number of tasks to load
        task_filter: Filter tasks by instance_id prefix

    Returns:
        List of task dictionaries
    """
    jsonl_path = data_dir / TASKS_JSONL

    if not jsonl_path.exists():
        raise FileNotFoundError(
            f"Task file not found: {jsonl_path}\n"
            "Run with --setup to download benchmark data first."
        )

    tasks = []
    with open(jsonl_path, 'r') as f:
        for line in f:
            line = line.strip()
            if line:
                task = json.loads(line)
                if task_filter and not task['instance_id'].startswith(task_filter):
                    continue
                tasks.append(task)

    print(f"[Spider2-DBT] Loaded {len(tasks)} tasks")

    if max_tasks and max_tasks < len(tasks):
        tasks = tasks[:max_tasks]
        print(f"[Spider2-DBT] Limited to {max_tasks} tasks")

    return tasks


def get_project_files(project_path: Path) -> str:
    """Get a formatted list of files in the project directory."""
    if not project_path.exists():
        return "(project directory not found)"

    files = []
    for item in sorted(project_path.rglob("*")):
        if item.is_file():
            rel_path = item.relative_to(project_path)
            size = item.stat().st_size
            files.append(f"  - {rel_path} ({size} bytes)")

    if not files:
        return "(no files found)"

    return "\n".join(files[:50])  # Limit to first 50 files


# ============================================================================
# Evaluation Utilities
# ============================================================================


def compare_tables(pred_path: Path, gold_path: Path, ignore_order: bool = True) -> float:
    """
    Compare predicted and gold CSV tables.

    Args:
        pred_path: Path to predicted CSV
        gold_path: Path to gold CSV
        ignore_order: Whether to ignore row order

    Returns:
        Score (1.0 for match, 0.0 for no match)
    """
    try:
        pred_df = pd.read_csv(pred_path)
        gold_df = pd.read_csv(gold_path)

        # Normalize column names
        pred_df.columns = [c.lower().strip() for c in pred_df.columns]
        gold_df.columns = [c.lower().strip() for c in gold_df.columns]

        if set(pred_df.columns) != set(gold_df.columns):
            return 0.0

        # Reorder columns to match
        pred_df = pred_df[sorted(pred_df.columns)]
        gold_df = gold_df[sorted(gold_df.columns)]

        if ignore_order:
            pred_df = pred_df.sort_values(by=list(pred_df.columns)).reset_index(drop=True)
            gold_df = gold_df.sort_values(by=list(gold_df.columns)).reset_index(drop=True)

        if pred_df.shape != gold_df.shape:
            return 0.0

        # Compare values with tolerance for numeric columns
        for col in pred_df.columns:
            if pd.api.types.is_numeric_dtype(pred_df[col]):
                if not pd.np.allclose(pred_df[col].fillna(0), gold_df[col].fillna(0), rtol=1e-3, equal_nan=True):
                    return 0.0
            else:
                if not (pred_df[col].fillna('').astype(str) == gold_df[col].fillna('').astype(str)).all():
                    return 0.0

        return 1.0

    except Exception as e:
        print(f"[Eval] Table comparison error: {e}")
        return 0.0


def compare_duckdb(pred_path: Path, gold_path: Path, table_name: str = None) -> float:
    """
    Compare DuckDB database files.

    Args:
        pred_path: Path to predicted DuckDB file
        gold_path: Path to gold DuckDB file
        table_name: Specific table to compare (None for all tables)

    Returns:
        Score (1.0 for match, 0.0 for no match)
    """
    try:
        import duckdb

        pred_conn = duckdb.connect(str(pred_path), read_only=True)
        gold_conn = duckdb.connect(str(gold_path), read_only=True)

        # Get tables to compare
        if table_name:
            tables = [table_name]
        else:
            pred_tables = set(pred_conn.execute("SHOW TABLES").fetchdf()['name'].tolist())
            gold_tables = set(gold_conn.execute("SHOW TABLES").fetchdf()['name'].tolist())
            tables = list(pred_tables & gold_tables)

        if not tables:
            return 0.0

        all_match = True
        for table in tables:
            pred_df = pred_conn.execute(f"SELECT * FROM {table}").fetchdf()
            gold_df = gold_conn.execute(f"SELECT * FROM {table}").fetchdf()

            # Sort and compare
            pred_df = pred_df.sort_values(by=list(pred_df.columns)).reset_index(drop=True)
            gold_df = gold_df.sort_values(by=list(gold_df.columns)).reset_index(drop=True)

            if not pred_df.equals(gold_df):
                all_match = False
                break

        pred_conn.close()
        gold_conn.close()

        return 1.0 if all_match else 0.0

    except Exception as e:
        print(f"[Eval] DuckDB comparison error: {e}")
        return 0.0


# ============================================================================
# Benchmark Runner
# ============================================================================


def extract_answer_from_messages(messages: List[Dict]) -> str:
    """
    Extract the answer from agent messages when response is empty.

    Looks for the last substantive assistant text message.
    """
    if not messages:
        return ""

    # Find the last assistant message with meaningful text content
    for msg in reversed(messages):
        if msg.get('role') != 'assistant':
            continue

        content = msg.get('content', '')

        # Handle string content
        if isinstance(content, str) and content.strip():
            return content.strip()

        # Handle list content (Claude format with text blocks)
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get('type') == 'text':
                    text = item.get('text', '').strip()
                    if text:
                        return text

    return ""


def run_single_task(
    task: Dict[str, Any],
    data_dir: Path,
    base_run_dir: Path,
    timestamp: str,
    model_type: str = AGENT_MODEL_TYPE,
    max_steps: int = AGENT_MAX_STEPS,
    max_operator_result_char_limit: int = AGENT_MAX_OPERATOR_RESULT_CHAR_LIMIT,
    max_operator_result_cell_char_limit: int = AGENT_MAX_OPERATOR_RESULT_CELL_CHAR_LIMIT,
    operator_result_serialization_mode: str = AGENT_OPERATOR_RESULT_SERIALIZATION_MODE,
    tool_timeout_seconds: int = AGENT_TOOL_TIMEOUT_SECONDS,
    execution_timeout_minutes: int = AGENT_EXECUTION_TIMEOUT_MINUTES,
    agent_mode: str = AGENT_MODE,
    verbosity_level: int = 1,
    retain: bool = False,
) -> Dict[str, Any]:
    """
    Run a single Spider2-DBT task with a fresh agent and workflow.
    """
    instance_id = task["instance_id"]
    instruction = task["instruction"]
    task_type = task.get("type", "DBT")

    print(f"\n[Task {instance_id}] {instruction[:80]}...")

    # Create task-specific folder
    task_dir = base_run_dir / f"{timestamp}_{instance_id}"
    task_dir.mkdir(parents=True, exist_ok=True)

    # Get project path
    project_path = data_dir / "examples" / instance_id
    file_list = get_project_files(project_path)

    # Format prompt
    prompt = PROMPT.format(
        instruction=instruction,
        project_path=str(project_path),
        file_list=file_list,
    )

    # Create agent
    agent = DataflowAgent(
        model_type=model_type,
        max_steps=max_steps,
        max_operator_result_char_limit=max_operator_result_char_limit,
        max_operator_result_cell_char_limit=max_operator_result_cell_char_limit,
        operator_result_serialization_mode=operator_result_serialization_mode,
        tool_timeout_seconds=tool_timeout_seconds,
        execution_timeout_minutes=execution_timeout_minutes,
        agent_mode=agent_mode,
        verbosity_level=verbosity_level,
        workflow_name=f"Spider2-DBT {instance_id}",
        agent_name=f"spider2-{instance_id}",
    )

    start_time = time.time()
    message_result: Optional[MessageResult] = None
    workflow_content = None
    answer = ""
    elapsed = 0.0
    error = None

    try:
        agent.setup()
        print(f"[Task {instance_id}] Created agent: {agent.agent_id}")

        message_result = agent.run(prompt)
        elapsed = time.time() - start_time

        # Extract answer - try response first, then messages
        answer = message_result.response
        if not answer and message_result.messages:
            answer = extract_answer_from_messages(message_result.messages)

        error = message_result.error
        print(f"[Task {instance_id}] Completed in {elapsed:.1f}s")

        # Fetch workflow
        try:
            workflow_content = get_agent_workflow(agent.agent_id)
            print(f"[Task {instance_id}] Workflow: {len(workflow_content.get('operators', []))} operators")
        except Exception as e:
            print(f"[Task {instance_id}] Failed to fetch workflow: {e}")

    except Exception as e:
        elapsed = time.time() - start_time
        answer = f"ERROR: {e}"
        error = str(e)
        print(f"[Task {instance_id}] Failed after {elapsed:.1f}s: {e}")
    finally:
        if not retain:
            agent.cleanup()

    # Save files
    _save_file(task_dir / "prompt.txt", prompt)
    _save_file(task_dir / "instruction.txt", instruction)
    _save_file(task_dir / "answer.txt", answer)

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

    return {
        "instance_id": instance_id,
        "task_dir": str(task_dir),
        "answer": answer,
        "task_type": task_type,
        "workflow_id": agent._workflow_id,
        "agent_id": agent.agent_id,
        "elapsed_seconds": elapsed,
        "error": error,
    }


def _save_file(path: Path, content: str) -> None:
    """Save text content to a file."""
    with open(path, "w") as f:
        f.write(content)


def _save_json(path: Path, data: dict) -> None:
    """Save JSON data to a file."""
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def run_benchmark(
    tasks: List[Dict[str, Any]],
    data_dir: Path,
    base_run_dir: Path,
    timestamp: str,
    model_type: str = AGENT_MODEL_TYPE,
    max_steps: int = AGENT_MAX_STEPS,
    max_operator_result_char_limit: int = AGENT_MAX_OPERATOR_RESULT_CHAR_LIMIT,
    max_operator_result_cell_char_limit: int = AGENT_MAX_OPERATOR_RESULT_CELL_CHAR_LIMIT,
    operator_result_serialization_mode: str = AGENT_OPERATOR_RESULT_SERIALIZATION_MODE,
    tool_timeout_seconds: int = AGENT_TOOL_TIMEOUT_SECONDS,
    execution_timeout_minutes: int = AGENT_EXECUTION_TIMEOUT_MINUTES,
    agent_mode: str = AGENT_MODE,
    verbosity_level: int = 1,
    retain: bool = False,
) -> List[Dict[str, Any]]:
    """Run the full benchmark sequentially."""
    results = []
    total = len(tasks)

    print(f"\n[Benchmark] Running {total} tasks sequentially (model={model_type}, max_steps={max_steps})")
    if retain:
        print("[Benchmark] RETAIN MODE: Agents and workflows will NOT be deleted")

    for i, task in enumerate(tasks):
        print(f"\n--- Task {i + 1}/{total} ---")
        result = run_single_task(
            task=task,
            data_dir=data_dir,
            base_run_dir=base_run_dir,
            timestamp=timestamp,
            model_type=model_type,
            max_steps=max_steps,
            max_operator_result_char_limit=max_operator_result_char_limit,
            max_operator_result_cell_char_limit=max_operator_result_cell_char_limit,
            operator_result_serialization_mode=operator_result_serialization_mode,
            tool_timeout_seconds=tool_timeout_seconds,
            execution_timeout_minutes=execution_timeout_minutes,
            agent_mode=agent_mode,
            verbosity_level=verbosity_level,
            retain=retain,
        )
        results.append(result)

    return results


# ============================================================================
# Baseline Code Agent Benchmark
# ============================================================================


def run_baseline_single_task(
    task: Dict[str, Any],
    data_dir: Path,
    base_run_dir: Path,
    timestamp: str,
    model_type: str = CODE_AGENT_MODEL_TYPE,
    max_steps: int = CODE_AGENT_MAX_STEPS,
    verbosity_level: int = 1,
) -> Dict[str, Any]:
    """
    Run a single Spider2-DBT task with the baseline code agent.
    """
    instance_id = task["instance_id"]
    instruction = task["instruction"]
    task_type = task.get("type", "DBT")

    print(f"\n[Baseline {instance_id}] {instruction[:80]}...")

    # Create task-specific folder
    task_dir = base_run_dir / f"{timestamp}_{instance_id}"
    task_dir.mkdir(parents=True, exist_ok=True)

    # Get project path
    project_path = data_dir / "examples" / instance_id
    file_list = get_project_files(project_path)

    # Format prompt
    prompt = BASELINE_PROMPT.format(
        instruction=instruction,
        project_path=str(project_path),
        file_list=file_list,
    )

    # Create agent
    agent = CodeAgentWrapper(
        model_type=model_type,
        max_steps=max_steps,
        verbosity_level=verbosity_level,
        agent_name=f"spider2-baseline-{instance_id}",
    )

    start_time = time.time()
    result: Optional[CodeAgentResult] = None
    answer = ""
    elapsed = 0.0
    error = None

    try:
        agent.setup()
        print(f"[Baseline {instance_id}] Created code agent")

        result = agent.run(prompt)
        elapsed = time.time() - start_time
        answer = result.response
        error = result.error
        print(f"[Baseline {instance_id}] Completed in {elapsed:.1f}s")

    except Exception as e:
        elapsed = time.time() - start_time
        answer = f"ERROR: {e}"
        error = str(e)
        print(f"[Baseline {instance_id}] Failed after {elapsed:.1f}s: {e}")
    finally:
        agent.cleanup()

    # Save files
    _save_file(task_dir / "prompt.txt", prompt)
    _save_file(task_dir / "instruction.txt", instruction)
    _save_file(task_dir / "answer.txt", answer)

    if result:
        _save_json(task_dir / "trace.json", {
            "response": result.response,
            "reasoning_trace": result.reasoning_trace,
            "elapsed_seconds": result.elapsed_seconds,
            "error": result.error,
        })

    return {
        "instance_id": instance_id,
        "task_dir": str(task_dir),
        "answer": answer,
        "task_type": task_type,
        "agent_id": agent.agent_id,
        "elapsed_seconds": elapsed,
        "error": error,
    }


def run_baseline_benchmark(
    tasks: List[Dict[str, Any]],
    data_dir: Path,
    base_run_dir: Path,
    timestamp: str,
    model_type: str = CODE_AGENT_MODEL_TYPE,
    max_steps: int = CODE_AGENT_MAX_STEPS,
    verbosity_level: int = 1,
) -> List[Dict[str, Any]]:
    """Run the baseline code agent benchmark sequentially."""
    results = []
    total = len(tasks)

    print(f"\n[Baseline] Running {total} tasks sequentially (model={model_type}, max_steps={max_steps})")

    for i, task in enumerate(tasks):
        print(f"\n--- Baseline Task {i + 1}/{total} ---")
        result = run_baseline_single_task(
            task=task,
            data_dir=data_dir,
            base_run_dir=base_run_dir,
            timestamp=timestamp,
            model_type=model_type,
            max_steps=max_steps,
            verbosity_level=verbosity_level,
        )
        results.append(result)

    return results


# ============================================================================
# Main Entry Point
# ============================================================================


def cleanup_existing_agents() -> int:
    """Delete all existing agents in the agent service."""
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
        description="Run Spider2-DBT benchmark with Texera Agent Service"
    )

    # Setup options
    parser.add_argument(
        "--setup",
        action="store_true",
        help="Download and setup Spider2-DBT benchmark data",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force re-download of benchmark data (with --setup)",
    )

    # Task options
    parser.add_argument(
        "--max-tasks",
        type=int,
        default=None,
        help="Maximum number of tasks to run (default: all)",
    )
    parser.add_argument(
        "--filter",
        type=str,
        default=None,
        help="Filter tasks by instance_id prefix (e.g., 'playbook')",
    )
    parser.add_argument(
        "--data-dir",
        type=str,
        default=str(DATA_DIR),
        help=f"Directory for benchmark data (default: {DATA_DIR})",
    )

    # Agent settings
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
        "--max-result-chars",
        type=int,
        default=AGENT_MAX_OPERATOR_RESULT_CHAR_LIMIT,
        help=f"Max characters for operator results (default: {AGENT_MAX_OPERATOR_RESULT_CHAR_LIMIT})",
    )
    parser.add_argument(
        "--max-cell-chars",
        type=int,
        default=AGENT_MAX_OPERATOR_RESULT_CELL_CHAR_LIMIT,
        help=f"Max characters per cell (default: {AGENT_MAX_OPERATOR_RESULT_CELL_CHAR_LIMIT})",
    )
    parser.add_argument(
        "--result-format",
        type=str,
        choices=["json", "table", "toon"],
        default=AGENT_OPERATOR_RESULT_SERIALIZATION_MODE,
        help=f"Result serialization format (default: {AGENT_OPERATOR_RESULT_SERIALIZATION_MODE})",
    )
    parser.add_argument(
        "--tool-timeout",
        type=int,
        default=AGENT_TOOL_TIMEOUT_SECONDS,
        help=f"Tool execution timeout in seconds (default: {AGENT_TOOL_TIMEOUT_SECONDS})",
    )
    parser.add_argument(
        "--execution-timeout",
        type=int,
        default=AGENT_EXECUTION_TIMEOUT_MINUTES,
        help=f"Workflow execution timeout in minutes (default: {AGENT_EXECUTION_TIMEOUT_MINUTES})",
    )
    parser.add_argument(
        "--agent-mode",
        type=str,
        choices=["code", "general"],
        default=AGENT_MODE,
        help=f"Agent mode (default: {AGENT_MODE})",
    )

    # Execution options
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
        help="Retain agents and workflows after tasks (for debugging)",
    )
    parser.add_argument(
        "--no-cleanup",
        action="store_true",
        help="Skip initial cleanup of existing agents",
    )
    parser.add_argument(
        "--baseline",
        action="store_true",
        help="Run baseline code agent (smolagents) instead",
    )

    args = parser.parse_args()
    data_dir = Path(args.data_dir)

    # Handle setup command
    if args.setup:
        success = setup_spider2_dbt(data_dir, force=args.force)
        if success:
            print("\n[Spider2-DBT] Setup complete! You can now run the benchmark.")
        else:
            print("\n[Spider2-DBT] Setup failed. Please check the errors above.")
        return

    # Print configuration
    print("=" * 60)
    if args.baseline:
        print("Spider2-DBT Benchmark - Baseline Code Agent (smolagents)")
    else:
        print("Spider2-DBT Benchmark - Texera Agent Service")
    print("=" * 60)
    print(f"Mode: {'Baseline' if args.baseline else 'Dataflow'}")
    print(f"Max tasks: {args.max_tasks or 'all'}")
    print(f"Filter: {args.filter or 'none'}")
    print(f"Model: {args.model}")
    print(f"Max steps: {args.max_steps}")
    print(f"Data dir: {data_dir}")
    if not args.baseline:
        print(f"Agent mode: {args.agent_mode}")
        print(f"Max result chars: {args.max_result_chars}")
        print(f"Result format: {args.result_format}")
        print(f"Retain mode: {args.retain}")
    print("=" * 60)

    # Cleanup existing agents
    if not args.no_cleanup and not args.baseline:
        cleanup_existing_agents()

    # Load tasks
    try:
        tasks = load_tasks(
            data_dir=data_dir,
            max_tasks=args.max_tasks,
            task_filter=args.filter,
        )
    except FileNotFoundError as e:
        print(f"\n[Error] {e}")
        print("Run with --setup to download benchmark data first.")
        return

    if not tasks:
        print("[Error] No tasks found matching the criteria.")
        return

    # Run benchmark
    timestamp = get_timestamp()

    if args.baseline:
        run_dir = RUNS_DIR / "baseline"
    else:
        run_dir = RUNS_DIR
    run_dir.mkdir(parents=True, exist_ok=True)

    if args.baseline:
        results = run_baseline_benchmark(
            tasks=tasks,
            data_dir=data_dir,
            base_run_dir=run_dir,
            timestamp=timestamp,
            model_type=args.model,
            max_steps=args.max_steps,
            verbosity_level=args.verbosity,
        )
    else:
        results = run_benchmark(
            tasks=tasks,
            data_dir=data_dir,
            base_run_dir=run_dir,
            timestamp=timestamp,
            model_type=args.model,
            max_steps=args.max_steps,
            max_operator_result_char_limit=args.max_result_chars,
            max_operator_result_cell_char_limit=args.max_cell_chars,
            operator_result_serialization_mode=args.result_format,
            tool_timeout_seconds=args.tool_timeout,
            execution_timeout_minutes=args.execution_timeout,
            agent_mode=args.agent_mode,
            verbosity_level=args.verbosity,
            retain=args.retain,
        )

    # Print summary
    print(f"\n[Benchmark] Complete! {len(results)} tasks, timestamp: {timestamp}")
    for r in results:
        err = f" ERROR: {r['error']}" if r.get("error") else ""
        print(f"  {r['instance_id']}: {r['elapsed_seconds']:.1f}s{err}")

    # Save results metadata for evaluation
    results_metadata = []
    for r in results:
        results_metadata.append({
            "instance_id": r["instance_id"],
            "answer_type": "answer",
            "answer_or_path": r["answer"][:1000] if r["answer"] else "",  # Truncate for metadata
        })

    metadata_path = run_dir / "results_metadata.jsonl"
    with open(metadata_path, 'w') as f:
        for entry in results_metadata:
            f.write(json.dumps(entry) + "\n")
    print(f"\n[Benchmark] Results metadata saved to: {metadata_path}")

    successful = sum(1 for r in results if not r.get("error"))
    print(f"\n[Benchmark] Success rate: {successful}/{len(results)} ({100*successful/len(results):.1f}%)")


if __name__ == "__main__":
    main()
