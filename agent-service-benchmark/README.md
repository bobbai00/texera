# Agent Service Benchmark

Benchmarking client for Texera Agent Service using the [DABstep benchmark](https://huggingface.co/spaces/adyen/DABstep).

## Overview

This benchmark tests the Texera Agent Service's ability to answer data analysis questions by building and executing dataflow workflows. It uses the DABstep (Data Analysis Benchmark Step) benchmark, which contains questions about payment transaction data.

## Prerequisites

1. **Texera Backend** running on `localhost:8080`
2. **Agent Service** running on `localhost:3001`
3. **Python 3.13+** with uv package manager
4. **HuggingFace account** (for downloading benchmark data)

## Setup

```bash
# Navigate to the benchmark directory
cd agent-service-benchmark

# Install dependencies with uv
uv sync

# Login to HuggingFace (required for dataset download)
huggingface-cli login
```

## Usage

### Quick Start (3 tasks from dev split)

```bash
uv run python main.py
```

### Run More Tasks

```bash
# Run 10 tasks from dev split
uv run python main.py --max-tasks 10

# Run all dev tasks (~50 tasks)
uv run python main.py --max-tasks 0

# Run full benchmark (~450 tasks)
uv run python main.py --split default --max-tasks 0
```

### Command Line Options

```
--split SPLIT         Dataset split: "dev" (small) or "default" (full)
--max-tasks N         Maximum tasks to run (0 for all)
--model MODEL         LLM model type (default: claude-sonnet-4-20250514)
--max-steps N         Max agent steps per task (default: 10)
--data-dir PATH       Directory for context files (default: /tmp/DABstep-data)
--force-download      Force re-download of context files
--skip-download       Skip downloading (use existing files)
--evaluate            Evaluate results using dabstep_benchmark
--verbosity LEVEL     0=quiet, 1=normal, 2=verbose
```

### Examples

```bash
# Run with verbose output
uv run python main.py --verbosity 2

# Run with evaluation
uv run python main.py --evaluate

# Run with a different model
uv run python main.py --model gpt-4-turbo

# Skip download (files already present)
uv run python main.py --skip-download
```

## Output

Results are saved to the `runs/` directory:
- `{timestamp}.jsonl` - Task results in JSONL format
- `{timestamp}.csv` - Task results in CSV format
- `{timestamp}_scores.csv` - Evaluation scores (if --evaluate flag used)

## Architecture

### Components

1. **DataflowAgent** (`dataflow_agent.py`)
   - Python client for the Texera Agent Service
   - Handles authentication, workflow creation, and agent interaction
   - Compatible interface with smolagents for benchmark comparison

2. **Benchmark Runner** (`main.py`)
   - Downloads DABstep context files from HuggingFace
   - Loads benchmark tasks
   - Runs agent on each task and collects results
   - Optionally evaluates results

### How It Works

1. The benchmark downloads context files (CSV, JSON, markdown documentation)
2. For each task:
   - A **new workflow and agent** is created for proper isolation
   - A prompt is created with the question and available files
   - The DataflowAgent sends the prompt to the Agent Service
   - The Agent Service agent builds a workflow to answer the question
   - The workflow is executed and results are returned
   - The **last response content** from the agent's reasoning trace is extracted as the final answer
   - The agent and workflow are cleaned up after each task
3. Results are compared against ground truth for evaluation

## Comparison with smolagents

The original DABstep benchmark uses HuggingFace's smolagents framework:
- smolagents agents execute Python code directly
- Texera agents build dataflow workflows with operators

This benchmark allows comparing the two approaches on the same tasks.

## DABstep Benchmark

- **Dataset**: [adyen/DABstep](https://huggingface.co/datasets/adyen/DABstep)
- **Leaderboard**: [DABstep Space](https://huggingface.co/spaces/adyen/DABstep)
- **Framework**: [smolagents](https://github.com/huggingface/smolagents)

## Configuration

Default configuration in `dataflow_agent.py`:
```python
TEXERA_API_ENDPOINT = "http://localhost:8080"
TEXERA_AGENT_SERVICE_ENDPOINT = "http://localhost:3001"
TEXERA_USERNAME = "bob@test.com"
TEXERA_PASSWORD = "123456"
AGENT_MODEL_TYPE = "claude-sonnet-4-20250514"
AGENT_MAX_STEPS = 10
```

Modify these values to match your environment.
