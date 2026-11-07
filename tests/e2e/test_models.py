"""A model version is files and a contract: what it reads and what it puts out. predict runs a
version on a workflow's rows on the unit's Python workers: a fitted scikit-learn classifier gives
each row the class and the risk it gives in Python, the execution records that it used the
version, and a column the model reads that the input lacks is a mistake before anything runs."""
import io

import joblib
import numpy
import pandas as pd
from sklearn.linear_model import LogisticRegression

from texera_e2e import workflows as w

COHORT = pd.DataFrame(
    {
        "patient_id": [f"P-{i}" for i in range(1, 13)],
        "Glucose": [85, 168, 183, 89, 137, 116, 78, 115, 197, 125, 110, 168],
        "BMI": [26.6, 43.1, 23.3, 28.1, 43.1, 25.6, 31.0, 35.3, 30.5, 0.0, 37.6, 38.0],
        "Outcome": [0, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1],
    }
)
CONTRACT = {
    "framework": "sklearn",
    "entry": "model.joblib",
    "inputs": [{"attributeName": "Glucose", "attributeType": "double"}, {"attributeName": "BMI", "attributeType": "double"}],
    "outputs": [{"attributeName": "predicted", "attributeType": "long"}, {"attributeName": "risk", "attributeType": "double"}],
}


def fitted_model(api, project):
    """A logistic regression fitted on the cohort, uploaded as version 1 of a model with its contract."""
    estimator = LogisticRegression(max_iter=1000).fit(COHORT[["Glucose", "BMI"]].astype(float), COHORT["Outcome"])
    blob = io.BytesIO()
    joblib.dump(estimator, blob)
    model = api.create("models", "Diabetes risk", {"framework": "sklearn", "task": "classification"}, project=project)
    rid = model["metadata"]["rid"]
    api.upload(f"/models/{rid}/files/model.joblib", blob.getvalue(), content_type="application/octet-stream")
    version = api.post(f"/models/{rid}/commit", {"message": "fitted on the cohort", "contract": CONTRACT})
    assert version["vno"] == 1 and version["content"]["contract"]["framework"] == "sklearn"
    return estimator, f"{model['metadata']['uri']}@1"


def cohort_file(api, project):
    ds = api.create("datasets", "cohort", {"format": "csv"}, project=project)
    rid = ds["metadata"]["rid"]
    api.upload(f"/datasets/{rid}/files/cohort.csv", COHORT.to_csv(index=False).encode())
    api.post(f"/datasets/{rid}/commit", {"message": "cohort"})
    return f"{ds['metadata']['uri']}@1/files/cohort.csv"


def scored_workflow(api, project, file_uri, model_uri):
    def op(opid, op_type, **settings):
        return {"operatorID": opid, "operatorType": op_type, "operatorProperties": settings}

    def link(src, dst, lid):
        return {"linkID": lid, "source": {"operatorID": src, "portID": "output-0"}, "target": {"operatorID": dst, "portID": "input-0"}}

    spec = {
        "operators": [op("cohort", "scan", file=file_uri), op("scored", "predict", model=model_uri), op("ranked", "sort", by=["patient_id"])],
        "links": [link("cohort", "scored", "l1"), link("scored", "ranked", "l2")],
    }
    return api.create("workflows", "scored cohort", spec, project=project)["metadata"]["rid"]


def test_predict_gives_each_row_what_the_fitted_model_gives(alice, project, unit):
    estimator, model_uri = fitted_model(alice, project)
    file_uri = cohort_file(alice, project)
    rid = scored_workflow(alice, project, file_uri, model_uri)

    checked = alice.post(f"/workflows/{rid}/validate", {})
    assert checked["ok"], checked["operatorErrors"]
    columns = [(a["attributeName"], a["attributeType"]) for a in checked["operatorOutputSchemas"]["scored"]["output-0"]]
    assert columns[-2:] == [("predicted", "long"), ("risk", "double")]

    run = w.run(alice, rid, "scored", computingUnit=unit)
    assert run["status"]["phase"] == "completed", w.error_text(run)
    page = w.rows(alice, rid, run["metadata"]["rid"], opid="ranked", limit=20)
    got = {r[w.column(page, "patient_id")]: (r[w.column(page, "predicted")], r[w.column(page, "risk")]) for r in page["rows"]}

    ordered = COHORT.set_index("patient_id")
    features = ordered[["Glucose", "BMI"]].astype(float)
    want = dict(zip(ordered.index, zip(estimator.predict(features), estimator.predict_proba(features)[:, 1])))
    assert set(got) == set(want)
    for pid, (predicted, risk) in want.items():
        assert got[pid][0] == predicted and numpy.isclose(got[pid][1], risk), (pid, got[pid], (predicted, risk))

    up = alice.get(f"/resources/{run['metadata']['rid']}/lineage?direction=upstream")
    used = {e["to"] for e in up["edges"] if e["relation"] == "used"}
    assert f"{model_uri}/files/model.joblib" in used and file_uri in used, used


def test_a_column_the_model_reads_that_the_input_lacks_is_said_before_anything_runs(alice, project, unit):
    _, model_uri = fitted_model(alice, project)
    ds = alice.create("datasets", "lower", {"format": "csv"}, project=project)
    alice.upload(f"/datasets/{ds['metadata']['rid']}/files/lower.csv", COHORT.rename(columns={"Glucose": "glucose"}).to_csv(index=False).encode())
    alice.post(f"/datasets/{ds['metadata']['rid']}/commit", {})
    rid = scored_workflow(alice, project, f"{ds['metadata']['uri']}@1/files/lower.csv", model_uri)
    checked = alice.post(f"/workflows/{rid}/validate", {})
    assert not checked["ok"]
    assert 'model: the model reads Glucose: the input has no column "Glucose"; did you mean "glucose"?' in str(checked["operatorErrors"]["scored"])
