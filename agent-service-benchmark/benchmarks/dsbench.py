# -*- coding: utf-8 -*-
"""
DSBench Benchmark Runner for Texera Agent Service

Runs the DSBench benchmark (https://github.com/LiqiangJing/DSBench) using
DataflowAgent. This benchmark evaluates data science agents on realistic tasks.

DSBench has two task categories:
1. Data Modeling (Kaggle) - 74 ML competitions
   - Train models on train.csv, predict on test.csv
   - Evaluated using sklearn metrics (accuracy, RMSE, etc.)

2. Data Analysis (ModelOff) - 37 challenges, 466+ questions
   - Answer questions about Excel financial workbooks
   - Evaluated using LLM-as-judge (GPT-4o)

Usage:
    # List available tasks
    python -m benchmarks.dsbench list

    # Run data modeling tasks (Kaggle)
    python -m benchmarks.dsbench run --task-type modeling --max-tasks 5

    # Run data analysis tasks (ModelOff)
    python -m benchmarks.dsbench run --task-type analysis --max-tasks 5

    # Run specific task by ID
    python -m benchmarks.dsbench run --task-ids titanic

    # Resume an interrupted run
    python -m benchmarks.dsbench resume runs/dsbench/20260105_120000_modeling

    # Collect and evaluate results
    python -m benchmarks.dsbench collect runs/dsbench/20260105_120000_modeling
    python -m benchmarks.dsbench evaluate runs/dsbench/20260105_120000_modeling
"""

import os
import sys
import time
import json
import argparse
import subprocess
import threading
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any, Set, Tuple

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

DSBENCH_DIR = Path(__file__).parent / "DSBench"
DATA_DIR = DSBENCH_DIR / "data"
DATA_MODELING_DIR = DSBENCH_DIR / "data_modeling"
DATA_ANALYSIS_DIR = DSBENCH_DIR / "data_analysis"
RUNS_DIR = Path(__file__).parent.parent / "runs" / "dsbench"

# Task type constants
TASK_TYPE_MODELING = "modeling"  # Kaggle ML competitions
TASK_TYPE_ANALYSIS = "analysis"  # ModelOff Excel questions

# =============================================================================
# Prompt Templates
# =============================================================================

# Data Modeling (Kaggle) prompt template
MODELING_PROMPT_TEMPLATE = """You are an expert data scientist competing in a Kaggle competition.

## Competition Description
{description}

## Input Data Files
The following data files are available:
{input_files_section}

## Output Requirements
IMPORTANT: You MUST save your predictions to:
{output_dir}/submission.csv

The submission file format is specified in the competition description above.

## Instructions
1. Read and explore the training data to understand the problem
2. Perform feature engineering and data preprocessing as needed
3. Train a machine learning model on the training data
4. Generate predictions for the test data
5. Save predictions to the output file in the correct format
6. Verify the submission file has the correct columns and number of rows
"""

# Data Analysis (ModelOff) prompt template
ANALYSIS_PROMPT_TEMPLATE = """You are an expert financial analyst solving a ModelOff competition question.

## Data File
The following Excel workbook contains the data you need to analyze:
{data_file}

## Question
{question}

## Instructions
1. Read and analyze the Excel workbook
2. Perform the necessary calculations or analysis
3. Provide your final answer

IMPORTANT: Your final answer should be clear and concise.
- For multiple choice questions, respond with just the letter (e.g., "A", "B", "C", etc.)
- For numeric questions, respond with just the number
- For text questions, respond with the exact text answer

Save your answer to: {output_dir}/answer.txt
"""


# =============================================================================
# Data Loading - Data Modeling (Kaggle)
# =============================================================================

