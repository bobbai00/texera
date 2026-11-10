<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements.  See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership.  The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License.  You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied.  See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# A diabetes research team: the demo

## What this is about

**The domain is type 2 diabetes screening.** Diabetes often develops silently for years, so clinics
try to find people at high risk early, while lifestyle change or treatment can still prevent it.
The question a risk model answers is: from measurements taken at a routine visit, how likely is this
person to be diagnosed within the next five years?

**The story.** A research team keeps its work in one Texera project: data, models, the operators it
wrote, and a computing unit. A researcher receives a new file: women screened at a clinic, each with
routine measurements and whether she went on to develop diabetes. She wants to know what is in it,
which of the team's models suits it, and how well that model does.

**The file** is `screening_cohort.csv`, 154 women. They are real: the part of the public Pima cohort
the team's model never saw. In the demo they stand in for a new clinic's patients.

| Column | Meaning |
| --- | --- |
| Pregnancies | Number of times pregnant |
| Glucose | Blood sugar two hours into a glucose tolerance test, mg/dL |
| BloodPressure | Diastolic blood pressure, mm Hg |
| SkinThickness, Insulin | Triceps skinfold (mm), two-hour insulin (mu U/ml) |
| BMI | Body mass index |
| DiabetesPedigreeFunction | A score of diabetes in the family |
| Age | Years |
| Outcome | 1 if diabetes was diagnosed within five years, else 0 |

A 0 in Glucose, BloodPressure, SkinThickness, Insulin or BMI means the measurement was not taken.

**What the team has.**

| Kind | Name | What it is |
| --- | --- | --- |
| dataset | Pima diabetes cohort | 614 Pima women (NIDDK): the measurements above and diabetes within five years |
| dataset | Hospital diabetes encounters | 101,766 inpatient encounters at 130 US hospitals, 1999-2008 (UCI, CC BY 4.0): HbA1c testing, medications, diagnoses, readmission |
| dataset | Diabetes progression | 442 patients (Efron et al. 2004): ten baseline measurements and how the disease progressed a year later |
| dataset | Adolescent T1D CGM | A week of 5-minute glucose readings of seven adolescents with type 1 diabetes (Cronin et al. 2024, CC BY-NC 4.0) |
| model | Diabetes onset risk | Who is likely to develop diabetes within five years, from six routine measurements; AUC 0.847 on women it never saw |
| model | 30-day readmission risk | Whether a hospital patient with diabetes comes back within 30 days; AUC 0.663 |
| model | Progression regressor | How far the disease of someone who already has it will progress in a year; R2 0.407 |
| dataset | Early-stage diabetes symptoms | 520 hospital patients: 14 symptoms from a questionnaire and the diagnosis (UCI) |
| dataset | CDC diabetes health indicators | 20,000 US adults of the CDC's 2015 survey: 21 health indicators (UCI) |
| dataset | Diabetic retinopathy features | 1,151 retinal images: features of each and signs of retinopathy (UCI) |
| model | Early-stage symptom screen | Diabetes from a symptom questionnaire; AUC 0.992 |
| model | Survey health-indicator risk | Diabetes or prediabetes from a telephone survey; AUC 0.806 |
| model | Retinopathy signs classifier | Signs of retinopathy from image features; AUC 0.799 |
| dataset | NHANES 2017-18 metabolic panel | 5,265 US adults of the CDC's national survey: HbA1c, fasting glucose and insulin, kidney and liver panels, elastography, diagnosed diabetes (public domain) |
| dataset | Chronic kidney disease patients | 400 hospital patients: blood and urine tests, comorbidities, the diagnosis (UCI) |
| dataset | Hepatitis C laboratory panel | 615 donors and patients: ten laboratory values, the stage of liver disease (UCI) |
| dataset | Primary biliary cirrhosis trial | The Mayo Clinic's 418 patients: values at entry, histologic stage, survival (UCI) |
| dataset | Beta-cell gene expression in T2D | Laser-captured beta cells of 10 donors with type 2 diabetes and 10 without: 19,534 genes (NCBI GEO) |
| model | CKD-EPI 2021 eGFR | Published equation: kidney function and CKD stage from age, sex and creatinine |
| model | Kidney failure risk (KFRE) | Published equation: two- and five-year risk for an eGFR under 60; reads what CKD-EPI adds |
| model | FIB-4 liver fibrosis index | Published equation: advanced fibrosis from age, AST, ALT and platelets |
| model | HOMA insulin resistance | Published equation: HOMA-IR and HOMA-beta from fasting glucose and insulin |
| model | Fatty Liver Index | Published equation: fatty liver from triglycerides, BMI, GGT and waist |
| model | Mayo PBC risk score | Published equation: prognosis in primary biliary cirrhosis |
| model | Undiagnosed diabetes risk | Fitted on NHANES: diabetes nobody has told the person of, from a visit with no blood test; AUC 0.722 |
| model | Chronic kidney disease detector | Fitted on the kidney patients; AUC 1.0 on 80 rows, so provisional |
| model | Hepatitis C liver disease detector | Fitted on the hepatitis C panel; AUC 0.999 on 122 rows, so provisional |
| operator | ROC AUC, Risk calibration, Odds ratio, CGM metrics | The team's Python functions |
| workflow | CGM metrics per adolescent | Built with those operators |
| workflow | Fourteen summaries | One over each of the other main datasets, by a column that matters; five go through the team's models, such as kidney function of US adults by CKD stage |
| computing unit | Public unit | Shared by everyone on the deployment and ready now; the project keeps no unit of its own, and whoever runs a model picks Small, Medium or Large when they want one |
| people | Alice and Bob | Alice's project, Bob on the team |

