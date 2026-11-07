# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""A model version run on rows: what the engine's predict operator does on a Python worker.

A model version is files with a contract: how it is loaded and called (its framework and its
entry file), the columns it reads in order, and the columns it adds. Each worker fetches the
version's files once, loads the model once, and calls it on the rows it gets: a batch at a
time, adding the outputs to each row; or, for a model that reads whole groups such as one
patient's readings, once on its share of the groups, putting out a row per what it returns.
"""

import hashlib
import importlib.util
import os
import tempfile
import urllib.request
from abc import ABC, abstractmethod
from typing import Any, Dict, Iterator, List, Optional

import pandas

from core.models import Batch, BatchLike, Table, TableLike
from .function_operator import conform
from .udf_operator import UDFBatchOperator, UDFTableOperator


def fetch(model: str, files: Dict[str, str]) -> str:
    """
    The directory a model version's files are in, fetched once per process: each file's URL
    is the catalog's, presigned for this run.
    """
    root = os.path.join(
        tempfile.gettempdir(),
        "texera-models",
        hashlib.sha256(model.encode()).hexdigest()[:24],
    )
    done = os.path.join(root, ".fetched")
    if os.path.exists(done):
        return root
    for path, url in files.items():
        target = os.path.join(root, *path.split("/"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with (
            urllib.request.urlopen(url) as response,
            open(target + ".part", "wb") as out,
        ):
            while chunk := response.read(1 << 20):
                out.write(chunk)
        os.replace(target + ".part", target)
    with open(done, "w") as marker:
        marker.write(model)
    return root


class Loaded:
    """A model as its framework loaded it, and how to call it."""

    def __init__(self, framework: str, model: Any, module: Any = None):
        self.framework = framework
        self.model = model
        self.module = module


def load(framework: str, directory: str, entry: str) -> Loaded:
    """Loads a model version from its directory by its framework."""
    path = os.path.join(directory, *entry.split("/"))
    if framework == "sklearn":
        import joblib

        return Loaded(framework, joblib.load(path))
    if framework == "python":
        spec = importlib.util.spec_from_file_location(
            "texera_model_" + hashlib.sha256(path.encode()).hexdigest()[:12], path
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for needed in ("load", "predict"):
            if not callable(getattr(module, needed, None)):
                raise TypeError(
                    f"{entry} defines no {needed}(...): a python model's entry defines "
                    "load(directory) and predict(model, frame)"
                )
        return Loaded(framework, module.load(directory), module)
    raise ValueError(
        f"{framework} is not a framework this engine loads: sklearn or python"
    )


def predict(
    loaded: Loaded, frame: pandas.DataFrame, outputs: List[List[str]]
) -> pandas.DataFrame:
    """
    What the model says of the rows: for sklearn, what predict gives and, for a second output,
    the probability of the last class; for python, the frame its predict returns.
    """
    names = [name for name, _ in outputs]
    if loaded.framework == "sklearn":
        if len(names) > 2:
            raise ValueError(
                "an sklearn model's contract names one or two outputs: the prediction, "
                "then the probability of the last class"
            )
        values = {names[0]: loaded.model.predict(frame)}
        if len(names) == 2:
            values[names[1]] = loaded.model.predict_proba(frame)[:, -1]
        return pandas.DataFrame(values, index=frame.index)
    out = loaded.module.predict(loaded.model, frame)
    if isinstance(out, pandas.Series):
        out = out.to_frame(names[0] if len(names) == 1 else out.name)
    return out


class _ModelRunner(ABC):
    """
    What both kinds of model operator share: the version, its contract and its files. The
    class the engine makes for an operator sets them; until then both stay abstract.
    """

    @property
    @abstractmethod
    def model(self) -> str:
        """The model version, as its URI with @version."""

    framework: str = "sklearn"
    entry: str = ""
    files: Dict[str, str] = {}
    inputs: List[List[str]] = []
    outputs: List[List[str]] = []
    keys: List[str] = []

    def _loaded(self) -> Loaded:
        if "_model_loaded" not in self.__dict__:
            self._model_loaded = load(
                self.framework, fetch(self.model, self.files), self.entry
            )
        return self._model_loaded

    def _features(self, frame: pandas.DataFrame) -> pandas.DataFrame:
        return frame[[name for name, _ in self.inputs]]


class ModelBatchOperator(_ModelRunner, UDFBatchOperator):
    """Runs a model on each batch of rows, adding its outputs to every row."""

    BATCH_SIZE = 1024

    def open(self) -> None:
        self._loaded()

    def process_batch(self, batch: Batch, port: int) -> Iterator[Optional[BatchLike]]:
        frame = pandas.DataFrame(batch)
        said = conform(
            self.model,
            predict(self._loaded(), self._features(frame), self.outputs),
            self.outputs,
        )
        for name, _ in self.outputs:
            frame[name] = said[name].values
        yield frame


class ModelTableOperator(_ModelRunner, UDFTableOperator):
    """Runs a model that reads whole groups on a worker's share of them, once."""

    def open(self) -> None:
        self._loaded()

    def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:
        frame = pandas.DataFrame(table)
        if frame.empty:
            yield None
            return
        reads = self.keys + [n for n, _ in self.inputs if n not in self.keys]
        said = predict(self._loaded(), frame[reads], self.outputs)
        # A row per what it returns: the group's keys as they were, then its outputs.
        yield conform(
            self.model, said, [[key, "key"] for key in self.keys] + self.outputs
        )