def load_modeling_tasks(
    max_tasks: Optional[int] = None,
    task_ids: Optional[List[str]] = None,
) -> List[Dict]:
    """Load data modeling (Kaggle) tasks from data_modeling/data.json.

    Each task represents a Kaggle competition with train/test data.
    """
    tasks = []
    data_json = DATA_MODELING_DIR / "data.json"

    if not data_json.exists():
        print(f"[DSBench] Warning: {data_json} not found")
        return tasks

    # Load competition metadata
    with open(data_json) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                comp = json.loads(line)
            except json.JSONDecodeError:
                continue

            task_id = comp.get("name", "")
            if not task_id:
                continue

            # Filter by task_ids if specified
            if task_ids and task_id not in task_ids:
                continue

            # Check if task description exists
            task_file = DATA_DIR / "task" / f"{task_id}.txt"
            if not task_file.exists():
                continue

            # Check if data files exist
            data_resplit_dir = DATA_DIR / "data_resplit" / task_id
            if not data_resplit_dir.exists():
                continue

            # Check for eval script
            eval_script = DATA_MODELING_DIR / "evaluation" / f"{task_id}_eval.py"

            # Check for answer file
            answer_file = DATA_DIR / "answers" / task_id / "test_answer.csv"

            # Load task description
            with open(task_file) as tf:
                description = tf.read()

            # Get input files
            input_files = []
            for f in data_resplit_dir.iterdir():
                if f.is_file() and f.suffix in ['.csv', '.xlsx', '.json']:
                    input_files.append(str(f.absolute()))

            tasks.append({
                "task_id": task_id,
                "task_type": TASK_TYPE_MODELING,
                "description": description,
                "input_files": sorted(input_files),
                "data_dir": str(data_resplit_dir.absolute()),
                "eval_script": str(eval_script) if eval_script.exists() else None,
                "answer_file": str(answer_file) if answer_file.exists() else None,
                "url": comp.get("url", ""),
                "year": comp.get("year", ""),
            })

            if max_tasks and len(tasks) >= max_tasks:
                break

    return tasks


def format_input_files_section(input_files: List[str]) -> str:
    """Format input files as a readable section for the prompt."""
    if not input_files:
        return "No input data files available."

    lines = []
    for filepath in input_files:
        filename = Path(filepath).name
        lines.append(f"- {filename}: {filepath}")

    return "\n".join(lines)


def build_modeling_prompt(task: Dict, output_dir: str) -> str:
    """Build prompt for a data modeling task."""
    input_section = format_input_files_section(task["input_files"])

    return MODELING_PROMPT_TEMPLATE.format(
        description=task["description"],
        input_files_section=input_section,
        output_dir=output_dir,
    )


# =============================================================================
# Data Loading - Data Analysis (ModelOff)
# =============================================================================

def ensure_analysis_data_extracted() -> bool:
    """Ensure data_old.zip is extracted for data analysis tasks."""
    zip_file = DATA_ANALYSIS_DIR / "data_old.zip"
    extract_dir = DATA_ANALYSIS_DIR / "data"
    marker_file = DATA_ANALYSIS_DIR / ".data_extracted"

    if marker_file.exists():
        return True

    if not zip_file.exists():
        print(f"[DSBench] Warning: {zip_file} not found")
        return False

    print(f"[DSBench] Extracting {zip_file}...")
    try:
        with zipfile.ZipFile(zip_file, 'r') as zf:
            zf.extractall(DATA_ANALYSIS_DIR)
        marker_file.write_text(f"Extracted: {datetime.now().isoformat()}\n")
        print(f"[DSBench] Extracted to: {extract_dir}")
        return True
    except Exception as e:
        print(f"[DSBench] Error extracting: {e}")
        return False


