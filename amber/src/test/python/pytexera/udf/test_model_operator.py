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

import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import joblib
import numpy
import pandas
import pytest
from sklearn.linear_model import LogisticRegression

from core.architecture.managers.executor_manager import ExecutorManager
from core.models import Batch, Table
from pytexera import ModelTableOperator
from pytexera.udf.model_operator import fetch, load, predict

COHORT = pandas.DataFrame(
    {
        "patient_id": ["P-1", "P-2", "P-3", "P-4", "P-5", "P-6"],
        "Glucose": [85.0, 168.0, 183.0, 89.0, 137.0, 116.0],
        "BMI": [26.6, 43.1, 23.3, 28.1, 43.1, 25.6],
        "Outcome": [0, 1, 1, 0, 1, 0],
    }
)
INPUTS = [["Glucose", "double"], ["BMI", "double"]]
OUTPUTS = [["predicted", "long"], ["risk", "double"]]


def generated(
    base: str, model: str, framework: str, entry: str, files, inputs, outputs, keys=()
):
    """The module the engine runs for predict, as the engine writes it."""
    lit = json.dumps
    return (
        "from pytexera import *\n"
        f"from pytexera import {base}\n\n\n"
        f"class ProcessModelOperator({base}):\n"
        f"    model = {lit(model)}\n"
        f"    framework = {lit(framework)}\n"
        f"    entry = {lit(entry)}\n"
        f"    files = __import__('json').loads({lit(lit(files))})\n"
        f"    inputs = __import__('json').loads({lit(lit(inputs))})\n"
        f"    outputs = __import__('json').loads({lit(lit(outputs))})\n"
        f"    keys = __import__('json').loads({lit(lit(list(keys)))})\n"
    )


@pytest.fixture
def fitted(tmp_path):
    """A logistic regression fitted on the cohort, saved as a model version's file."""
    estimator = LogisticRegression().fit(COHORT[["Glucose", "BMI"]], COHORT["Outcome"])
    path = tmp_path / "model.joblib"
    joblib.dump(estimator, path)
    return estimator, {"model.joblib": path.as_uri()}


def unique_model() -> str:
    return f"texera://models/{uuid.uuid4()}@1"


class TestModelOperator:
    def test_an_sklearn_version_adds_its_prediction_and_risk_to_every_row(self, fitted):
        estimator, files = fitted
        manager = ExecutorManager()
        try:
            cls = manager.load_executor_definition(
                generated(
                    "ModelBatchOperator",
                    unique_model(),
                    "sklearn",
                    "model.joblib",
                    files,
                    INPUTS,
                    OUTPUTS,
                )
            )
        finally:
            manager.close()
        operator = cls()
        operator.open()
        [out] = list(operator.process_batch(Batch(COHORT), 0))
        assert list(out.columns) == [
            "patient_id",
            "Glucose",
            "BMI",
            "Outcome",
            "predicted",
            "risk",
        ]
        features = COHORT[["Glucose", "BMI"]]
        assert out["predicted"].tolist() == estimator.predict(features).tolist()
        assert numpy.allclose(out["risk"], estimator.predict_proba(features)[:, 1])

    def test_a_python_version_is_its_entrys_load_and_predict(self, tmp_path):
        (tmp_path / "predict.py").write_text(
            "import json, os\n"
            "def load(directory):\n"
            "    return json.load(open(os.path.join(directory, 'weights.json')))\n"
            "def predict(model, frame):\n"
            "    return frame['Glucose'] * model['slope']\n"
        )
        (tmp_path / "weights.json").write_text('{"slope": 0.5}')
        files = {p: (tmp_path / p).as_uri() for p in ("predict.py", "weights.json")}
        loaded = load("python", fetch(unique_model(), files), "predict.py")
        out = predict(loaded, COHORT[["Glucose"]], [["half", "double"]])
        assert out["half"].tolist() == [42.5, 84.0, 91.5, 44.5, 68.5, 58.0]

    def test_a_grouped_version_puts_out_a_row_per_group_on_its_keys(self, tmp_path):
        (tmp_path / "predict.py").write_text(
            "def load(directory):\n"
            "    return None\n"
            "def predict(model, frame):\n"
            "    return frame.groupby('patient_id', as_index=False)['Glucose'].min()"
            ".rename(columns={'Glucose': 'predicted_min'})\n"
        )
        readings = pandas.concat([COHORT, COHORT.assign(Glucose=COHORT.Glucose - 10)])

        class Forecaster(ModelTableOperator):
            model = unique_model()
            framework = "python"
            entry = "predict.py"
            files = {"predict.py": (tmp_path / "predict.py").as_uri()}
            inputs = [["Glucose", "double"]]
            outputs = [["predicted_min", "double"]]
            keys = ["patient_id"]

        operator = Forecaster()
        operator.open()
        [out] = [x for x in operator.process_table(Table(readings), 0) if x is not None]
        assert list(out.columns) == ["patient_id", "predicted_min"]
        assert out["predicted_min"].tolist() == (COHORT.Glucose - 10).tolist()
        assert [
            x for x in Forecaster().process_table(Table(readings.iloc[0:0]), 0)
        ] == [None]

    def test_what_a_version_cannot_do_is_said(self, tmp_path, fitted):
        (tmp_path / "predict.py").write_text("def load(directory):\n    return 1\n")
        files = {"predict.py": (tmp_path / "predict.py").as_uri()}
        with pytest.raises(TypeError, match="predict.py defines no predict"):
            load("python", fetch(unique_model(), files), "predict.py")
        with pytest.raises(
            ValueError, match="onnx is not a framework this engine loads"
        ):
            load("onnx", str(tmp_path), "model.onnx")
        _, sk_files = fitted
        loaded = load("sklearn", fetch(unique_model(), sk_files), "model.joblib")
        with pytest.raises(ValueError, match="one or two outputs"):
            predict(loaded, COHORT[["Glucose", "BMI"]], OUTPUTS + [["third", "double"]])

    def test_workers_fetching_at_once_end_with_one_whole_copy(self, fitted):
        _, files = fitted
        model = unique_model()
        with ThreadPoolExecutor(max_workers=6) as pool:
            places = list(pool.map(lambda _: fetch(model, files), range(6)))
        assert len(set(places)) == 1
        assert sorted(os.listdir(places[0])) == [".fetched", "model.joblib"]
        assert not [
            p
            for p in os.listdir(os.path.dirname(places[0]))
            if p.startswith(".fetching-")
        ]

    def test_a_version_is_fetched_once_per_process(self, fitted, tmp_path):
        _, files = fitted
        model = unique_model()
        first = fetch(model, files)
        os.remove(files["model.joblib"].removeprefix("file://"))
        assert fetch(model, files) == first
        assert os.path.exists(os.path.join(first, "model.joblib"))
