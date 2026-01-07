# -*- coding: utf-8 -*-
"""
Workflow Analyzer for Texera Workflows

Analyzes workflow DAG structure including:
- Operator counts by type
- Link counts
- DAG properties (sources, sinks, chains, components)
- Shape classification (dot, chain, tree, DAG)
"""

from dataclasses import dataclass, field
from typing import Dict, List, Set, Tuple, Optional, Any
from collections import defaultdict


@dataclass
class WorkflowMetrics:
    """Metrics for a single workflow."""
    # Basic counts
    num_operators: int = 0
    num_links: int = 0
    operator_counts: Dict[str, int] = field(default_factory=dict)

    # DAG structure
    num_sources: int = 0  # Operators with no incoming edges
    num_sinks: int = 0    # Operators with no outgoing edges
    num_isolated: int = 0  # Operators with no edges at all

    # Component analysis
    num_components: int = 0  # Number of weakly connected components
    component_sizes: List[int] = field(default_factory=list)

    # Chain analysis
    num_chains: int = 0  # Number of linear chain paths
    chain_lengths: List[int] = field(default_factory=list)
    max_chain_length: int = 0
    avg_chain_length: float = 0.0

    # Depth analysis
    max_depth: int = 0  # Longest path from any source to any sink
    avg_depth: float = 0.0

    # Branching analysis
    max_in_degree: int = 0
    max_out_degree: int = 0
    avg_in_degree: float = 0.0
    avg_out_degree: float = 0.0

    # Shape classification
    shape: str = "empty"  # empty, dot, chain, tree, forest, dag

    # Error info
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "num_operators": self.num_operators,
            "num_links": self.num_links,
            "operator_counts": self.operator_counts,
            "num_sources": self.num_sources,
            "num_sinks": self.num_sinks,
            "num_isolated": self.num_isolated,
            "num_components": self.num_components,
            "component_sizes": self.component_sizes,
            "num_chains": self.num_chains,
            "chain_lengths": self.chain_lengths,
            "max_chain_length": self.max_chain_length,
            "avg_chain_length": self.avg_chain_length,
            "max_depth": self.max_depth,
            "avg_depth": self.avg_depth,
            "max_in_degree": self.max_in_degree,
            "max_out_degree": self.max_out_degree,
            "avg_in_degree": self.avg_in_degree,
            "avg_out_degree": self.avg_out_degree,
            "shape": self.shape,
            "error": self.error,
        }


