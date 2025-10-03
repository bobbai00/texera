.PHONY: help install dev test run clean format lint

help:  ## Show this help message
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

install:  ## Install production dependencies
	uv venv
	uv pip install -e .

dev:  ## Install development dependencies
	uv venv
	uv pip install -e ".[dev]"

test:  ## Run tests
	uv run pytest tests/ -v

coverage:  ## Run tests with coverage
	uv run pytest --cov=agent --cov-report=html --cov-report=term tests/

format:  ## Format code with ruff
	uv run ruff format .

lint:  ## Run linting checks
	uv run ruff check .
	uv run ruff format --check .
	uv run mypy src/

run:  ## Run the agent service
	uv run python src/main.py --reload

run-prod:  ## Run the agent service in production mode
	uv run uvicorn agent.api:app --host 0.0.0.0 --port 8090

clean:  ## Clean up generated files
	rm -rf .venv/
	rm -rf .pytest_cache/
	rm -rf .coverage
	rm -rf htmlcov/
	rm -rf .mypy_cache/
	rm -rf .ruff_cache/
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete