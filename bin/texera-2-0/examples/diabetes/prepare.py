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

"""Prepares a research team's project on diabetes, kidney and liver disease from public data:
twelve datasets, fifteen models (fitted on them, or published clinical equations), which load.py
puts into a Texera stack, and the file someone brings in the demo, uploads/screening_cohort.csv:
the 154 women the onset-risk model never saw.

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
- NHANES 2017-2018 (CDC National Center for Health Statistics, public domain): the adults examined,
  their HbA1c, fasting glucose and insulin, kidney and liver panels, liver elastography and history.
- Chronic Kidney Disease (Rubini, Soundarapandian and Eswaran 2015; UCI, CC BY 4.0): 400 patients
  of a hospital in India, 24 clinical values and whether they have chronic kidney disease.
- HCV data (Lichtinghagen, Klawonn and Hoffmann 2020; UCI, CC BY 4.0): 615 blood donors and people
  with hepatitis C, their laboratory values, and how far the liver disease has gone.
- Cirrhosis Patient Survival (Dickson et al. 1989; UCI, CC BY 4.0): the Mayo Clinic's 418 patients
  with primary biliary cirrhosis, their laboratory values and how they fared.
- Gene expression of beta cells in type 2 diabetes (Marselli et al. 2010; NCBI GEO, GDS3782):
  pancreatic beta cells laser-captured from 10 donors with type 2 diabetes and 10 without.

The fitted models use scikit-learn, whose version must be the one the computing units run: a
pickled estimator loads only under the version that saved it. The equations are the files of
equations/, each checked against an example worked by hand. It needs pandas, numpy, scikit-learn,
joblib and openpyxl.
"""

import argparse
import gzip
import importlib.util
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
    "kidney": "https://archive.ics.uci.edu/static/public/336/data.csv",
    "hepatitis-c": "https://archive.ics.uci.edu/static/public/571/hcv+data.zip",
    "biliary-cirrhosis": "https://archive.ics.uci.edu/static/public/878/data.csv",
    "beta-cells": "https://ftp.ncbi.nlm.nih.gov/geo/datasets/GDS3nnn/GDS3782/soft/GDS3782.soft.gz",
}
# Each NHANES 2017-2018 table used, and what its columns are called here.
NHANES_TABLES = {
    "DEMO_J": {
        "RIDSTATR": "exam_status",
        "RIDAGEYR": "age_years",
        "RIAGENDR": "sex",
        "RIDRETH3": "race_ethnicity",
        "INDFMPIR": "income_poverty_ratio",
        "WTMEC2YR": "exam_weight",
    },
    "BMX_J": {"BMXBMI": "bmi", "BMXWAIST": "waist_cm"},
    "BPX_J": {f"BPX{side}{n}": f"{side}{n}" for side in ("SY", "DI") for n in (1, 2, 3)},
    "GHB_J": {"LBXGH": "hba1c_pct"},
    "GLU_J": {"LBXGLU": "fasting_glucose_mg_dl", "WTSAF2YR": "fasting_weight"},
    "INS_J": {"LBXIN": "fasting_insulin_uu_ml"},
    "BIOPRO_J": {
        "LBXSCR": "creatinine_mg_dl",
        "LBXSASSI": "ast_u_l",
        "LBXSATSI": "alt_u_l",
        "LBXSGTSI": "ggt_u_l",
        "LBXSAL": "albumin_g_dl",
    },
    "CBC_J": {"LBXPLTSI": "platelets_k_ul"},
    "ALB_CR_J": {"URDACT": "uacr_mg_g"},
    "TRIGLY_J": {"LBXTR": "triglycerides_mg_dl"},
    "HDL_J": {"LBDHDD": "hdl_mg_dl"},
    "TCHOL_J": {"LBXTC": "total_cholesterol_mg_dl"},
    "DIQ_J": {"DIQ010": "diagnosed_diabetes", "DIQ050": "on_insulin", "DIQ070": "on_diabetes_pills"},
    "MCQ_J": {"MCQ300C": "family_history_diabetes"},
    "BPQ_J": {"BPQ020": "ever_high_bp", "BPQ050A": "on_bp_medication"},
    "LUX_J": {"LUXSMED": "liver_stiffness_kpa", "LUXCAPM": "liver_steatosis_cap"},
}
SOURCES.update(
    {
        f"nhanes-{table}": f"https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public/2017/DataFiles/{table}.xpt"
        for table in NHANES_TABLES
    }
)
SEED = 7
EQUATIONS = pathlib.Path(__file__).resolve().parent / "equations"


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


