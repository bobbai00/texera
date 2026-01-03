# Agent Service Benchmark

Benchmarking client for Texera Agent Service using multiple benchmarks:
- [DABstep benchmark](https://huggingface.co/spaces/adyen/DABstep) - Data analysis questions
- [Spider2-DBT benchmark](https://github.com/xlang-ai/Spider2/tree/main/spider2-dbt) - DuckDB data transformation

## Overview

This benchmark suite tests the Texera Agent Service's ability to:
1. **DABstep**: Answer data analysis questions about payment transaction data
2. **Spider2-DBT**: Complete complex DuckDB data transformation projects requiring SQL generation and code comprehension

## Project Structure

```
agent-service-benchmark/
├── agents/                    # Agent implementations
│   ├── __init__.py
│   ├── dataflow_agent.py     # Texera Agent Service client
│   └── code_agent.py         # Baseline smolagents wrapper
├── benchmarks/               # Benchmark runners
│   ├── __init__.py
│   ├── dabstep.py           # DABstep benchmark runner
│   └── spider_2_dbt.py      # Spider2-DBT benchmark runner
├── runs/                     # Output directory for results
├── pyproject.toml           # Dependencies
└── README.md
```

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

### Quick Start

```bash
# Run all dev tasks (~50 tasks) with default settings
uv run python -m benchmarks.dabstep

# Run specific number of tasks
uv run python -m benchmarks.dabstep --max-tasks 10
```

### Full Command Template

Run the dataflow agent with all configurable parameters:

```bash
uv run python -m benchmarks.dabstep \
      --split dev \
      --max-tasks 10 \
      --model claude-haiku-4.5 \
      --max-steps 50 \
      --max-result-chars 20000 \
      --max-cell-chars 4000 \
      --result-format table \
      --tool-timeout 240 \
      --execution-timeout 4 \
      --agent-mode code \
      --verbosity 1
```

### Command Line Options

#### Dataset Options
| Option | Default | Description |
|--------|---------|-------------|
| `--split` | `dev` | Dataset split: `dev` (~50 tasks) or `default` (~450 tasks) |
| `--max-tasks` | all | Maximum tasks to run (omit for all tasks in split) |
| `--data-dir` | `/tmp/DABstep-data` | Directory for context files |
| `--force-download` | false | Force re-download of context files |
| `--skip-download` | false | Skip downloading (use existing files) |

#### Agent Settings (matches agent-service AgentSettings)
| Option | Default | Description |
|--------|---------|-------------|
| `--model` | `claude-haiku-4.5` | LLM model type |
| `--max-steps` | `50` | Maximum agent steps per task |
| `--max-result-chars` | `20000` | Max characters for operator results (uses symmetric truncation) |
| `--max-cell-chars` | `4000` | Max characters per cell in results |
| `--result-format` | `table` | Result serialization: `json`, `table`, or `toon` |
| `--tool-timeout` | `240` | Tool execution timeout in seconds |
| `--execution-timeout` | `4` | Workflow execution timeout in minutes |
| `--agent-mode` | `code` | Agent mode: `code` or `general` |

#### Execution Options
| Option | Default | Description |
|--------|---------|-------------|
| `--verbosity` | `1` | Logging level: 0=quiet, 1=normal, 2=verbose |
| `-r, --retain` | false | Keep agents/workflows after tasks (for debugging) |
| `--no-cleanup` | false | Skip initial cleanup of existing agents |
| `--allow-all-operators` | false | Allow all operator types (default: relational only) |
| `--parallel` | false | Run tasks in parallel using threads |
| `--max-workers` | `4` | Max parallel workers (only with `--parallel`) |
| `--evaluate` | false | Evaluate results (requires dabstep_benchmark) |
| `--baseline` | false | Run baseline code agent (smolagents) instead |

### Examples

```bash
# Run 10 tasks with verbose output
uv run python -m benchmarks.dabstep --max-tasks 10 --verbosity 2

# Run with a different model and more steps
uv run python -m benchmarks.dabstep --model claude-sonnet-4-5 --max-steps 100

# Run in general mode (uses all operators instead of code operators)
uv run python -m benchmarks.dabstep --agent-mode general

# Run with JSON result format and higher character limits
uv run python -m benchmarks.dabstep --result-format json --max-result-chars 40000 --max-cell-chars 8000

# Run in parallel with 8 workers
uv run python -m benchmarks.dabstep --parallel --max-workers 8

# Run full benchmark with evaluation
uv run python -m benchmarks.dabstep --split default --max-tasks 0 --evaluate

# Skip download and retain agents for debugging
uv run python -m benchmarks.dabstep --skip-download --retain --max-tasks 3

# Run baseline code agent (smolagents) for comparison
uv run python -m benchmarks.dabstep --baseline --max-tasks 10
```

## Output

Results are saved to the `runs/` directory:
- `{timestamp}_task{id}/` - Per-task folder with:
  - `prompt.txt` - Full prompt sent to agent
  - `question.txt` - Original question
  - `answer.txt` - Agent's answer
  - `correct_answer.txt` - Ground truth answer
  - `workflow.json` - Final workflow content
  - `trace.json` - Full reasoning trace
  - `score.txt` - Evaluation score (if evaluated)

## Architecture

### Components

1. **DataflowAgent** (`agents/dataflow_agent.py`)
   - Python client for the Texera Agent Service
   - Handles authentication, workflow creation, and agent interaction
   - Compatible interface with smolagents for benchmark comparison

2. **CodeAgentWrapper** (`agents/code_agent.py`)
   - Baseline agent using smolagents library
   - Used for comparison with the dataflow agent

3. **DABstep Benchmark** (`benchmarks/dabstep.py`)
   - Downloads DABstep context files from HuggingFace
   - Loads benchmark tasks
   - Runs agent on each task and collects results
   - Optionally evaluates results

4. **Spider2-DBT Benchmark** (`benchmarks/spider_2_dbt.py`)
   - Downloads Spider2-DBT data from GitHub/Google Drive
   - Loads 69 DuckDB data transformation tasks
   - Runs agent on complex SQL generation tasks
   - Supports table/DuckDB comparison for evaluation

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

This benchmark allows comparing the two approaches on the same tasks using the `--baseline` flag.

## DABstep Benchmark

- **Dataset**: [adyen/DABstep](https://huggingface.co/datasets/adyen/DABstep)
- **Leaderboard**: [DABstep Space](https://huggingface.co/spaces/adyen/DABstep)
- **Framework**: [smolagents](https://github.com/huggingface/smolagents)

---

## Spider2-DBT Benchmark

Spider2-DBT contains 69 examples of DuckDB data transformation projects. These tasks require models to understand project code, navigate complex SQL environments, and generate sophisticated SQL queries (often exceeding 100 lines).

### Setup Spider2-DBT

```bash
# Download and setup benchmark data (requires gdown)
uv run python -m benchmarks.spider_2_dbt --setup

# Force re-download if needed
uv run python -m benchmarks.spider_2_dbt --setup --force
```

### Running Spider2-DBT

```bash
# Run all tasks with default settings
uv run python -m benchmarks.spider_2_dbt

# Run specific number of tasks
uv run python -m benchmarks.spider_2_dbt --max-tasks 10

# Filter tasks by prefix (e.g., only 'playbook' tasks)
uv run python -m benchmarks.spider_2_dbt --filter playbook

# Run baseline code agent (smolagents)
uv run python -m benchmarks.spider_2_dbt --baseline --max-tasks 5
```

### Spider2-DBT Command Line Options

| Option | Default | Description |
|--------|---------|-------------|
| `--setup` | - | Download and setup benchmark data |
| `--force` | false | Force re-download (with --setup) |
| `--max-tasks` | all | Maximum tasks to run |
| `--filter` | none | Filter tasks by instance_id prefix |
| `--data-dir` | `/tmp/spider2-dbt-data` | Directory for benchmark data |
| `--model` | `claude-haiku-4.5` | LLM model type |
| `--max-steps` | `50` | Maximum agent steps per task |
| `--baseline` | false | Run baseline code agent instead |

### Spider2-DBT Output

Results are saved to `runs/spider2-dbt/`:
- `{timestamp}_{instance_id}/` - Per-task folder with:
  - `prompt.txt` - Full prompt sent to agent
  - `instruction.txt` - Original task instruction
  - `answer.txt` - Agent's answer
  - `workflow.json` - Final workflow content
  - `trace.json` - Full reasoning trace
- `results_metadata.jsonl` - Metadata for evaluation

### Spider2-DBT Reference

- **Repository**: [xlang-ai/Spider2](https://github.com/xlang-ai/Spider2)
- **Benchmark**: [spider2-dbt](https://github.com/xlang-ai/Spider2/tree/main/spider2-dbt)
- **Tasks**: 69 DuckDB data transformation projects

---

## Configuration

Default configuration in `agents/dataflow_agent.py`:
```python
TEXERA_API_ENDPOINT = "http://localhost:8080"
TEXERA_AGENT_SERVICE_ENDPOINT = "http://localhost:3001"
TEXERA_USERNAME = "bob@test.com"
TEXERA_PASSWORD = "123456"

# Agent Settings (matches agent-service DEFAULT_AGENT_SETTINGS)
AGENT_MODEL_TYPE = "claude-haiku-4.5"
AGENT_MAX_STEPS = 50
AGENT_MAX_OPERATOR_RESULT_CHAR_LIMIT = 20000  # 20,000 characters (uses symmetric truncation)
AGENT_MAX_OPERATOR_RESULT_CELL_CHAR_LIMIT = 4000  # 4,000 characters per cell
AGENT_OPERATOR_RESULT_SERIALIZATION_MODE = "table"
AGENT_TOOL_TIMEOUT_SECONDS = 240  # 4 minutes
AGENT_EXECUTION_TIMEOUT_MINUTES = 4
AGENT_MODE = "code"
```

Modify these values to match your environment, or override via CLI arguments.