class WorkflowAnalyzer:
    """Analyzes a Texera workflow JSON structure."""

    def __init__(self, workflow: Dict[str, Any]):
        """
        Initialize with a workflow dictionary.

        Args:
            workflow: Parsed workflow JSON with 'operators' and 'links' keys
        """
        self.workflow = workflow
        self.operators = workflow.get("operators", [])
        self.links = workflow.get("links", [])

        # Build adjacency structures
        self.operator_ids: Set[str] = set()
        self.adj_out: Dict[str, List[str]] = defaultdict(list)  # outgoing edges
        self.adj_in: Dict[str, List[str]] = defaultdict(list)   # incoming edges

        self._build_graph()

    def _build_graph(self):
        """Build adjacency lists from operators and links."""
        # Collect operator IDs
        for op in self.operators:
            op_id = op.get("operatorID", "")
            if op_id:
                self.operator_ids.add(op_id)

        # Build adjacency from links
        for link in self.links:
            source = link.get("source", {}).get("operatorID", "")
            target = link.get("target", {}).get("operatorID", "")
            if source and target:
                self.adj_out[source].append(target)
                self.adj_in[target].append(source)

    def analyze(self) -> WorkflowMetrics:
        """
        Analyze the workflow and return metrics.

        Returns:
            WorkflowMetrics object with all computed metrics
        """
        metrics = WorkflowMetrics()

        try:
            # Basic counts
            metrics.num_operators = len(self.operators)
            metrics.num_links = len(self.links)
            metrics.operator_counts = self._count_operator_types()

            if metrics.num_operators == 0:
                metrics.shape = "empty"
                return metrics

            # Degree analysis
            in_degrees = [len(self.adj_in.get(op_id, [])) for op_id in self.operator_ids]
            out_degrees = [len(self.adj_out.get(op_id, [])) for op_id in self.operator_ids]

            metrics.max_in_degree = max(in_degrees) if in_degrees else 0
            metrics.max_out_degree = max(out_degrees) if out_degrees else 0
            metrics.avg_in_degree = sum(in_degrees) / len(in_degrees) if in_degrees else 0
            metrics.avg_out_degree = sum(out_degrees) / len(out_degrees) if out_degrees else 0

            # Source/sink/isolated analysis
            for op_id in self.operator_ids:
                in_deg = len(self.adj_in.get(op_id, []))
                out_deg = len(self.adj_out.get(op_id, []))
                if in_deg == 0 and out_deg == 0:
                    metrics.num_isolated += 1
                elif in_deg == 0:
                    metrics.num_sources += 1
                elif out_deg == 0:
                    metrics.num_sinks += 1

            # Include isolated nodes as sources (they are entry points)
            metrics.num_sources += metrics.num_isolated

            # Component analysis
            components = self._find_components()
            metrics.num_components = len(components)
            metrics.component_sizes = sorted([len(c) for c in components], reverse=True)

            # Chain analysis
            chains = self._find_chains()
            metrics.num_chains = len(chains)
            metrics.chain_lengths = sorted([len(c) for c in chains], reverse=True)
            metrics.max_chain_length = max(metrics.chain_lengths) if metrics.chain_lengths else 0
            metrics.avg_chain_length = (
                sum(metrics.chain_lengths) / len(metrics.chain_lengths)
                if metrics.chain_lengths else 0
            )

            # Depth analysis (longest path)
            depths = self._compute_depths()
            metrics.max_depth = max(depths.values()) if depths else 0
            metrics.avg_depth = sum(depths.values()) / len(depths) if depths else 0

            # Shape classification
            metrics.shape = self._classify_shape(metrics)

        except Exception as e:
            metrics.error = str(e)

        return metrics

    def _count_operator_types(self) -> Dict[str, int]:
        """Count operators by type."""
        counts = defaultdict(int)
        for op in self.operators:
            op_type = op.get("operatorType", "Unknown")
            counts[op_type] += 1
        return dict(counts)

    def _find_components(self) -> List[Set[str]]:
        """Find weakly connected components using union-find."""
        if not self.operator_ids:
            return []

        # Union-Find
        parent = {op_id: op_id for op_id in self.operator_ids}

        def find(x):
            if parent[x] != x:
                parent[x] = find(parent[x])
            return parent[x]

        def union(x, y):
            px, py = find(x), find(y)
            if px != py:
                parent[px] = py

        # Union connected nodes
        for link in self.links:
            source = link.get("source", {}).get("operatorID", "")
            target = link.get("target", {}).get("operatorID", "")
            if source in self.operator_ids and target in self.operator_ids:
                union(source, target)

        # Group by component
        components_map = defaultdict(set)
        for op_id in self.operator_ids:
            root = find(op_id)
            components_map[root].add(op_id)

        return list(components_map.values())

    def _find_chains(self) -> List[List[str]]:
        """
        Find maximal linear chains in the DAG.
        A chain is a path where each internal node has exactly one input and one output.
        """
        chains = []
        visited = set()

        # Start from sources and isolated nodes
        start_nodes = [
            op_id for op_id in self.operator_ids
            if len(self.adj_in.get(op_id, [])) == 0
        ]

        for start in start_nodes:
            if start in visited:
                continue

            # Follow the chain
            chain = [start]
            visited.add(start)
            current = start

            while True:
                # Get successors
                successors = self.adj_out.get(current, [])

                # Chain continues if exactly one successor with in-degree 1
                if len(successors) == 1:
                    next_node = successors[0]
                    if (next_node not in visited and
                        len(self.adj_in.get(next_node, [])) == 1):
                        chain.append(next_node)
                        visited.add(next_node)
                        current = next_node
                        continue

                break

            if len(chain) > 0:
                chains.append(chain)

        # Also find chains starting from non-source nodes that weren't visited
        for op_id in self.operator_ids:
            if op_id in visited:
                continue

            # This node is part of a more complex structure
            # Just mark it as a single-node chain
            chains.append([op_id])
            visited.add(op_id)

        return chains

    def _compute_depths(self) -> Dict[str, int]:
        """
        Compute the depth (longest path from any source) for each node.
        Uses topological sort with dynamic programming.
        """
        if not self.operator_ids:
            return {}

        # Initialize depths
        depths = {op_id: 0 for op_id in self.operator_ids}

        # Compute in-degrees
        in_degree = {op_id: len(self.adj_in.get(op_id, [])) for op_id in self.operator_ids}

        # Start with sources (in-degree 0)
        queue = [op_id for op_id in self.operator_ids if in_degree[op_id] == 0]

        while queue:
            current = queue.pop(0)
            for neighbor in self.adj_out.get(current, []):
                # Update depth
                depths[neighbor] = max(depths[neighbor], depths[current] + 1)
                # Decrease in-degree
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    queue.append(neighbor)

        return depths

    def _classify_shape(self, metrics: WorkflowMetrics) -> str:
        """
        Classify the overall shape of the workflow DAG.

        Returns one of:
        - "empty": No operators
        - "dot": Single isolated node(s) with no links
        - "chain": Single linear path
        - "tree": Tree structure (one source, no node has multiple parents)
        - "forest": Multiple disconnected trees
        - "dag": General DAG (has nodes with multiple parents)
        """
        if metrics.num_operators == 0:
            return "empty"

        if metrics.num_links == 0:
            return "dot"

        # Check if it's a chain: single component, all nodes have degree <= 1
        if (metrics.num_components == 1 and
            metrics.max_in_degree <= 1 and
            metrics.max_out_degree <= 1):
            return "chain"

        # Check if any node has multiple parents (in-degree > 1)
        has_multiple_parents = metrics.max_in_degree > 1

        if not has_multiple_parents:
            # It's a tree or forest
            if metrics.num_components == 1:
                return "tree"
            else:
                return "forest"

        # General DAG
        return "dag"


def analyze_workflow(workflow: Dict[str, Any]) -> WorkflowMetrics:
    """
    Convenience function to analyze a workflow.

    Args:
        workflow: Parsed workflow JSON

    Returns:
        WorkflowMetrics object
    """
    analyzer = WorkflowAnalyzer(workflow)
    return analyzer.analyze()


def analyze_workflow_file(filepath: str) -> WorkflowMetrics:
    """
    Analyze a workflow from a JSON file.

    Args:
        filepath: Path to workflow.json file

    Returns:
        WorkflowMetrics object
    """
    import json
    with open(filepath) as f:
        workflow = json.load(f)
    return analyze_workflow(workflow)