YES_NO = {1: "yes", 2: "no"}


def nhanes(cache: pathlib.Path, out: pathlib.Path) -> pd.DataFrame:
    """The adults examined, one row each, the tables joined on the respondent's number."""
    frame = None
    for table, columns in NHANES_TABLES.items():
        part = pd.read_sas(io.BytesIO(fetch(f"nhanes-{table}", cache)), format="xport", encoding="utf-8")
        part = part[["SEQN", *columns]].rename(columns=columns)
        frame = part if frame is None else frame.merge(part, on="SEQN", how="left")
    frame = frame[(frame["exam_status"] == 2) & (frame["age_years"] >= 20)].copy()
    frame["systolic_bp"] = frame[["SY1", "SY2", "SY3"]].mean(axis=1)
    frame["diastolic_bp"] = frame[["DI1", "DI2", "DI3"]].mean(axis=1)
    frame["sex"] = frame["sex"].map({1: "male", 2: "female"})
    frame["race_ethnicity"] = frame["race_ethnicity"].map(
        {
            1: "Mexican American",
            2: "Other Hispanic",
            3: "Non-Hispanic White",
            4: "Non-Hispanic Black",
            6: "Non-Hispanic Asian",
            7: "Other or multiracial",
        }
    )
    frame["diagnosed_diabetes"] = frame["diagnosed_diabetes"].map({**YES_NO, 3: "borderline"})
    for column in ("on_insulin", "on_diabetes_pills", "family_history_diabetes", "ever_high_bp", "on_bp_medication"):
        frame[column] = frame[column].map(YES_NO)
    frame["respondent_id"] = frame["SEQN"].astype(int)
    frame["age_years"] = frame["age_years"].astype(int)
    frame = frame[
        [
            "respondent_id",
            "age_years",
            "sex",
            "race_ethnicity",
            "income_poverty_ratio",
            "bmi",
            "waist_cm",
            "systolic_bp",
            "diastolic_bp",
            "hba1c_pct",
            "fasting_glucose_mg_dl",
            "fasting_insulin_uu_ml",
            "creatinine_mg_dl",
            "ast_u_l",
            "alt_u_l",
            "ggt_u_l",
            "albumin_g_dl",
            "platelets_k_ul",
            "uacr_mg_g",
            "triglycerides_mg_dl",
            "hdl_mg_dl",
            "total_cholesterol_mg_dl",
            "diagnosed_diabetes",
            "on_insulin",
            "on_diabetes_pills",
            "family_history_diabetes",
            "ever_high_bp",
            "on_bp_medication",
            "liver_stiffness_kpa",
            "liver_steatosis_cap",
            "exam_weight",
            "fasting_weight",
        ]
    ].round(3)
    folder = out / "datasets" / "nhanes"
    write(folder, {"nhanes_2017_2018.csv": frame, "README.md": NHANES_README.format(people=f"{len(frame):,}")})
    card(
        folder,
        name="NHANES 2017-18 metabolic panel",
        description=f"{len(frame):,} US adults examined in the CDC's National Health and Nutrition Examination Survey: HbA1c, fasting glucose and insulin, kidney and liver panels, blood pressure, liver elastography, and whether they were told they have diabetes.",
        message="The adults examined in NHANES 2017-2018, its tables joined on the respondent",
    )
    return frame


