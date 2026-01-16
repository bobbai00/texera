# -*- coding: utf-8 -*-
"""
DABstep utility functions for retrieving submissions and task scores.

Functions for querying the DABstep leaderboard submissions from HuggingFace.
"""

from typing import Optional, Dict, Any, List
import datasets
import pandas as pd


# Default HuggingFace repository for DABstep dataset
# Can be overridden if needed (e.g., "justinlangsethgenesis/DABstep-temp")
DABSTEP_REPO_ID = "adyen/DABstep"


def get_submission(
    agent_name: str,
    organisation: str,
    repo_id: str = DABSTEP_REPO_ID,
) -> pd.DataFrame:
    """
    Retrieve a specific submission from the DABstep leaderboard.

    Args:
        agent_name: The agent name given in the submission form
        organisation: The organization name given in the submission form
        repo_id: HuggingFace dataset repository ID

    Returns:
        DataFrame containing the submission data filtered by submission_id
    """
    submission_id = f"{organisation}-{agent_name}"

    submissions_dataset = datasets.load_dataset(
        repo_id, name="submissions", split="default"
    )

    submissions_df = submissions_dataset.filter(
        lambda row: row["submission_id"] == submission_id
    ).to_pandas()

    return submissions_df


def get_task_scores(
    agent_name: str,
    organisation: str,
    repo_id: str = DABSTEP_REPO_ID,
) -> pd.DataFrame:
    """
    Retrieve task-level scores for a specific submission.

    Args:
        agent_name: The agent name given in the submission form
        organisation: The organization name given in the submission form
        repo_id: HuggingFace dataset repository ID

    Returns:
        DataFrame containing per-task scores for the submission
    """
    submission_id = f"{organisation}-{agent_name}"

    task_scores_dataset = datasets.load_dataset(
        repo_id, name="task_scores", split="default"
    )

    task_scores_df = task_scores_dataset.filter(
        lambda row: row["submission_id"] == submission_id
    ).to_pandas()

    return task_scores_df


def list_submissions(
    repo_id: str = DABSTEP_REPO_ID,
    organisation: Optional[str] = None,
    unique_only: bool = True,
) -> pd.DataFrame:
    """
    List all submissions in the DABstep leaderboard.

    Args:
        repo_id: HuggingFace dataset repository ID
        organisation: Optional filter by organization name
        unique_only: If True, return only unique submissions (deduped by submission_id)

    Returns:
        DataFrame containing all submissions (or filtered by organization)
    """
    submissions_dataset = datasets.load_dataset(
        repo_id, name="submissions", split="default"
    )

    submissions_df = submissions_dataset.to_pandas()

    if organisation:
        # Filter by organisation prefix in submission_id
        submissions_df = submissions_df[
            submissions_df["submission_id"].str.startswith(f"{organisation}-")
        ]

    if unique_only:
        # Get unique submissions by dropping duplicates on submission_id
        # Keep first occurrence with relevant columns
        keep_cols = ['submission_id', 'agent_name', 'model_family', 'organisation', 'date', 'validated']
        available_cols = [c for c in keep_cols if c in submissions_df.columns]
        submissions_df = submissions_df.drop_duplicates(subset=['submission_id'])[available_cols]

    return submissions_df


def get_submission_details(
    agent_name: str,
    organisation: str,
    repo_id: str = DABSTEP_REPO_ID,
) -> Dict[str, Any]:
    """
    Get full submission details including both submission info and task scores.

    Args:
        agent_name: The agent name given in the submission form
        organisation: The organization name given in the submission form
        repo_id: HuggingFace dataset repository ID

    Returns:
        Dictionary containing:
        - submission_id: The combined submission identifier
        - submission: DataFrame with submission metadata
        - task_scores: DataFrame with per-task scores
        - summary: Dict with aggregated statistics
    """
    submission_id = f"{organisation}-{agent_name}"

    submission_df = get_submission(agent_name, organisation, repo_id)
    task_scores_df = get_task_scores(agent_name, organisation, repo_id)

    # Calculate summary statistics
    summary = {}
    if not task_scores_df.empty and "score" in task_scores_df.columns:
        scores = task_scores_df["score"]
        summary = {
            "total_tasks": len(scores),
            "correct": int(scores.sum()),
            "accuracy": float(scores.mean()),
        }

    return {
        "submission_id": submission_id,
        "submission": submission_df,
        "task_scores": task_scores_df,
        "summary": summary,
    }
