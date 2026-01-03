# -*- coding: utf-8 -*-
"""
Benchmarks package for Texera Agent Service.

This package contains benchmark implementations:
- dabstep: DABstep benchmark runner for data analysis tasks
- spider_2_dbt: Spider2-DBT benchmark runner for DuckDB data transformation
"""

# DABstep benchmark exports
from .dabstep import (
    run_benchmark as dabstep_run_benchmark,
    run_dataflow_task as dabstep_run_single_task,
    run_baseline_task as dabstep_run_baseline_single_task,
    download_context_files as dabstep_download_context_files,
    load_dataset as dabstep_load_dataset,
    cleanup_agents as dabstep_cleanup_agents,
    extract_answer as dabstep_extract_answer,
    collect_results as dabstep_collect_results,
    write_submission_jsonl as dabstep_write_submission_jsonl,
    evaluate_results as dabstep_evaluate_results,
    create_run_dir as dabstep_create_run_dir,
    get_completed_task_ids as dabstep_get_completed_task_ids,
    CONTEXT_FILENAMES as DABSTEP_CONTEXT_FILENAMES,
    DATA_DIR as DABSTEP_DATA_DIR,
    RUNS_DIR as DABSTEP_RUNS_DIR,
    PROMPT as DABSTEP_PROMPT,
    BASELINE_PROMPT as DABSTEP_BASELINE_PROMPT,
)

# Spider2-DBT benchmark exports
from .spider_2_dbt import (
    run_benchmark as spider2_run_benchmark,
    run_baseline_benchmark as spider2_run_baseline_benchmark,
    run_single_task as spider2_run_single_task,
    run_baseline_single_task as spider2_run_baseline_single_task,
    setup_spider2_dbt,
    load_tasks as spider2_load_tasks,
    compare_tables,
    compare_duckdb,
    cleanup_existing_agents as spider2_cleanup_agents,
    DATA_DIR as SPIDER2_DATA_DIR,
    RUNS_DIR as SPIDER2_RUNS_DIR,
    PROMPT as SPIDER2_PROMPT,
    BASELINE_PROMPT as SPIDER2_BASELINE_PROMPT,
)

__all__ = [
    # DABstep benchmark
    "dabstep_run_benchmark",
    "dabstep_run_single_task",
    "dabstep_run_baseline_single_task",
    "dabstep_download_context_files",
    "dabstep_load_dataset",
    "dabstep_cleanup_agents",
    "dabstep_extract_answer",
    "dabstep_collect_results",
    "dabstep_write_submission_jsonl",
    "dabstep_evaluate_results",
    "dabstep_create_run_dir",
    "dabstep_get_completed_task_ids",
    "DABSTEP_CONTEXT_FILENAMES",
    "DABSTEP_DATA_DIR",
    "DABSTEP_RUNS_DIR",
    "DABSTEP_PROMPT",
    "DABSTEP_BASELINE_PROMPT",
    # Spider2-DBT benchmark
    "spider2_run_benchmark",
    "spider2_run_baseline_benchmark",
    "spider2_run_single_task",
    "spider2_run_baseline_single_task",
    "setup_spider2_dbt",
    "spider2_load_tasks",
    "compare_tables",
    "compare_duckdb",
    "spider2_cleanup_agents",
    "SPIDER2_DATA_DIR",
    "SPIDER2_RUNS_DIR",
    "SPIDER2_PROMPT",
    "SPIDER2_BASELINE_PROMPT",
]