**Why the agent should pick the onset-risk model.** The file has the six columns that model reads,
it describes adult women, and its outcome is a diagnosis within five years. The readmission model
needs hospital stays, the progression model needs blood panels of people who already have diabetes,
and the rest read columns this file does not have. AUC says how well the model ranks people: 0.847 means a woman who went on to develop
diabetes gets a higher risk than one who did not about 85% of the time. Calibration says whether a
risk of 30% really means about 30 in 100.

## Set it up

```bash
# The data and the models: downloads from the sources' own sites, fits with scikit-learn.
# The scikit-learn version must be the one the computing units run (1.7.2).
uv venv ~/texera-diabetes-prep && VIRTUAL_ENV=~/texera-diabetes-prep uv pip install pandas scikit-learn==1.7.2 joblib openpyxl
~/texera-diabetes-prep/bin/python prepare.py --out ~/texera-diabetes

# Into a running stack, as alice, with bob on the team (the standard library is enough).
python3 load.py --data ~/texera-diabetes --gw http://localhost:28088
```

A folder `brand/` in the data folder gives the project a look of its own: `brand.json` with a `name`
and a `description`, `logo-small.png` and `logo-large.png`. `load.py` makes the project wear it and
its chats run the platform's agent under that name; `--sign-in-page` gives the whole deployment the
look as well, the sign-in page included. The identity provider's own form takes its logo from
`TEXERA2_LOGIN_LOGO` when `k8s.sh up` runs, and its title from the realm's display name.

## Check what was loaded

`verify.py` checks the project on a stack against the folder it came from, and runs what it holds,
without asking a model anything. Every dataset, model and operator is there, and every file reads
back as the folder's bytes. Every workflow executes on the project's unit and keeps rows. A unit
made from the Small profile starts, runs one of them to the same rows, and ends. The teammate
reads the project, an execution's lineage names the data and the model it read, and the project
wears the folder's brand. With `--against` the same workflows are executed on a second stack and
the rows compared, which is how a new deployment is checked against one known to be right. Its
executions and its unit are removed again.

```bash
python3 verify.py --data ~/texera-diabetes --gw http://localhost:28088
python3 verify.py --data ~/texera-diabetes --gw https://texera.example.edu --against http://localhost:28088
```

## Start clean

`clean.py` leaves a person's space as the demo starts from. In the demo's project, what `load.py`
did not put there goes: chats and their files, workflows, executions, a dataset someone kept.
Their home project is emptied, any other project they own goes whole, and they land on the demo's
project. It only says what would go until `--apply`, and other people's projects are left alone.

```bash
python3 clean.py --gw http://localhost:28088            # what would go
python3 clean.py --gw http://localhost:28088 --apply    # alice's; --user bob for someone else's
```

Run it between rehearsals; a unit made during the demo stops and goes with the rest.

## The demo

### Part 1: what the project has (signed in as alice)