def load_analysis_tasks(
    max_tasks: Optional[int] = None,
    task_ids: Optional[List[str]] = None,
) -> List[Dict]:
    """Load data analysis (ModelOff) tasks from data_analysis/data.json.

    Each challenge has multiple questions. Each question becomes a separate task.
    Task ID format: {challenge_id}_{question_name} (e.g., "00000001_question6")
    """
    tasks = []
    data_json = DATA_ANALYSIS_DIR / "data.json"

    if not data_json.exists():
        print(f"[DSBench] Warning: {data_json} not found")
        return tasks

    # Ensure data is extracted
    if not ensure_analysis_data_extracted():
        return tasks

    data_dir = DATA_ANALYSIS_DIR / "data"

    # Load challenge metadata
    with open(data_json) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                challenge = json.loads(line)
            except json.JSONDecodeError:
                continue

            challenge_id = challenge.get("id", "")
            challenge_name = challenge.get("name", "")
            questions = challenge.get("questions", [])
            answers = challenge.get("answers", [])

            if not challenge_id or not questions:
                continue

            # Check if challenge data directory exists
            challenge_dir = data_dir / challenge_id
            if not challenge_dir.exists():
                continue

            # Find data file (Excel workbook)
            data_files = list(challenge_dir.glob("*.xlsx")) + list(challenge_dir.glob("*.xls"))
            data_file = str(data_files[0].absolute()) if data_files else None

            # Create a task for each question
            for i, question_name in enumerate(questions):
                task_id = f"{challenge_id}_{question_name}"

                # Filter by task_ids if specified
                if task_ids:
                    # Allow matching by full task_id or just challenge_id
                    if task_id not in task_ids and challenge_id not in task_ids:
                        continue

                # Load question text
                question_file = challenge_dir / f"{question_name}.txt"
                if not question_file.exists():
                    continue

                with open(question_file) as qf:
                    question_text = qf.read()

                # Get answer
                answer = answers[i] if i < len(answers) else None

                tasks.append({
                    "task_id": task_id,
                    "task_type": TASK_TYPE_ANALYSIS,
                    "challenge_id": challenge_id,
                    "challenge_name": challenge_name,
                    "question_name": question_name,
                    "question": question_text,
                    "answer": answer,
                    "data_file": data_file,
                    "url": challenge.get("url", ""),
                    "year": challenge.get("year", ""),
                })

                if max_tasks and len(tasks) >= max_tasks:
                    return tasks

    return tasks


def build_analysis_prompt(task: Dict, output_dir: str) -> str:
    """Build prompt for a data analysis task."""
    return ANALYSIS_PROMPT_TEMPLATE.format(
        data_file=task.get("data_file", "No data file available"),
        question=task["question"],
        output_dir=output_dir,
    )


# =============================================================================
# Unified Task Loading
# =============================================================================

def load_tasks(
    task_type: str = "all",
    max_tasks: Optional[int] = None,
    task_ids: Optional[List[str]] = None,
) -> List[Dict]:
    """Load tasks based on task type.

    Args:
        task_type: "modeling", "analysis", or "all"
        max_tasks: Limit number of tasks
        task_ids: Specific task IDs to load
    """
    tasks = []

    if task_type in ["modeling", "all"]:
        modeling_limit = max_tasks if task_type == "modeling" else None
        modeling_tasks = load_modeling_tasks(modeling_limit, task_ids)
        tasks.extend(modeling_tasks)

    if task_type in ["analysis", "all"]:
        remaining = max_tasks - len(tasks) if max_tasks else None
        analysis_limit = remaining if task_type == "all" and remaining else (max_tasks if task_type == "analysis" else None)
        analysis_tasks = load_analysis_tasks(analysis_limit, task_ids)
        tasks.extend(analysis_tasks)

    # Apply global limit if needed
    if max_tasks and len(tasks) > max_tasks:
        tasks = tasks[:max_tasks]

    return tasks


def build_task_prompt(task: Dict, output_dir: str) -> str:
    """Build prompt for any task type."""
    if task["task_type"] == TASK_TYPE_MODELING:
        return build_modeling_prompt(task, output_dir)
    elif task["task_type"] == TASK_TYPE_ANALYSIS:
        return build_analysis_prompt(task, output_dir)
    else:
        raise ValueError(f"Unknown task type: {task['task_type']}")


# =============================================================================
# Run Directory Management
# =============================================================================

