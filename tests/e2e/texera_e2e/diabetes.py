"""The diabetes team the screening use case meets: a project holding the team's onset-risk model,
fitted on the public Pima cohort the way the example's prepare.py fits it, and two of the team's
Python operators from the example, ROC AUC and Risk calibration. The model is fitted here with
this Python's scikit-learn, the version the platform's profiles pin."""
from __future__ import annotations

import hashlib
import io
import pathlib
import urllib.request

import joblib
import pandas as pd
import sklearn
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from .client import Api

# The Pima Indians Diabetes cohort (NIDDK) as a public CSV with a header row: 768 women.
PIMA_URL = "https://raw.githubusercontent.com/plotly/datasets/master/diabetes.csv"
FEATURES = [("Pregnancies", "integer"), ("Glucose", "integer"), ("BloodPressure", "integer"),
            ("BMI", "double"), ("DiabetesPedigreeFunction", "double"), ("Age", "integer")]
OPERATORS = pathlib.Path(__file__).resolve().parents[3] / "bin" / "texera-2-0" / "examples" / "diabetes" / "operators"

CARD = """# Diabetes onset risk

A logistic regression for diabetes diagnosed within five years, fitted with scikit-learn
{sklearn} on all {n} women of the Pima Indians Diabetes cohort (NIDDK; Smith et al. 1988), the
public file at {url}. A 0 in Glucose, BloodPressure or BMI is a measurement not taken: it is
replaced by the median of the fitted women. The features are then standardized.

On the women it was fitted on: AUC {auc}. Scored on the same cohort, that is an optimistic
estimate; a new cohort tells how it holds up.

predict reads Pregnancies, Glucose, BloodPressure, BMI, DiabetesPedigreeFunction and Age, and
adds `predicted`, 1 for diabetes within five years, and `risk`, its probability.
"""

_bytes: dict[str, bytes] = {}


def pima_bytes() -> bytes:
    """The public file, fetched once per run."""
    if PIMA_URL not in _bytes:
        with urllib.request.urlopen(PIMA_URL, timeout=120) as r:
            _bytes[PIMA_URL] = r.read()
    return _bytes[PIMA_URL]


def pima_digest() -> str:
    return "sha256:" + hashlib.sha256(pima_bytes()).hexdigest()


def onset_model(api: Api, project: str) -> str:
    """The team's onset-risk model, version 1 with its contract and its card; returns its URI."""
    cohort = pd.read_csv(io.BytesIO(pima_bytes()))
    names = [n for n, _ in FEATURES]
    prepare = ColumnTransformer([
        ("zero_is_missing", SimpleImputer(missing_values=0, strategy="median"), ["Glucose", "BloodPressure", "BMI"]),
        ("as_is", "passthrough", ["Pregnancies", "DiabetesPedigreeFunction", "Age"]),
    ])
    model = Pipeline([("prepare", prepare), ("scale", StandardScaler()), ("fit", LogisticRegression(max_iter=1000))])
    model.fit(cohort[names], cohort["Outcome"])
    auc = round(roc_auc_score(cohort["Outcome"], model.predict_proba(cohort[names])[:, 1]), 3)
    made = api.create("models", "Diabetes onset risk", {"framework": "sklearn", "format": "joblib", "task": "classification"},
                      project=project,
                      description=f"Logistic regression for diabetes diagnosed within five years, fitted on the 768 women of the Pima cohort (AUC {auc} on them). A 0 in Glucose, BloodPressure or BMI is read as not measured.")
    rid = made["metadata"]["rid"]
    blob = io.BytesIO()
    joblib.dump(model, blob)
    api.upload(f"/models/{rid}/files/model.joblib", blob.getvalue(), content_type="application/octet-stream")
    api.upload(f"/models/{rid}/files/README.md", CARD.format(sklearn=sklearn.__version__, n=len(cohort), url=PIMA_URL, auc=auc).encode(),
               content_type="text/markdown")
    api.post(f"/models/{rid}/commit", {
        "message": f"Fitted on the Pima cohort (scikit-learn {sklearn.__version__})",
        "contract": {
            "framework": "sklearn", "entry": "model.joblib",
            "inputs": [{"attributeName": n, "attributeType": t} for n, t in FEATURES],
            "outputs": [{"attributeName": "predicted", "attributeType": "long"}, {"attributeName": "risk", "attributeType": "double"}],
        },
    })
    return made["metadata"]["uri"]


def team_operator(api: Api, project: str, function: str, name: str) -> str:
    """One of the team's Python operators, from the example's operators/; returns its URI."""
    made = api.create("operators", name, {
        "group": "Diabetes",
        "implementation": {"python": {"code": (OPERATORS / f"{function}.py").read_text(), "function": function}},
    }, project=project)
    return made["metadata"]["uri"]


def team(api: Api, project: str) -> dict[str, str]:
    """The team's project as the use case finds it: the model and the two operators."""
    return {
        "model": onset_model(api, project),
        "roc_auc": team_operator(api, project, "roc_auc", "ROC AUC"),
        "calibration": team_operator(api, project, "calibration", "Risk calibration"),
    }


def main() -> None:
    """The team's project for a test in another language, the app's Playwright test:
    `python -m texera_e2e.diabetes --gw URL --name NAME` makes the project as the user and
    prints {project, name, model, roc_auc, calibration} as JSON."""
    import argparse
    import json

    from .client import token

    ap = argparse.ArgumentParser(description=main.__doc__)
    ap.add_argument("--gw", required=True)
    ap.add_argument("--user", default="alice")
    ap.add_argument("--password", default="alice")
    ap.add_argument("--name", required=True)
    args = ap.parse_args()
    api = Api(args.gw.rstrip("/"), token(args.gw.rstrip("/"), args.user, args.password))
    project = api.post("/projects", {"name": args.name, "spec": {}})["metadata"]["rid"]
    print(json.dumps({"project": project, "name": args.name, **team(api, project)}))


if __name__ == "__main__":
    main()
