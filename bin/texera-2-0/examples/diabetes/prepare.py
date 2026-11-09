#!/usr/bin/env python3
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

"""Prepares a diabetes research team's project from public data: seven datasets and six models
fitted on them, which load.py puts into a Texera stack, and the file someone brings in the demo,
uploads/screening_cohort.csv: the 154 women the onset-risk model never saw.

    python prepare.py --out ~/texera-diabetes

The data is downloaded from where its authors published it; nothing is redistributed here:

- Pima Indians Diabetes (NIDDK, via the UCI repository): 768 Pima women aged 21 or more, eight
  clinical measurements and whether diabetes was diagnosed within five years.
  Smith et al., Proc Annu Symp Comput Appl Med Care 1988.
- Diabetes 130-US Hospitals 1999-2008 (UCI, CC BY 4.0): 101,766 inpatient encounters of patients
  with diabetes, with HbA1c testing, medications and readmission. Strack et al., BioMed Research
  International 2014, doi:10.1155/2014/781670.
- Diabetes progression (Efron, Hastie, Johnstone and Tibshirani, Annals of Statistics 2004): 442
  patients' baseline age, sex, BMI, blood pressure and six serum measurements, and a measure of
  disease progression one year later.
- Mapping lifestyle factors in blood glucose variability in adolescents with type 1 diabetes
  (Cronin, Dunne, O'Gorman and Cremona, University of Limerick, 2024; Zenodo
  doi:10.5281/zenodo.13749141, CC BY-NC 4.0): seven days of 5-minute CGM readings of seven
  adolescents, with their characteristics, activity and diet.
- Early stage diabetes risk prediction (Islam, Ferdousi, Rahman and Bushra 2020; UCI): 520 patients
  of Sylhet Diabetes Hospital, Bangladesh, their age, gender and 14 symptoms asked in a
  questionnaire, and whether a doctor diagnosed diabetes.
- CDC Diabetes Health Indicators (BRFSS 2015; UCI): a telephone survey of 253,680 US adults, of
  whom a random 20,000 are kept here, with 21 health indicators and whether they have diabetes.
- Diabetic Retinopathy Debrecen (Antal and Hajdu 2014; UCI): 1,151 retinal images of the Messidor
  set, the features extracted from each, and whether it shows signs of diabetic retinopathy.

The models are fitted with scikit-learn, whose version must be the one the computing units run:
a pickled estimator loads only under the version that saved it. It needs pandas, numpy,
scikit-learn, joblib and openpyxl.
"""

import argparse
import io
import json
import pathlib
import re
import urllib.request
import zipfile

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression, RidgeCV
from sklearn.metrics import accuracy_score, r2_score, roc_auc_score
from sklearn.model_selection import GroupShuffleSplit, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

SOURCES = {
    "pima": "https://raw.githubusercontent.com/jbrownlee/Datasets/master/pima-indians-diabetes.data.csv",
    "hospitals": "https://archive.ics.uci.edu/static/public/296/diabetes+130-us+hospitals+for+years+1999-2008.zip",
    "progression": "https://www4.stat.ncsu.edu/~boos/var.select/diabetes.tab.txt",
    "cgm": "https://zenodo.org/api/records/13749141/files/Data_for_T1D_Mapping_Study.zip/content",
    "early-stage": "https://archive.ics.uci.edu/static/public/529/early+stage+diabetes+risk+prediction+dataset.zip",
    "health-indicators": "https://archive.ics.uci.edu/static/public/891/data.csv",
    "retinopathy": "https://archive.ics.uci.edu/static/public/329/diabetic+retinopathy+debrecen.zip",
}
SEED = 7


def fetch(name: str, cache: pathlib.Path) -> bytes:
    """A source's bytes, downloaded once into the cache."""
    path = cache / name
    if not path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(SOURCES[name], timeout=600) as r:
            path.write_bytes(r.read())
    return path.read_bytes()


def write(folder: pathlib.Path, files: dict) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        target = folder / name
        if isinstance(content, pd.DataFrame):
            content.to_csv(target, index=False)
        elif isinstance(content, bytes):
            target.write_bytes(content)
        else:
            target.write_text(content)


def card(folder: pathlib.Path, **fields) -> None:
    """What load.py makes of a folder: its name, description and kind-specific fields."""
    (folder / "card.json").write_text(json.dumps(fields, indent=2) + "\n")