def create_run_dir(task_type: str = "modeling") -> Path:
    """Create a new run directory."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_name = f"{timestamp}_{task_type}"
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
    # Sanitize task_id for directory name (replace / with _)
    safe_task_id = task_id.replace("/", "_")
    task_dir = run_dir / f"task_{safe_task_id}"
    task_dir.mkdir(parents=True, exist_ok=True)
    result_file = task_dir / "result.json"
    with open(result_file, 'w') as f:
        json.dump(result, f, indent=2)


# =============================================================================
# Task Runner
# =============================================================================

def run_task(
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
    safe_task_id = task_id.replace("/", "_")
    task_dir = run_dir / f"task_{safe_task_id}"
    task_dir.mkdir(parents=True, exist_ok=True)

    # Build prompt with absolute output directory path
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
        workflow_name=f"DSBench-{safe_task_id}",
        agent_name=f"dsbench-{safe_task_id}",
    )

    start = time.time()
    result = {
        "task_id": task_id,
        "task_type": task["task_type"],
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
    trace_files = {"prompt.txt", "response.txt", "result.json", "trace.json", "workflow.json", "task.json"}
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
    # Save task metadata
    with open(task_dir / "task.json", 'w') as f:
        # Make a copy without non-serializable items
        task_copy = {k: v for k, v in task.items() if k != "answer" or not callable(v)}
        json.dump(task_copy, f, indent=2, default=str)

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

    print(f"\n[DSBench] Running {len(tasks_to_run)} tasks")
    if skipped:
        print(f"[DSBench] Skipping {skipped} already completed tasks")

    results = []
    for i, task in enumerate(tasks_to_run):
        task_num = skipped + i + 1
        task_desc = task.get("description", task.get("question", ""))[:60]
        _log(f"\n[{task_num}/{total}] Task {task['task_id']}: {task_desc}...")
        result = run_task(task, run_dir, **agent_kwargs)
        results.append(result)

        status = "ERROR" if result.get("error") else "OK"
        _log(f"  Status: {status} ({result['elapsed']:.1f}s)")

    return results


def cleanup_agents():
    """Delete all existing agents."""
    try:
        agents = list_all_agents(TEXERA_AGENT_SERVICE_ENDPOINT)
        if agents:
            print(f"[DSBench] Cleaning up {len(agents)} agents...")
            delete_all_agents(TEXERA_AGENT_SERVICE_ENDPOINT)
    except Exception as e:
        print(f"[DSBench] Cleanup failed: {e}")


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
# Evaluation - Data Modeling
# =============================================================================

def evaluate_modeling_task(task_id: str, task_dir: Path) -> Dict:
    """Evaluate a data modeling task using its eval script."""
    eval_script = DATA_MODELING_DIR / "evaluation" / f"{task_id}_eval.py"
    answer_file = DATA_DIR / "answers" / task_id / "test_answer.csv"
    predict_file = task_dir / "submission.csv"

    result = {
        "task_id": task_id,
        "task_type": TASK_TYPE_MODELING,
        "score": None,
        "error": None,
    }

    # Check files exist
    if not eval_script.exists():
        result["error"] = f"No eval script: {eval_script}"
        return result

    if not answer_file.exists():
        result["error"] = f"No answer file: {answer_file}"
        return result

    if not predict_file.exists():
        result["error"] = f"No submission file generated"
        return result

    # Create temp result directory
    result_dir = task_dir / "eval_result"
    result_dir.mkdir(exist_ok=True)

    try:
        # Run evaluation script
        cmd = [
            sys.executable, str(eval_script),
            "--answer_file", str(answer_file),
            "--predict_file", str(predict_file),
            "--path", str(result_dir.parent),
            "--name", result_dir.name,
        ]

        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

        # Read result
        result_txt = result_dir / "result.txt"
        if result_txt.exists():
            score_str = result_txt.read_text().strip()
            try:
                result["score"] = float(score_str)
            except ValueError:
                result["score"] = score_str
        else:
            result["error"] = f"Eval script did not produce result.txt"
            if proc.stderr:
                result["error"] += f": {proc.stderr[:500]}"

    except subprocess.TimeoutExpired:
        result["error"] = "Evaluation timed out"
    except Exception as e:
        result["error"] = str(e)

    return result


# =============================================================================
# Evaluation - Data Analysis (LLM-as-judge)
# =============================================================================

def evaluate_analysis_task(task_id: str, task_dir: Path, use_llm: bool = True) -> Dict:
    """Evaluate a data analysis task.

    If use_llm=True, uses GPT-4o as judge. Otherwise, does exact match.
    """
    result = {
        "task_id": task_id,
        "task_type": TASK_TYPE_ANALYSIS,
        "score": None,
        "predicted": None,
        "expected": None,
        "error": None,
    }

    # Load task metadata to get expected answer
    task_json = task_dir / "task.json"
    if not task_json.exists():
        result["error"] = "No task.json found"
        return result

    with open(task_json) as f:
        task_data = json.load(f)

    expected_answer = task_data.get("answer")
    result["expected"] = str(expected_answer) if expected_answer is not None else None

    # Get predicted answer
    answer_file = task_dir / "answer.txt"
    response_file = task_dir / "response.txt"

    if answer_file.exists():
        predicted = answer_file.read_text().strip()
    elif response_file.exists():
        # Try to extract answer from response
        predicted = response_file.read_text().strip()
        # Take the last line or first short line as the answer
        lines = [l.strip() for l in predicted.split('\n') if l.strip()]
        if lines:
            # Find a line that looks like an answer (short, possibly just a letter or number)
            for line in reversed(lines):
                if len(line) <= 100:
                    predicted = line
                    break
    else:
        result["error"] = "No answer file or response found"
        return result

    result["predicted"] = predicted

    if expected_answer is None:
        result["error"] = "No expected answer in task metadata"
        return result

    # Evaluate
    if use_llm:
        # Use LLM-as-judge
        try:
            score = _llm_judge(task_data.get("question", ""), str(expected_answer), predicted)
            result["score"] = 1.0 if score else 0.0
        except Exception as e:
            result["error"] = f"LLM judge error: {e}"
            # Fall back to exact match
            result["score"] = 1.0 if _normalize_answer(predicted) == _normalize_answer(str(expected_answer)) else 0.0
    else:
        # Exact match (case-insensitive, whitespace-normalized)
        result["score"] = 1.0 if _normalize_answer(predicted) == _normalize_answer(str(expected_answer)) else 0.0

    return result


def _normalize_answer(answer: str) -> str:
    """Normalize answer for comparison."""
    # Remove whitespace, lowercase, remove common punctuation
    return answer.lower().strip().replace(",", "").replace("$", "").replace("%", "")


def _llm_judge(question: str, expected: str, predicted: str) -> bool:
    """Use LLM to judge if predicted answer matches expected."""
    try:
        from openai import OpenAI
        client = OpenAI()

        prompt = f"""Please judge whether the generated answer is right or wrong. We require that the correct answer to the prediction gives a clear answer, not just a calculation process or a disassembly of ideas.