NHANES_README = """# NHANES 2017-18 metabolic panel

{people} adults aged 20 or more who were examined in the National Health and Nutrition Examination
Survey 2017-2018, one row each, its tables joined on the respondent's number. CDC National Center
for Health Statistics, public domain. https://wwwn.cdc.gov/nchs/nhanes/

| Column | Meaning |
| --- | --- |
| respondent_id | SEQN, the survey's number for the person |
| age_years, sex, race_ethnicity | As reported |
| income_poverty_ratio | Family income over the poverty guideline, 5 for 5 or more |
| bmi, waist_cm | Body mass index, waist circumference |
| systolic_bp, diastolic_bp | Mean of up to three readings, mm Hg |
| hba1c_pct | Glycated hemoglobin, % |
| fasting_glucose_mg_dl, fasting_insulin_uu_ml | Morning fasting subsample only |
| creatinine_mg_dl, albumin_g_dl | Serum |
| ast_u_l, alt_u_l, ggt_u_l | Liver enzymes, U/L |
| platelets_k_ul | Platelets, 1000 per uL |
| uacr_mg_g | Urine albumin over creatinine |
| triglycerides_mg_dl | Morning fasting subsample only |
| hdl_mg_dl, total_cholesterol_mg_dl | Serum lipids |
| diagnosed_diabetes | Told by a doctor: yes, no or borderline |
| on_insulin, on_diabetes_pills, on_bp_medication | Yes or no, each asked of those it applies to |
| family_history_diabetes | A close relative has diabetes |
| ever_high_bp | Ever told of high blood pressure |
| liver_stiffness_kpa, liver_steatosis_cap | Liver elastography: median stiffness and controlled attenuation (dB/m) |
| exam_weight, fasting_weight | Survey weights |

The survey is a complex sample: to speak for the US population, weight rows by exam_weight, or by
fasting_weight where a fasting value is used. An empty value was not measured or not asked.
"""


def kidney(cache: pathlib.Path, out: pathlib.Path) -> pd.DataFrame:
    frame = pd.read_csv(io.BytesIO(fetch("kidney", cache))).rename(
        columns={
            "bp": "blood_pressure",
            "sg": "specific_gravity",
            "al": "albumin_grade",
            "su": "sugar_grade",
            "rbc": "red_blood_cells",
            "pc": "pus_cells",
            "pcc": "pus_cell_clumps",
            "ba": "bacteria",
            "bgr": "blood_glucose_random",
            "bu": "blood_urea",
            "sc": "serum_creatinine",
            "sod": "sodium",
            "pot": "potassium",
            "hemo": "hemoglobin",
            "pcv": "packed_cell_volume",
            "wbcc": "white_cell_count",
            "rbcc": "red_cell_count",
            "htn": "hypertension",
            "dm": "diabetes_mellitus",
            "cad": "coronary_artery_disease",
            "appet": "appetite",
            "pe": "pedal_edema",
            "ane": "anemia",
            "class": "diagnosis",
        }
    )
    # The source has stray tabs around a few of its words.
    words = frame.select_dtypes(exclude="number").columns
    frame[words] = frame[words].apply(lambda column: column.str.strip())
    frame.insert(0, "patient_id", range(1, len(frame) + 1))
    folder = out / "datasets" / "kidney"
    write(
        folder,
        {
            "kidney_patients.csv": frame,
            "README.md": DATA_README.format(
                title="Chronic kidney disease patients",
                what="400 patients of a hospital in India, followed for two months: blood pressure (mm Hg), urine dipstick grades, blood glucose (mg/dL), urea (mg/dL), creatinine (mg/dL), sodium and potassium (mEq/L), hemoglobin (g/dL), cell counts, comorbidities, and whether they have chronic kidney disease (diagnosis, ckd or notckd). An empty value was not recorded. It has no sex column, so equations that need one do not apply.",
                source="Rubini L, Soundarapandian P, Eswaran P. Chronic Kidney Disease, UCI Machine Learning Repository, 2015. doi:10.24432/C5G020. CC BY 4.0.",
            ),
        },
    )
    card(
        folder,
        name="Chronic kidney disease patients",
        description="400 patients of a hospital in India: urine and blood tests, comorbidities, and whether they have chronic kidney disease (UCI).",
        message="Chronic Kidney Disease, as the UCI repository has it, its columns named for what they measure",
    )
    return frame