# ---- datasets ----------------------------------------------------------------------------


def pima(cache: pathlib.Path, out: pathlib.Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    columns = [
        "Pregnancies",
        "Glucose",
        "BloodPressure",
        "SkinThickness",
        "Insulin",
        "BMI",
        "DiabetesPedigreeFunction",
        "Age",
        "Outcome",
    ]
    frame = pd.read_csv(io.BytesIO(fetch("pima", cache)), header=None, names=columns)
    frame.insert(0, "patient_id", range(1, len(frame) + 1))
    # The team has 614 of the women; the other 154 are the file someone brings in the demo.
    team, screening = train_test_split(
        frame, test_size=0.2, stratify=frame["Outcome"], random_state=SEED
    )
    team, screening = team.sort_values("patient_id"), screening.sort_values("patient_id")
    write(out / "uploads", {"screening_cohort.csv": screening})
    folder = out / "datasets" / "pima"
    write(folder, {"pima_cohort.csv": team, "README.md": PIMA_README})
    card(
        folder,
        name="Pima diabetes cohort",
        description="614 Pima women aged 21 or more (NIDDK): eight clinical measurements and whether diabetes was diagnosed within five years. A 0 in Glucose, BloodPressure, SkinThickness, Insulin or BMI means not measured. The team's onset-risk model was fitted on these women.",
        message="The NIDDK cohort as the UCI repository has it, with row numbers as patient_id",
    )
    return team, screening


PIMA_README = """# Pima diabetes cohort

614 of the 768 women of Pima Indian heritage, aged 21 or more, from the National Institute of Diabetes and
Digestive and Kidney Diseases, as the UCI Machine Learning Repository distributes them. Smith JW,
Everhart JE, Dickson WC, Knowler WC, Johannes RS. Using the ADAP learning algorithm to forecast the
onset of diabetes mellitus. Proc Annu Symp Comput Appl Med Care 1988:261-265.

| Column | Meaning |
| --- | --- |
| patient_id | The row's number in the file, added here |
| Pregnancies | Number of times pregnant |
| Glucose | Plasma glucose two hours into an oral glucose tolerance test, mg/dL |
| BloodPressure | Diastolic blood pressure, mm Hg |
| SkinThickness | Triceps skinfold thickness, mm |
| Insulin | Two-hour serum insulin, mu U/ml |
| BMI | Body mass index, kg/m2 |
| DiabetesPedigreeFunction | A score of diabetes in the family |
| Age | Years |
| Outcome | 1 if diabetes was diagnosed within five years, else 0 |

A 0 in Glucose, BloodPressure, SkinThickness, Insulin or BMI is a measurement not taken, not a
value. The team's onset-risk model was fitted on these women.
"""


def hospitals(cache: pathlib.Path, out: pathlib.Path) -> pd.DataFrame:
    archive = zipfile.ZipFile(io.BytesIO(fetch("hospitals", cache)))
    encounters = archive.read("diabetic_data.csv")
    mapping = archive.read("IDS_mapping.csv")
    folder = out / "datasets" / "hospitals"
    write(
        folder,
        {
            "encounters.csv": encounters,
            "id_mapping.csv": mapping,
            "README.md": HOSPITALS_README,
        },
    )
    card(
        folder,
        name="Hospital diabetes encounters",
        description="101,766 inpatient encounters of patients with diabetes at 130 US hospitals, 1999-2008 (UCI): demographics, HbA1c testing, glucose, medications, diagnoses as ICD-9 codes, and readmission within 30 days. Missing values are written '?', and an HbA1c not tested 'None'.",
        message="Diabetes 130-US hospitals 1999-2008, as the UCI repository has it",
    )
    return pd.read_csv(io.BytesIO(encounters), keep_default_na=False, na_values=[])


HOSPITALS_README = """# Hospital diabetes encounters

Diabetes 130-US Hospitals for Years 1999-2008, from the UCI Machine Learning Repository (CC BY
4.0): 101,766 inpatient encounters of 71,518 patients with diabetes, each 1 to 14 days, with
laboratory tests and medications. Strack B, DeShazo JP, Gennings C, et al. Impact of HbA1c
measurement on hospital readmission rates: analysis of 70,000 clinical database patient records.
BioMed Research International 2014:781670. doi:10.1155/2014/781670.

- encounters.csv: one row per encounter; patient_nbr identifies the patient. readmitted is <30
  (within 30 days), >30, or NO. A1Cresult is >8, >7, Norm, or None when HbA1c was not measured.
  diag_1 to diag_3 are ICD-9 codes: 250.xx is diabetes, 390-459 and 785 circulatory, 460-519
  and 786 respiratory, 520-579 and 787 digestive, 800-999 injury, 710-739 musculoskeletal,
  580-629 and 788 genitourinary, 140-239 neoplasms; codes starting V or E are other.
- id_mapping.csv: what admission_type_id, discharge_disposition_id and admission_source_id
  mean. Discharges 11, 19, 20 and 21 are deaths and 13 and 14 hospice: such encounters cannot
  be readmitted.
- '?' marks a missing value, as the source writes it.
"""


def progression(cache: pathlib.Path, out: pathlib.Path) -> pd.DataFrame:
    raw = pd.read_csv(io.BytesIO(fetch("progression", cache)), sep="\t")
    frame = raw.rename(
        columns={
            "AGE": "age",
            "SEX": "sex",
            "BMI": "bmi",
            "BP": "map",
            "S1": "tc",
            "S2": "ldl",
            "S3": "hdl",
            "S4": "tc_hdl",
            "S5": "ltg",
            "S6": "glucose",
            "Y": "progression",
        }
    )
    frame.insert(0, "patient_id", range(1, len(frame) + 1))
    folder = out / "datasets" / "progression"
    write(folder, {"progression.csv": frame, "README.md": PROGRESSION_README})
    card(
        folder,
        name="Diabetes progression",
        description="442 patients with diabetes (Efron et al. 2004): baseline age, sex, BMI, mean arterial pressure and six serum measurements, and a quantitative measure of disease progression one year later.",
        message="The Efron et al. data, columns named for what they measure",
    )
    return frame


PROGRESSION_README = """# Diabetes progression

442 patients with diabetes: ten baseline variables and a quantitative measure of disease
progression one year after baseline. Efron B, Hastie T, Johnstone I, Tibshirani R. Least angle
regression. Annals of Statistics 2004;32(2):407-499. The columns are renamed here for what they
measure:

| Column | Source | Meaning |
| --- | --- | --- |
| age | AGE | Years |
| sex | SEX | 1 or 2 |
| bmi | BMI | Body mass index |
| map | BP | Mean arterial pressure |
| tc | S1 | Total serum cholesterol |
| ldl | S2 | Low-density lipoproteins |
| hdl | S3 | High-density lipoproteins |
| tc_hdl | S4 | Total cholesterol over HDL |
| ltg | S5 | Log of serum triglycerides |
| glucose | S6 | Blood sugar level |
| progression | Y | Disease progression one year later |
"""


def snake(name: str) -> str:
    """A column's name as a word: 'Sedentary %' is sedentary_pct, 'CV (%)' cv_pct, 'Avg. glucose (mmol/L)' avg_glucose_mmol."""
    name = name.replace("%", " pct").replace("mmol/L", "mmol").replace("Y/N", "met")
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", name.strip().lower())).strip(
        "_"
    )