The question is: {question}

The true answer is: {expected}

The predicted answer is: {predicted}

If the predicted answer is right, please output True. Otherwise output False.
Don't output any other text content. You only can output True or False."""

        response = client.chat.completions.create(
            model="gpt-4o-2024-05-13",
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            max_tokens=10,
        )

        result = response.choices[0].message.content.strip().lower()
        return "true" in result

    except Exception as e:
        print(f"[DSBench] LLM judge error: {e}")
        raise


# =============================================================================
# Unified Evaluation
# =============================================================================

def evaluate_task(task_id: str, task_dir: Path, task_type: str = None, use_llm: bool = True) -> Dict:
    """Evaluate a single task based on its type."""
    # Determine task type from task.json if not provided
    if task_type is None:
        task_json = task_dir / "task.json"
        if task_json.exists():
            with open(task_json) as f:
                task_data = json.load(f)
                task_type = task_data.get("task_type", TASK_TYPE_MODELING)
        else:
            task_type = TASK_TYPE_MODELING

    if task_type == TASK_TYPE_MODELING:
        return evaluate_modeling_task(task_id, task_dir)
    elif task_type == TASK_TYPE_ANALYSIS:
        return evaluate_analysis_task(task_id, task_dir, use_llm=use_llm)
    else:
        return {"task_id": task_id, "error": f"Unknown task type: {task_type}"}


