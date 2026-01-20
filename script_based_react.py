# -*- coding: utf-8 -*-
"""
Minimal Code Agent with Gradio UI.

Connects to LiteLLM service and launches interactive chat interface.
"""

from smolagents import CodeAgent, GradioUI
from smolagents.models import OpenAIServerModel

# Configuration
OPENAI_API_BASE = "http://localhost:9096/api"
OPENAI_API_KEY = "dummy"
MODEL_TYPE = "o4-mini"

# Authorized imports for code execution
AUTHORIZED_IMPORTS = [
    "numpy",
    "pandas",
    "json",
    "csv",
    "os",
    "glob",
    "re",
    "datetime",
    "collections",
    "math",
    "statistics",
    "openpyxl",
    "lxml",
    "bs4",
    "geopandas",
    "cdflib",
]


def main():
    # Create model connection
    model = OpenAIServerModel(
        model_id=MODEL_TYPE,
        api_base=OPENAI_API_BASE,
        api_key=OPENAI_API_KEY,
    )

    # Create agent
    agent = CodeAgent(
        tools=[],
        model=model,
        additional_authorized_imports=AUTHORIZED_IMPORTS,
        max_steps=50,
        verbosity_level=1,
        executor_kwargs={'additional_functions': {'open': open}}
    )

    # Launch Gradio UI
    print(f"Launching Gradio UI with model: {MODEL_TYPE}")
    gradio_ui = GradioUI(agent, file_upload_folder=None)  # Disable file uploads to avoid bug
    gradio_ui.launch(share=False)


if __name__ == "__main__":
    main()