def cgm(cache: pathlib.Path, out: pathlib.Path) -> pd.DataFrame:
    archive = zipfile.ZipFile(io.BytesIO(fetch("cgm", cache)))
    cleaned = "Dataset - Zenodo/Cleaned data/2024-09-10_T1D_Mapping_Study_"
    readings = pd.read_excel(
        io.BytesIO(archive.read(cleaned + "CGM_Data.xlsx")), sheet_name="CGM data"
    )
    readings.columns = [str(c).strip() for c in readings.columns]
    readings = pd.DataFrame(
        {
            "participant": readings["Participant"].astype(str),
            "taken_at": pd.to_datetime(
                readings["Date"].astype(str) + " " + readings["Time"].astype(str)
            ),
            "glucose_mmol": readings["Blood Glucose (BG)"].astype(float),
        }
    ).sort_values(["participant", "taken_at"])
    people = pd.read_excel(
        io.BytesIO(archive.read(cleaned + "Final_Outcomes_Data_Sheet.xlsx")),
        sheet_name="Cleaned data for analysis",
    )
    people.columns = [snake(c) for c in people.columns]
    folder = out / "datasets" / "cgm"
    write(
        folder,
        {"cgm.csv": readings, "participants.csv": people, "README.md": CGM_README},
    )
    card(
        folder,
        name="Adolescent T1D CGM",
        description="Seven days of 5-minute continuous glucose monitoring of seven adolescents with type 1 diabetes, glucose in mmol/L, with each one's age, BMI, insulin therapy, activity and diet (Cronin et al. 2024, University of Limerick; CC BY-NC 4.0).",
        message="The study's cleaned CGM readings and participant data",
    )
    return readings