Pick **Diabetes research** in the sidebar. The new-chat page is the project at a glance: its logo, and
four cards that roll through its datasets, models, workflows and recent chats, with the chat box under
them; a card stands still while you point at it, and a click opens what it shows. The project's own
page has the whole list, one line each, with whose each thing is; each unit says its cores and memory.
Open a model to read its card, and **Operators** to see the team's own first.

### Part 2: what there is, and an inference (still alice)

1. *"What models do we have for screening people for diabetes?"* Each comes back as a card, and the
   chat names itself within a couple of seconds.
2. *"What data do we have on US adults that I could use one of them on?"* Cards again.
3. Press **+** on **Undiagnosed diabetes risk** and on **NHANES 2017-18 metabolic panel**: each card
   is marked and stands in the box. Say: *"Build a workflow that applies this model to this dataset.
   I want to know how many people it flags as high risk, and whether that agrees with their HbA1c."*
4. The agent asks where it runs: the **Public unit**, shared and ready now, or **Small**, **Medium**
   or **Large**, whichever can start here, as a unit of your own. Pick **Small**. The agent makes the
   unit, says its plan, builds the pipeline and runs it. The project's overview gives way to the
   graph, left to right: data above the model, the workflow, its execution with the unit it ran on,
   the results.

### Part 3: together (a second browser, signed in as bob)

5. Alice presses **Share** at the top of the chat and adds Bob. Bob finds it under **Shared with me**:
   the whole chat, the cards and the results. Each sees the other's icon and pointer on the graph,
   and hovering a box offers a comment, which goes into the chat for the agent and the others.
6. Bob asks: *"What share of these people does it put above a 20% risk?"* Alice sees his words as he
   sends them and that it is his turn; the answer arrives on both screens. A note from Alice goes
   to Bob without asking the agent.
7. Both open the workflow the agent built. Each sees the other at the top right, and the other's
   pointer moving over the canvas with their name on it. Bob adds an operator: it appears on
   Alice's canvas at once, and what they made goes into the next version in both their names.

### Bring a file (either of them)

8. Attach `~/texera-diabetes/uploads/screening_cohort.csv` in the chat box of a new chat, and say:
   *"Can you check what's in this data? I want to analyze it using the models in our project. Which
   model do you think works best? Please go ahead and run it."* The file stays the chat's: it is not
   a dataset, and no list shows it. The agent says which model fits and why, and asks where to run
   it. Pick **Public unit**: AUC 0.847 on the 154 women, and usually how well calibrated the risk is.
9. *"How does that compare with what has been published on models like this? Cite what you find."*
   It searches PubMed, and the graph says so.
10. *"Please keep this file as a dataset called Screening cohort."* Now it is the project's, listed
    with the rest.

## Without a browser

`scenario.py` attaches the file and says the three messages, answering the agent's question with a
Small unit, and prints what the agent called and answered:

```bash
python3 scenario.py --data ~/texera-diabetes --gw http://localhost:28088
```

`frontend-next/e2e/diabetes.spec.ts` runs the whole demo, in two browsers, through the real model,
in a project of its own (`TEXERA_DIABETES_DATA` says where the prepared files are).
`tests/e2e/test_diabetes.py` runs Part 2 as a scenario.

## Sources

- Smith JW, Everhart JE, Dickson WC, Knowler WC, Johannes RS. Using the ADAP learning algorithm to
  forecast the onset of diabetes mellitus. Proc Annu Symp Comput Appl Med Care 1988:261-265.
- Strack B, DeShazo JP, Gennings C, et al. Impact of HbA1c measurement on hospital readmission
  rates: analysis of 70,000 clinical database patient records. BioMed Research International
  2014:781670. doi:10.1155/2014/781670. Data: UCI Machine Learning Repository, CC BY 4.0.
- Efron B, Hastie T, Johnstone I, Tibshirani R. Least angle regression. Annals of Statistics
  2004;32(2):407-499.
- Cronin A, Dunne T, O'Gorman C, Cremona A. Supplemental data for: Mapping lifestyle factors in
  blood glucose variability in adolescents with type 1 diabetes mellitus, a pilot study.
  University of Limerick, 2024. Zenodo, doi:10.5281/zenodo.13749141. CC BY-NC 4.0.