def evaluate_run(run_dir: Path, use_llm: bool = True) -> List[Dict]:
    """Evaluate all tasks in a run directory."""
    evaluations = []

    for task_dir in sorted(run_dir.iterdir()):
        if not task_dir.is_dir() or not task_dir.name.startswith("task_"):
            continue

        task_id = task_dir.name.replace("task_", "")
        print(f"  Evaluating {task_id}...", end=" ")

        eval_result = evaluate_task(task_id, task_dir, use_llm=use_llm)
        evaluations.append(eval_result)

        if eval_result.get("error"):
            print(f"ERROR: {eval_result['error']}")
        elif eval_result.get("score") is not None:
            print(f"Score: {eval_result['score']}")
        else:
            print("No score")

    return evaluations


# =============================================================================
# CLI Commands
# =============================================================================

def cmd_list(args):
    """List available tasks."""
    print("=" * 60)
    print("DSBench - Available Tasks")
    print("=" * 60)

    # Count modeling tasks
    modeling_tasks = load_modeling_tasks()
    print(f"\n[Data Modeling] Kaggle ML competitions: {len(modeling_tasks)} tasks")
    if args.verbose and modeling_tasks:
        for task in modeling_tasks[:10]:
            print(f"  - {task['task_id']} ({task['year']})")
        if len(modeling_tasks) > 10:
            print(f"  ... and {len(modeling_tasks) - 10} more")

    # Count analysis tasks
    analysis_tasks = load_analysis_tasks()
    print(f"\n[Data Analysis] ModelOff questions: {len(analysis_tasks)} tasks")
    if args.verbose and analysis_tasks:
        # Group by challenge
        challenges = {}
        for task in analysis_tasks:
            cid = task["challenge_id"]
            if cid not in challenges:
                challenges[cid] = {"name": task["challenge_name"], "count": 0}
            challenges[cid]["count"] += 1

        for cid, info in list(challenges.items())[:10]:
            print(f"  - {cid}: {info['name']} ({info['count']} questions)")
        if len(challenges) > 10:
            print(f"  ... and {len(challenges) - 10} more challenges")

    print(f"\nTotal: {len(modeling_tasks) + len(analysis_tasks)} tasks")
    print("\nTask types (--task-type):")
    print(f"  modeling  - Kaggle ML competitions ({len(modeling_tasks)} tasks)")
    print(f"  analysis  - ModelOff questions ({len(analysis_tasks)} tasks)")
    print(f"  all       - All tasks")


def cmd_run(args):
    """Run a new benchmark."""
    print("=" * 60)
    print("DSBench Benchmark")
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
        print("[DSBench] No tasks found matching criteria")
        sys.exit(1)

    print(f"[DSBench] Loaded {len(tasks)} tasks")

    # Create run directory
    run_dir = create_run_dir(args.task_type)
    print(f"[DSBench] Run directory: {run_dir}")

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
        print(f"[DSBench] Error: Run directory not found: {run_dir}")
        sys.exit(1)

    # Load config
    config = load_run_config(run_dir)
    print("=" * 60)
    print("DSBench Benchmark - Resuming")
    print(f"Run directory: {run_dir}")
    print(f"Task type: {config.get('task_type')} | Model: {config.get('model')}")
    print("=" * 60)

    # Get completed tasks
    completed = get_completed_task_ids(run_dir)
    print(f"[DSBench] Found {len(completed)} completed tasks")

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
        print(f"[DSBench] All {len(tasks)} tasks already completed!")
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
        print(f"[DSBench] Error: Run directory not found: {run_dir}")
        sys.exit(1)

    print("=" * 60)
    print("DSBench - Collect Results")
    print(f"Run directory: {run_dir}")
    print("=" * 60)

    # Collect results
    results = collect_results(run_dir)
    print(f"[DSBench] Collected {len(results)} task results")

    if not results:
        print("[DSBench] No results found!")
        return

    # Write detailed results
    results_file = run_dir / "results.json"
    with open(results_file, 'w') as f:
        json.dump(results, f, indent=2)
    print(f"[DSBench] Results saved to: {results_file}")

    # Summary
    _print_summary(run_dir, results)