def hepatitis_c(cache: pathlib.Path, out: pathlib.Path) -> pd.DataFrame:
    archive = zipfile.ZipFile(io.BytesIO(fetch("hepatitis-c", cache)))
    frame = pd.read_csv(io.BytesIO(archive.read("hcvdat0.csv")), index_col=0).rename(
        columns={
            "Category": "category",
            "Age": "age",
            "Sex": "sex",
            "ALB": "albumin",
            "ALP": "alkaline_phosphatase",
            "ALT": "alt",
            "AST": "ast",
            "BIL": "bilirubin",
            "CHE": "cholinesterase",
            "CHOL": "cholesterol",
            "CREA": "creatinine",
            "GGT": "ggt",
            "PROT": "protein",
        }
    )
    frame["category"] = frame["category"].str.replace(r"^\w+=", "", regex=True)
    frame.insert(0, "person_id", range(1, len(frame) + 1))
    folder = out / "datasets" / "hepatitis-c"
    write(
        folder,
        {
            "hepatitis_c.csv": frame,
            "README.md": DATA_README.format(
                title="Hepatitis C laboratory panel",
                what="615 blood donors and people with hepatitis C at Hannover Medical School: age, sex, ten laboratory values (albumin and protein in g/L; ALP, ALT, AST and GGT in U/L; bilirubin and creatinine in umol/L; cholinesterase in kU/L; cholesterol in mmol/L), and category: Blood Donor, suspect Blood Donor, Hepatitis, Fibrosis or Cirrhosis.",
                source="Lichtinghagen R, Pietsch D, Bantel H, Manns MP, Brand K, Bahr MJ. The Enhanced Liver Fibrosis (ELF) score: normal values, influence factors and proposed cut-off values. J Hepatol 2013;59(2):236-242. HCV data, UCI Machine Learning Repository, 2020. doi:10.24432/C5D612. CC BY 4.0.",
            ),
        },
    )
    card(
        folder,
        name="Hepatitis C laboratory panel",
        description="615 blood donors and people with hepatitis C: ten laboratory values and how far the liver disease has gone, from hepatitis to fibrosis to cirrhosis (UCI).",
        message="HCV data, as the UCI repository has it, its columns named for what they measure",
    )
    return frame


def biliary_cirrhosis(cache: pathlib.Path, out: pathlib.Path) -> pd.DataFrame:
    raw = pd.read_csv(io.BytesIO(fetch("biliary-cirrhosis", cache)))
    frame = pd.DataFrame(
        {
            "patient_id": raw["ID"],
            "followup_days": raw["N_Days"],
            "status": raw["Status"].map({"D": "died", "C": "alive", "CL": "transplanted"}),
            "drug": raw["Drug"],
            "age_years": (raw["Age"] / 365.25).round(1),
            "sex": raw["Sex"],
            "ascites": raw["Ascites"],
            "hepatomegaly": raw["Hepatomegaly"],
            "spiders": raw["Spiders"],
            "edema": raw["Edema"],
            "bilirubin_mg_dl": raw["Bilirubin"],
            "cholesterol_mg_dl": raw["Cholesterol"],
            "albumin_g_dl": raw["Albumin"],
            "urine_copper_ug_day": raw["Copper"],
            "alk_phos_u_l": raw["Alk_Phos"],
            "ast_u_ml": raw["SGOT"],
            "triglycerides_mg_dl": raw["Tryglicerides"],
            "platelets_k_ul": raw["Platelets"],
            "prothrombin_s": raw["Prothrombin"],
            "histologic_stage": raw["Stage"],
        }
    )
    folder = out / "datasets" / "biliary-cirrhosis"
    write(
        folder,
        {
            "biliary_cirrhosis.csv": frame,
            "README.md": DATA_README.format(
                title="Primary biliary cirrhosis trial",
                what="The 418 patients of the Mayo Clinic's trial of D-penicillamine for primary biliary cirrhosis, 1974-1984: how long each was followed (followup_days) and how it ended (died, transplanted, or alive at the end), the laboratory values at entry, and the histologic stage. edema is N for none, S for edema without diuretics or resolved by them, Y for edema despite them. The last 112 took part in the follow-up only, so their drug and some values are empty.",
                source="Dickson ER, Grambsch PM, Fleming TR, Fisher LD, Langworthy A. Prognosis in primary biliary cirrhosis: model for decision making. Hepatology 1989;10(1):1-7. Cirrhosis Patient Survival Prediction, UCI Machine Learning Repository, 2023. doi:10.24432/C5R02G. CC BY 4.0.",
            ),
        },
    )
    card(
        folder,
        name="Primary biliary cirrhosis trial",
        description="The Mayo Clinic's 418 patients with primary biliary cirrhosis: laboratory values at entry, histologic stage, and how long each survived (UCI).",
        message="Cirrhosis Patient Survival, as the UCI repository has it, age in years and columns named for what they measure",
    )
    return frame