CGM_README = """# Adolescent T1D CGM

Cronin A, Dunne T, O'Gorman C, Cremona A. Supplemental data for: Mapping lifestyle factors in
blood glucose variability in adolescents with type 1 diabetes mellitus, a pilot study.
University of Limerick, 2024. Zenodo, doi:10.5281/zenodo.13749141. CC BY-NC 4.0: for research,
not for commercial use, with this attribution.

- cgm.csv: participant (P1 to P7), taken_at, and glucose_mmol, the sensor's glucose in mmol/L
  (multiply by 18.018 for mg/dL), every 5 minutes for 7 days from July to October 2023.
- participants.csv: each participant's gender, age, weight (kg), height (cm), BMI and its
  centile and category, insulin therapy (pump or pens), daily steps, minutes per day sedentary,
  lightly and moderately-vigorously active (and as a share of the day, _pct), whether the
  activity guideline was met, and daily energy, protein, carbohydrate, sugar and fat (g, and as
  a share of energy, _pct), each with whether its guideline was met. Then the study's own
  glycaemic outcomes over the week: avg_glucose_mmol, standard_deviation_mmol, cv_pct, CONGA,
  LBGI, HBGI, MODD, MAGE, MAG, and the share of time very high (above 13.9 mmol/L), high (above
  10.0), in range (3.9 to 10.0), low (below 3.9) and very low (below 3.0).
"""


# ---- models ------------------------------------------------------------------------------


def early_stage(cache: pathlib.Path, out: pathlib.Path) -> pd.DataFrame:
    archive = zipfile.ZipFile(io.BytesIO(fetch("early-stage", cache)))
    frame = pd.read_csv(io.BytesIO(archive.read("diabetes_data_upload.csv")))
    frame.columns = [snake(c) for c in frame.columns]
    frame = frame.rename(columns={"class": "diagnosis"})
    folder = out / "datasets" / "early-stage"
    write(
        folder,
        {
            "early_stage.csv": frame,
            "README.md": DATA_README.format(
                title="Early-stage diabetes symptoms",
                what="520 patients of Sylhet Diabetes Hospital, Bangladesh: their age, gender, 14 symptoms asked in a questionnaire (Yes or No), and `diagnosis`, Positive when a doctor diagnosed diabetes.",
                source="Islam MMF, Ferdousi R, Rahman S, Bushra HY. Likelihood prediction of diabetes at early stage using data mining techniques. 2020. UCI Machine Learning Repository, dataset 529. Column names here are in snake case.",
            ),
        },
    )
    card(
        folder,
        name="Early-stage diabetes symptoms",
        description="520 patients of a hospital in Bangladesh: age, gender, 14 symptoms from a questionnaire, and whether a doctor diagnosed diabetes (UCI).",
        message="Early stage diabetes risk prediction, as the UCI repository has it, its columns in snake case",
    )
    return frame


def health_indicators(cache: pathlib.Path, out: pathlib.Path) -> pd.DataFrame:
    frame = pd.read_csv(io.BytesIO(fetch("health-indicators", cache))).drop(columns="ID")
    sample = frame.sample(20_000, random_state=SEED).reset_index(drop=True)
    folder = out / "datasets" / "health-indicators"
    write(
        folder,
        {
            "health_indicators.csv": sample,
            "README.md": DATA_README.format(
                title="CDC diabetes health indicators",
                what="A random 20,000 of the 253,680 US adults in the CDC's 2015 telephone survey: 21 health indicators (blood pressure, cholesterol, BMI, smoking, activity, income and more) and `Diabetes_binary`, 1 for diabetes or prediabetes.",
                source="CDC Behavioral Risk Factor Surveillance System 2015. CDC Diabetes Health Indicators, UCI Machine Learning Repository, dataset 891.",
            ),
        },
    )
    card(
        folder,
        name="CDC diabetes health indicators",
        description="A random 20,000 of the 253,680 US adults in the CDC's 2015 survey: 21 health indicators and whether they have diabetes or prediabetes (UCI).",
        message="A random 20,000 respondents of CDC Diabetes Health Indicators, as the UCI repository has it",
    )
    return sample