def cmd_evaluate(args):
    """Evaluate results using metric functions."""
    run_dir = Path(args.run_dir)
    if not run_dir.exists():
        print(f"[DSBench] Error: Run directory not found: {run_dir}")
        sys.exit(1)

    print("=" * 60)
    print("DSBench - Evaluate Results")
    print(f"Run directory: {run_dir}")
    print(f"Use LLM judge: {not args.no_llm}")
    print("=" * 60)

    print("\n[DSBench] Running evaluations...")
    evaluations = evaluate_run(run_dir, use_llm=not args.no_llm)

    # Save evaluations
    eval_file = run_dir / "evaluations.json"
    with open(eval_file, 'w') as f:
        json.dump(evaluations, f, indent=2)
    print(f"\n[DSBench] Evaluations saved to: {eval_file}")

    # Calculate metrics by task type
    modeling_evals = [e for e in evaluations if e.get("task_type") == TASK_TYPE_MODELING]
    analysis_evals = [e for e in evaluations if e.get("task_type") == TASK_TYPE_ANALYSIS]

    print("\n" + "=" * 60)
    print("Evaluation Summary")
    print("=" * 60)

    if modeling_evals:
        valid = [e for e in modeling_evals if e.get("score") is not None and e.get("error") is None]
        if valid:
            avg_score = sum(e["score"] for e in valid) / len(valid)
            print(f"\n[Data Modeling] {len(valid)}/{len(modeling_evals)} tasks evaluated")
            print(f"  Average score: {avg_score:.4f}")

    if analysis_evals:
        valid = [e for e in analysis_evals if e.get("score") is not None]
        if valid:
            accuracy = sum(e["score"] for e in valid) / len(valid)
            print(f"\n[Data Analysis] {len(valid)}/{len(analysis_evals)} tasks evaluated")
            print(f"  Accuracy: {accuracy:.2%}")


def _print_summary(run_dir: Path, results: List[Dict] = None, total_time: float = None):
    """Print run summary."""
    if results is None:
        results = collect_results(run_dir)

    print("\n" + "=" * 60)
    print(f"Run directory: {run_dir}")
    print(f"Completed: {len(results)} tasks")

    # Count by type
    modeling_count = sum(1 for r in results if r.get("task_type") == TASK_TYPE_MODELING)
    analysis_count = sum(1 for r in results if r.get("task_type") == TASK_TYPE_ANALYSIS)
    if modeling_count:
        print(f"  - Data Modeling: {modeling_count}")
    if analysis_count:
        print(f"  - Data Analysis: {analysis_count}")

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
        description="DSBench Benchmark Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # List available tasks
  python -m benchmarks.dsbench list
  python -m benchmarks.dsbench list -v

  # Run data modeling tasks (Kaggle)
  python -m benchmarks.dsbench run --task-type modeling --max-tasks 5

  # Run data analysis tasks (ModelOff)
  python -m benchmarks.dsbench run --task-type analysis --max-tasks 5

  # Run specific task by ID
  python -m benchmarks.dsbench run --task-ids titanic

  # Resume an interrupted run
  python -m benchmarks.dsbench resume runs/dsbench/20260105_120000_modeling

  # Collect and evaluate results
  python -m benchmarks.dsbench collect runs/dsbench/20260105_120000_modeling
  python -m benchmarks.dsbench evaluate runs/dsbench/20260105_120000_modeling
        """
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # === list command ===
    list_parser = subparsers.add_parser("list", help="List available tasks")
    list_parser.add_argument("-v", "--verbose", action="store_true", help="Show task details")

    # === run command ===
    run_parser = subparsers.add_parser("run", help="Start a new benchmark run")
    run_parser.add_argument("--task-type", default="modeling",
                           choices=["modeling", "analysis", "all"],
                           help="Type of tasks: modeling (Kaggle), analysis (ModelOff), or all")
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
    eval_parser = subparsers.add_parser("evaluate", help="Evaluate results")
    eval_parser.add_argument("run_dir", help="Path to run directory")
    eval_parser.add_argument("--no-llm", action="store_true",
                            help="Don't use LLM judge for analysis tasks (use exact match)")

    args = parser.parse_args()

    if args.command == "list":
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