def beta_cells(cache: pathlib.Path, out: pathlib.Path) -> pd.DataFrame:
    """The GEO dataset in long form: a row per gene and donor, probes of one gene averaged."""
    lines = gzip.decompress(fetch("beta-cells", cache)).decode().splitlines()
    condition: dict[str, str] = {}
    about = ""
    for line in lines:
        if line.startswith("!subset_description"):
            about = line.split("=", 1)[1].strip()
        elif line.startswith("!subset_sample_id"):
            for sample in line.split("=", 1)[1].split(","):
                condition[sample.strip()] = about
    begin, end = lines.index("!dataset_table_begin"), lines.index("!dataset_table_end")
    table = pd.read_csv(io.StringIO("\n".join(lines[begin + 1 : end])), sep="\t")
    samples = [column for column in table.columns if column in condition]
    # A control, or a probe with no gene, has its own name or a sequence's accession where the gene would be.
    named = (table["IDENTIFIER"] != table["ID_REF"]) & ~table["IDENTIFIER"].str.fullmatch(r"--.*|LOC\d+|[A-Z]{1,2}\d{5,8}")
    genes = table[named].groupby("IDENTIFIER")[samples].mean()
    frame = genes.reset_index().melt(id_vars="IDENTIFIER", var_name="sample", value_name="signal")
    frame = frame.rename(columns={"IDENTIFIER": "gene"})
    frame.insert(2, "condition", frame["sample"].map(condition))
    frame["signal"] = frame["signal"].round(2)
    folder = out / "datasets" / "beta-cells"
    write(
        folder,
        {
            "beta_cell_expression.csv": frame.sort_values(["gene", "sample"]),
            "README.md": DATA_README.format(
                title="Beta-cell gene expression in type 2 diabetes",
                what=f"Pancreatic beta cells laser-captured from 10 donors with type 2 diabetes and 10 without, measured on Affymetrix arrays: {genes.shape[0]:,} genes, a row per gene and donor. signal is the array's MAS5 value, averaged over the gene's probes; condition is type 2 diabetes or non-diabetic control.",
                source="Marselli L, Thorne J, Dahiya S, et al. Gene expression profiles of beta-cell enriched tissue obtained by laser capture microdissection from subjects with type 2 diabetes. PLoS One 2010;5(7):e11499. NCBI GEO GDS3782 (GSE20966).",
            ),
        },
    )
    card(
        folder,
        name="Beta-cell gene expression in T2D",
        description=f"Pancreatic beta cells of 10 donors with type 2 diabetes and 10 without: expression of {genes.shape[0]:,} genes (Marselli et al. 2010, NCBI GEO).",
        message="GEO dataset GDS3782 in long form, probes of a gene averaged",
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
    numbers = Pipeline([("fill", SimpleImputer(strategy="median")), ("scale", StandardScaler())])
    words = Pipeline(
        [
            ("fill", SimpleImputer(strategy="constant", fill_value="unknown")),
            ("onehot", OneHotEncoder(handle_unknown="ignore")),
        ]
    )
    prepare = ColumnTransformer([("numbers", numbers, numeric), ("categories", words, categories)])
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

It reads {columns}. A missing number is read as the median of the rows it was fitted on, a missing category as a category of its own.
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


def more_disease_models(panel: pd.DataFrame, patients: pd.DataFrame, people: pd.DataFrame, out: pathlib.Path) -> dict:
    """What can be learned from the population survey, the kidney patients and the hepatitis C panel."""
    undiagnosed = panel[(panel["diagnosed_diabetes"] != "yes") & panel["hba1c_pct"].notna()]
    known = people[people["category"] != "suspect Blood Donor"]
    tests = [c for c in patients.select_dtypes("number").columns if c != "patient_id"]
    answers = ["hypertension", "diabetes_mellitus", "coronary_artery_disease", "appetite", "pedal_edema", "anemia"]
    panel_values = ["albumin", "alkaline_phosphatase", "alt", "ast", "bilirubin", "cholinesterase", "cholesterol", "creatinine", "ggt", "protein"]
    return {
        "undiagnosed-diabetes": simple_classifier(
            undiagnosed,
            (undiagnosed["hba1c_pct"] >= 6.5).astype(int),
            out,
            "undiagnosed-diabetes",
            ["age_years", "bmi", "waist_cm", "systolic_bp"],
            ["sex", "family_history_diabetes", "ever_high_bp"],
            ("undiagnosed_predicted", "undiagnosed_risk"),
            name="Undiagnosed diabetes risk",
            what="Whether a US adult never told of diabetes has it unknowingly (HbA1c of 6.5% or more), from a clinic visit with no blood test. Few do, so read the risk: at a threshold of 0.5 it rarely says yes.",
        ),
        "kidney": simple_classifier(
            patients,
            (patients["diagnosis"] == "ckd").astype(int),
            out,
            "kidney",
            tests,
            answers,
            ("ckd_predicted", "ckd_risk"),
            name="Chronic kidney disease detector",
            what="Whether a patient has chronic kidney disease, from blood and urine tests and comorbidities. Fitted on 400 patients of one hospital, so treat its figures as provisional.",
        ),
        "hepatitis-c": simple_classifier(
            known,
            (known["category"] != "Blood Donor").astype(int),
            out,
            "hepatitis-c",
            ["age", *panel_values],
            ["sex"],
            ("liver_disease_predicted", "liver_disease_risk"),
            name="Hepatitis C liver disease detector",
            what="Whether someone has hepatitis C liver disease rather than being a healthy donor, from age, sex and ten laboratory values. Fitted on one centre's patients, the donors far outnumbering the sick.",
        ),
    }


def worked(module, examples: list[tuple[dict, dict]], name: str) -> None:
    """Stops if an equation disagrees with an example worked by hand."""
    for row, expected in examples:
        said = module.predict(None, pd.DataFrame([row])).iloc[0]
        for column, value in expected.items():
            if said[column] != value:
                raise SystemExit(f"{name}: {row} gives {column} {said[column]}, not {value}")


def equation(out: pathlib.Path, folder: str, file: str, name: str, what: str, reads: list, adds: list, examples: list) -> str:
    """A published equation as a model version: its file, a card, and what it reads and adds."""
    source = (EQUATIONS / file).read_bytes()
    spec = importlib.util.spec_from_file_location(file, EQUATIONS / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    worked(module, examples, name)
    target = out / "models" / folder
    write(
        target,
        {
            "model.py": source,
            "README.md": EQUATION_README.format(
                name=name,
                what=what,
                doc=module.__doc__.strip(),
                reads=", ".join(f"`{column}`" for column, _ in reads),
                adds=", ".join(f"`{column}`" for column, _ in adds),
            ),
            "contract.json": json.dumps(contract("python", "model.py", reads, adds), indent=2) + "\n",
        },
    )
    card(
        target,
        name=name,
        description=what,
        spec={"framework": "python", "format": "python", "task": "clinical equation"},
        message="The published equation, checked against an example worked by hand",
        metrics={"checked_examples": len(examples)},
    )
    return name


EQUATION_README = """# {name}

{what}

A published clinical equation, computed as written: nothing here was fitted.

{doc}

It reads {reads}, and adds {adds}. A row missing any of what it reads gets no value.
"""


def clinical_equations(out: pathlib.Path) -> list[str]:
    return [
        equation(
            out,
            "egfr",
            "ckd_epi.py",
            "CKD-EPI 2021 eGFR",
            "Estimated kidney function (eGFR, mL/min/1.73 m2) and the CKD stage it means, from age, sex and serum creatinine: the race-free equation recommended in the US since 2021.",
            [("age_years", "integer"), ("sex", "string"), ("creatinine_mg_dl", "double")],
            [("egfr", "double"), ("ckd_stage", "string")],
            [
                ({"age_years": 50, "sex": "female", "creatinine_mg_dl": 1.0}, {"egfr": 68.6, "ckd_stage": "G2"}),
                ({"age_years": 50, "sex": "male", "creatinine_mg_dl": 1.0}, {"egfr": 91.7, "ckd_stage": "G1"}),
                ({"age_years": 70, "sex": "male", "creatinine_mg_dl": 2.5}, {"egfr": 27.0, "ckd_stage": "G4"}),
                ({"age_years": 30, "sex": "female", "creatinine_mg_dl": 0.6}, {"egfr": 123.8, "ckd_stage": "G1"}),
            ],
        ),
        equation(
            out,
            "kidney-failure",
            "kfre.py",
            "Kidney failure risk (KFRE)",
            "The risk of kidney failure within two and five years for someone with an eGFR under 60, from age, sex, eGFR and the urine albumin-to-creatinine ratio: the 4-variable equation, North American calibration. Run it after CKD-EPI 2021 eGFR, which gives the eGFR it reads.",
            [("age_years", "integer"), ("sex", "string"), ("egfr", "double"), ("uacr_mg_g", "double")],
            [("kidney_failure_risk_2y", "double"), ("kidney_failure_risk_5y", "double")],
            [
                (
                    {"age_years": 60, "sex": "male", "egfr": 30.0, "uacr_mg_g": 300.0},
                    {"kidney_failure_risk_2y": 0.0863, "kidney_failure_risk_5y": 0.2456},
                ),
                (
                    {"age_years": 70, "sex": "female", "egfr": 45.0, "uacr_mg_g": 30.0},
                    {"kidney_failure_risk_2y": 0.0038, "kidney_failure_risk_5y": 0.0117},
                ),
            ],
        ),
        equation(
            out,
            "fib4",
            "fib4.py",
            "FIB-4 liver fibrosis index",
            "How likely advanced liver fibrosis is, from age, AST, ALT and platelets: under 1.3 low risk, 2.67 or more high.",
            [("age_years", "integer"), ("ast_u_l", "double"), ("alt_u_l", "double"), ("platelets_k_ul", "double")],
            [("fib4", "double"), ("fibrosis_band", "string")],
            [
                ({"age_years": 50, "ast_u_l": 40.0, "alt_u_l": 25.0, "platelets_k_ul": 200.0}, {"fib4": 2.0, "fibrosis_band": "indeterminate"}),
            ],
        ),
        equation(
            out,
            "homa",
            "homa.py",
            "HOMA insulin resistance",
            "Insulin resistance (HOMA-IR) and beta-cell function (HOMA-beta) from fasting glucose and insulin.",
            [("fasting_glucose_mg_dl", "double"), ("fasting_insulin_uu_ml", "double")],
            [("homa_ir", "double"), ("homa_beta", "double")],
            [
                ({"fasting_glucose_mg_dl": 100.0, "fasting_insulin_uu_ml": 10.0}, {"homa_ir": 2.47, "homa_beta": 97.3}),
            ],
        ),
        equation(
            out,
            "fatty-liver",
            "fatty_liver_index.py",
            "Fatty Liver Index",
            "Whether fatty liver is likely, from triglycerides, BMI, GGT and the waist: under 30 rules it out, 60 or more rules it in.",
            [("triglycerides_mg_dl", "double"), ("bmi", "double"), ("ggt_u_l", "double"), ("waist_cm", "double")],
            [("fatty_liver_index", "double"), ("fatty_liver_band", "string")],
            [
                (
                    {"triglycerides_mg_dl": 150.0, "bmi": 30.0, "ggt_u_l": 40.0, "waist_cm": 100.0},
                    {"fatty_liver_index": 75.9, "fatty_liver_band": "ruled in"},
                ),
            ],
        ),
        equation(
            out,
            "mayo-pbc",
            "mayo_pbc.py",
            "Mayo PBC risk score",
            "The prognosis of a patient with primary biliary cirrhosis, from age, bilirubin, albumin, prothrombin time and edema: the higher, the worse.",
            [("age_years", "double"), ("bilirubin_mg_dl", "double"), ("albumin_g_dl", "double"), ("prothrombin_s", "double"), ("edema", "string")],
            [("mayo_risk", "double")],
            [
                ({"age_years": 50.0, "bilirubin_mg_dl": 1.0, "albumin_g_dl": 3.5, "prothrombin_s": 10.5, "edema": "N"}, {"mayo_risk": 4.39}),
                ({"age_years": 60.0, "bilirubin_mg_dl": 5.0, "albumin_g_dl": 3.0, "prothrombin_s": 12.0, "edema": "Y"}, {"mayo_risk": 7.76}),
            ],
        ),
    ]


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
    panel = nhanes(cache, args.out)
    patients = kidney(cache, args.out)
    people = hepatitis_c(cache, args.out)
    cirrhosis = biliary_cirrhosis(cache, args.out)
    expression = beta_cells(cache, args.out)
    print(
        f"datasets: {len(team)} women, {len(encounters)} encounters, {len(frame)} patients, {len(readings)} CGM readings, "
        f"{len(panel)} NHANES adults, {len(patients)} kidney patients, {len(people)} in the hepatitis C panel, "
        f"{len(cirrhosis)} with cirrhosis, {len(expression)} expression rows"
    )
    print("onset risk", onset_risk(team, screening, args.out))
    print("readmission risk", readmission_risk(encounters, args.out))
    print("progression", progression_model(frame, args.out))
    print("more", more_models(early, indicators, retina, args.out))
    print("disease models", more_disease_models(panel, patients, people, args.out))
    print("equations", clinical_equations(args.out))
    print(
        f"written to {args.out}, models fitted with scikit-learn {sklearn.__version__}"
    )


if __name__ == "__main__":
    main()