RETINOPATHY_COLUMNS = [
    "image_quality",
    "pre_screening",
    *[f"microaneurysms_{n}" for n in range(1, 7)],
    *[f"exudates_{n}" for n in range(1, 9)],
    "macula_optic_distance",
    "optic_disc_diameter",
    "am_fm",
    "signs_of_retinopathy",
]


def retinopathy(cache: pathlib.Path, out: pathlib.Path) -> pd.DataFrame:
    archive = zipfile.ZipFile(io.BytesIO(fetch("retinopathy", cache)))
    text = archive.read("messidor_features.arff").decode()
    rows = text[text.lower().index("@data") + len("@data") :].strip()
    frame = pd.read_csv(io.StringIO(rows), header=None, names=RETINOPATHY_COLUMNS)
    folder = out / "datasets" / "retinopathy"
    write(
        folder,
        {
            "retinal_features.csv": frame,
            "README.md": DATA_README.format(
                title="Diabetic retinopathy features",
                what="1,151 retinal images of the Messidor set: the quality of each, how many microaneurysms and how much exudate were detected at several confidence levels, the distance from macula to optic disc, the optic disc's diameter, and `signs_of_retinopathy`, 1 when the image shows them.",
                source="Antal B, Hajdu A. An ensemble-based system for automatic screening of diabetic retinopathy. Knowledge-Based Systems 2014;60:20-27. UCI Machine Learning Repository, dataset 329. Column names are given here from the repository's description.",
            ),
        },
    )
    card(
        folder,
        name="Diabetic retinopathy features",
        description="1,151 retinal images (Messidor): features extracted from each image and whether it shows signs of diabetic retinopathy (UCI).",
        message="Diabetic Retinopathy Debrecen, as the UCI repository has it, with its columns named",
    )
    return frame


DATA_README = """# {title}

{what}

Source: {source}
"""


def contract(framework, entry, inputs, outputs, **more):
    return {
        "framework": framework,
        "entry": entry,
        "inputs": [{"attributeName": n, "attributeType": t} for n, t in inputs],
        "outputs": [{"attributeName": n, "attributeType": t} for n, t in outputs],
        **more,
    }


def save_model(
    folder: pathlib.Path, estimator, holdout, readme: str, contract: dict, **fields
) -> None:
    """A model version's files, contract.json saying what it reads and adds, and what load.py
    calls it."""
    folder.mkdir(parents=True, exist_ok=True)
    joblib.dump(estimator, folder / "model.joblib")
    write(
        folder,
        {"README.md": readme, "contract.json": json.dumps(contract, indent=2) + "\n"},
    )
    if holdout is not None:
        write(folder, {"holdout.csv": holdout})
    card(folder, **fields)


def onset_risk(team: pd.DataFrame, screening: pd.DataFrame, out: pathlib.Path) -> dict:
    """Logistic regression for diabetes within five years, a 0 read as not measured: fitted on the
    team's women, tested on those it never saw."""
    features = [
        "Pregnancies",
        "Glucose",
        "BloodPressure",
        "BMI",
        "DiabetesPedigreeFunction",
        "Age",
    ]
    prepare = ColumnTransformer(
        [
            (
                "zero_is_missing",
                SimpleImputer(missing_values=0, strategy="median"),
                ["Glucose", "BloodPressure", "BMI"],
            ),
            (
                "as_is",
                "passthrough",
                ["Pregnancies", "DiabetesPedigreeFunction", "Age"],
            ),
        ]
    )
    model = Pipeline(
        [
            ("prepare", prepare),
            ("scale", StandardScaler()),
            ("fit", LogisticRegression(max_iter=1000)),
        ]
    )
    model.fit(team[features], team["Outcome"])
    risk = model.predict_proba(screening[features])[:, 1]
    metrics = {
        "test_auc": round(roc_auc_score(screening["Outcome"], risk), 3),
        "test_accuracy": round(
            accuracy_score(screening["Outcome"], model.predict(screening[features])), 3
        ),
        "train": len(team),
        "test": len(screening),
    }
    save_model(
        out / "models" / "onset-risk",
        model,
        None,
        ONSET_README.format(sklearn=sklearn.__version__, **metrics),
        contract=contract(
            "sklearn",
            "model.joblib",
            [
                ("Pregnancies", "integer"),
                ("Glucose", "integer"),
                ("BloodPressure", "integer"),
                ("BMI", "double"),
                ("DiabetesPedigreeFunction", "double"),
                ("Age", "integer"),
            ],
            [("predicted", "long"), ("risk", "double")],
        ),
        name="Diabetes onset risk",
        description=f"Who is likely to develop diabetes within five years, from six routine clinic measurements of adult women. A logistic regression fitted on the Pima cohort; AUC {metrics['test_auc']} on women it never saw.",
        spec={"framework": "sklearn", "format": "joblib", "task": "classification"},
        message=f"Fitted on the Pima diabetes cohort, version 1 (scikit-learn {sklearn.__version__})",
        metrics=metrics,
    )
    return metrics


ONSET_README = """# Diabetes onset risk

Estimates who is likely to be diagnosed with diabetes within five years, from six measurements
taken at a routine clinic visit. It is for adult women; it says nothing of people who already have
diabetes, or of other populations it has not been checked on.

A logistic regression fitted with scikit-learn {sklearn} on {train} women of the Pima diabetes
cohort. A 0 in Glucose, BloodPressure or BMI is read as a measurement not taken and replaced by the
median of the fitted women; the features are then standardized.

On {test} women it never saw: AUC {test_auc}, accuracy {test_accuracy} at a threshold of 0.5.

predict adds `predicted`, 1 for diabetes within five years, and `risk`, its probability.
"""

ADMISSION_FEATURES = [
    "age",
    "A1Cresult",
    "max_glu_serum",
    "insulin",
    "change",
    "diabetesMed",
    "admission_type_id",
    "discharge_disposition_id",
    "admission_source_id",
]
COUNT_FEATURES = [
    "time_in_hospital",
    "num_lab_procedures",
    "num_procedures",
    "num_medications",
    "number_outpatient",
    "number_emergency",
    "number_inpatient",
    "number_diagnoses",
]
# Encounters that end in death or hospice cannot be readmitted (Strack et al.).
NOT_READMITTABLE = {11, 13, 14, 19, 20, 21}


def readmission_risk(encounters: pd.DataFrame, out: pathlib.Path) -> dict:
    """Logistic regression for readmission within 30 days, split by patient so none is on both sides."""
    frame = encounters[
        ~encounters["discharge_disposition_id"].isin(NOT_READMITTABLE)
    ].copy()
    frame["readmitted_30"] = (frame["readmitted"] == "<30").astype(int)
    split = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=SEED)
    train_rows, test_rows = next(split.split(frame, groups=frame["patient_nbr"]))
    train, test = frame.iloc[train_rows], frame.iloc[test_rows]
    categories = Pipeline(
        [
            ("fill", SimpleImputer(strategy="constant", fill_value="None")),
            ("onehot", OneHotEncoder(handle_unknown="ignore")),
        ]
    )
    prepare = ColumnTransformer(
        [
            ("categories", categories, ADMISSION_FEATURES),
            ("counts", StandardScaler(), COUNT_FEATURES),
        ]
    )
    model = Pipeline([("prepare", prepare), ("fit", LogisticRegression(max_iter=2000))])
    features = ADMISSION_FEATURES + COUNT_FEATURES
    model.fit(train[features], train["readmitted_30"])
    risk = model.predict_proba(test[features])[:, 1]
    metrics = {
        "test_auc": round(roc_auc_score(test["readmitted_30"], risk), 3),
        "base_rate": round(float(test["readmitted_30"].mean()), 3),
        "train": len(train),
        "test": len(test),
    }
    types = {
        c: ("string" if encounters[c].dtype == object else "integer") for c in features
    }
    save_model(
        out / "models" / "readmission-risk",
        model,
        test[["encounter_id"]],
        READMISSION_README.format(sklearn=sklearn.__version__, **metrics),
        name="30-day readmission risk",
        description=f"Logistic regression for readmission within 30 days of a diabetes inpatient encounter, fitted on 80% of the hospital encounters' patients; held-out AUC {metrics['test_auc']} against a base rate of {metrics['base_rate']}.",
        spec={"framework": "sklearn", "format": "joblib", "task": "classification"},
        contract=contract(
            "sklearn",
            "model.joblib",
            [(c, types[c]) for c in features],
            [("readmit_predicted", "long"), ("readmit_risk", "double")],
        ),
        message=f"Fitted on the hospital diabetes encounters, version 1, all but holdout.csv (scikit-learn {sklearn.__version__})",
        metrics=metrics,
    )
    return metrics


READMISSION_README = """# 30-day readmission risk

A logistic regression for readmission within 30 days of an inpatient encounter, fitted with
scikit-learn {sklearn} on the hospital diabetes encounters (version 1), without the encounters
that ended in death or hospice. Its patients were split 80/20, so no patient is on both sides:
{train} encounters to fit, {test} held out; holdout.csv lists the encounter_id of those it never
saw. Categories (age band, HbA1c and glucose results, insulin, a change of medication, admission
type, source and discharge) are one-hot encoded, an unseen one ignored; the counts are
standardized.

Held out: AUC {test_auc}; {base_rate} of the held-out encounters were readmitted within 30 days.

predict adds `readmit_predicted`, 1 for readmission at a threshold of 0.5, and `readmit_risk`,
its probability.
"""


def progression_model(frame: pd.DataFrame, out: pathlib.Path) -> dict:
    features = [
        "age",
        "sex",
        "bmi",
        "map",
        "tc",
        "ldl",
        "hdl",
        "tc_hdl",
        "ltg",
        "glucose",
    ]
    train, test = train_test_split(frame, test_size=0.2, random_state=SEED)
    model = Pipeline(
        [("scale", StandardScaler()), ("fit", RidgeCV(alphas=np.logspace(-3, 3, 25)))]
    )
    model.fit(train[features], train["progression"])
    metrics = {
        "test_r2": round(
            r2_score(test["progression"], model.predict(test[features])), 3
        ),
        "train": len(train),
        "test": len(test),
    }
    types = {
        c: ("integer" if frame[c].dtype.kind == "i" else "double") for c in features
    }
    save_model(
        out / "models" / "progression",
        model,
        test[["patient_id"]],
        PROGRESSION_MODEL_README.format(sklearn=sklearn.__version__, **metrics),
        name="Progression regressor",
        description=f"Ridge regression of disease progression one year after baseline from age, sex, BMI, blood pressure and six serum measurements, fitted on 353 of the 442 patients; held-out R2 {metrics['test_r2']}.",
        spec={"framework": "sklearn", "format": "joblib", "task": "regression"},
        contract=contract(
            "sklearn",
            "model.joblib",
            [(c, types[c]) for c in features],
            [("predicted_progression", "double")],
        ),
        message=f"Fitted on the diabetes progression data, version 1, all but holdout.csv (scikit-learn {sklearn.__version__})",
        metrics=metrics,
    )
    return metrics


PROGRESSION_MODEL_README = """# Progression regressor

A ridge regression of disease progression one year after baseline, its penalty chosen by
cross-validation, fitted with scikit-learn {sklearn} on the diabetes progression data (version
1): {train} patients to fit, {test} held out (holdout.csv). The features are standardized first.

Held out: R2 {test_r2}.

predict adds `predicted_progression`.
"""


def simple_classifier(
    frame: pd.DataFrame,
    label: pd.Series,
    out: pathlib.Path,
    folder: str,
    numeric: list[str],
    categories: list[str],
    outputs: tuple[str, str],
    name: str,
    what: str,
) -> dict:
    """Logistic regression, checked on a held-out fifth of its table, saved as every model here is."""
    features = numeric + categories
    train, test, train_label, test_label = train_test_split(
        frame[features], label, test_size=0.2, random_state=SEED, stratify=label
    )
    prepare = ColumnTransformer(
        [
            ("numbers", StandardScaler(), numeric),
            ("categories", OneHotEncoder(handle_unknown="ignore"), categories),
        ]
    )
    model = Pipeline([("prepare", prepare), ("fit", LogisticRegression(max_iter=2000))])
    model.fit(train, train_label)
    risk = model.predict_proba(test)[:, 1]
    metrics = {
        "test_auc": round(roc_auc_score(test_label, risk), 3),
        "test_accuracy": round(accuracy_score(test_label, model.predict(test)), 3),
        "train": len(train),
        "test": len(test),
    }
    numeric_type = {c: "integer" if frame[c].dtype.kind in "iu" else "double" for c in numeric}
    save_model(
        out / "models" / folder,
        model,
        None,
        MODEL_README.format(
            name=name,
            what=what,
            sklearn=sklearn.__version__,
            columns=", ".join(f"`{c}`" for c in features),
            **metrics,
        ),
        name=name,
        description=f"{what} AUC {metrics['test_auc']} on {metrics['test']} rows it never saw.",
        spec={"framework": "sklearn", "format": "joblib", "task": "classification"},
        contract=contract(
            "sklearn",
            "model.joblib",
            [(c, numeric_type[c]) for c in numeric] + [(c, "string") for c in categories],
            [(outputs[0], "long"), (outputs[1], "double")],
        ),
        message=f"Fitted on four fifths of its dataset, version 1 (scikit-learn {sklearn.__version__})",
        metrics=metrics,
    )
    return metrics


MODEL_README = """# {name}

{what}

A logistic regression fitted with scikit-learn {sklearn} on {train} rows, and checked on {test} rows it never saw: AUC {test_auc}, accuracy {test_accuracy}.

It reads {columns}.
"""


def more_models(early: pd.DataFrame, indicators: pd.DataFrame, retina: pd.DataFrame, out: pathlib.Path) -> dict:
    """A model for each dataset that has none. Each reads columns of its own."""
    symptoms = [c for c in early.columns if c not in ("age", "diagnosis")]
    survey = [c for c in indicators.columns if c != "Diabetes_binary"]
    images = [c for c in retina.columns if c != "signs_of_retinopathy"]
    return {
        "early-stage": simple_classifier(
            early,
            (early["diagnosis"] == "Positive").astype(int),
            out,
            "early-stage",
            ["age"],
            symptoms,
            ("symptoms_predicted", "symptoms_risk"),
            name="Early-stage symptom screen",
            what="Whether a person has diabetes, from their age, gender and 14 symptoms asked in a questionnaire.",
        ),
        "health-indicators": simple_classifier(
            indicators,
            indicators["Diabetes_binary"].astype(int),
            out,
            "health-indicators",
            survey,
            [],
            ("survey_predicted", "survey_risk"),
            name="Survey health-indicator risk",
            what="Whether a US adult has diabetes or prediabetes, from 21 health indicators of a telephone survey.",
        ),
        "retinopathy": simple_classifier(
            retina,
            retina["signs_of_retinopathy"],
            out,
            "retinopathy",
            images,
            [],
            ("retinopathy_predicted", "retinopathy_risk"),
            name="Retinopathy signs classifier",
            what="Whether a retinal image shows signs of diabetic retinopathy, from features extracted from the image.",
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--out", type=pathlib.Path, required=True, help="where the project's files go"
    )
    parser.add_argument(
        "--cache",
        type=pathlib.Path,
        help="where the downloads are kept (default: <out>/downloads)",
    )
    args = parser.parse_args()
    cache = args.cache or args.out / "downloads"
    team, screening = pima(cache, args.out)
    encounters = hospitals(cache, args.out)
    frame = progression(cache, args.out)
    readings = cgm(cache, args.out)
    early = early_stage(cache, args.out)
    indicators = health_indicators(cache, args.out)
    retina = retinopathy(cache, args.out)
    print(
        f"datasets: {len(team)} women, {len(encounters)} encounters, {len(frame)} patients, {len(readings)} CGM readings"
    )
    print("onset risk", onset_risk(team, screening, args.out))
    print("readmission risk", readmission_risk(encounters, args.out))
    print("progression", progression_model(frame, args.out))
    print("more", more_models(early, indicators, retina, args.out))
    print(
        f"written to {args.out}, models fitted with scikit-learn {sklearn.__version__}"
    )


if __name__ == "__main__":
    main()
