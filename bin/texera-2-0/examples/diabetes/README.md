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
| operator | ROC AUC, Risk calibration, Odds ratio, CGM metrics | The team's Python functions |
| workflow | CGM metrics per adolescent | Built with those operators |
| computing unit | Team unit | The team's own, 2 GB with pandas, numpy and scikit-learn |
| people | Alice and Bob | Alice's project, Bob on the team |

**Why the agent should pick the onset-risk model.** The file has the six columns that model reads,
it describes adult women, and its outcome is a diagnosis within five years. The readmission model
needs hospital stays, and the progression model needs blood panels of people who already have
diabetes. AUC says how well the model ranks people: 0.847 means a woman who went on to develop
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

## Start clean

`clean.py` leaves a person's space as the demo starts from. In the demo's project, what was made
after its Team unit goes: chats and their files, workflows, executions, a dataset someone kept.
Their home project is emptied, any other project they own goes whole, and they land on the demo's
project. It only says what would go until `--apply`, and other people's projects are left alone.

```bash
python3 clean.py --gw http://localhost:28088            # what would go
python3 clean.py --gw http://localhost:28088 --apply    # alice's; --user bob for someone else's
```

Run it between rehearsals; the Team unit stays up, so the next run starts at once.

## The demo

### Part 1: what the project has (signed in as alice)

Pick **Diabetes research** in the sidebar. The landing page is the project: who is in it, then its
data, models, operators, workflows, computing units and recent chats, one line each: what it is, who
can see it and who made it; each unit says its cores and memory. A name changes in place with the
pencil on its row. The chat box floats over it, so everything starts from what the team already has.
Open a model to read its card, and **Operators** to see the team's own first.

### Part 2: bring a file, and ask (still alice)

1. Attach `~/texera-diabetes/uploads/screening_cohort.csv` in the chat box, and say: *"Can you check
   what's in this data? I want to analyze it using the models in our project. Which model do you
   think works best? Please go ahead and run it."* The chat opens beside the project. The file stays the chat's: it is not a
   dataset, and no list shows it. The agent reads the file and the team's models, says which model
   fits and why, and asks where to run it.
2. Pick **Team unit** on the card. The agent says its plan and builds the pipeline; the project's
   overview gives way to the graph, left to right: data above the model, the workflow, its execution
   with the unit it ran on, the results. The button at the top right of the chat gives it the whole
   page and back. The result: AUC 0.847 on the
   154 women, and usually how well calibrated the risk is. If it stops at its recommendation, say *"Go ahead
   and apply it to this file."*
3. *"How does that compare with what has been published on models like this? Cite what you find."*
   It searches PubMed, and the graph says so.
4. *"Please keep this file as a dataset called Screening cohort."* Now it is the project's, listed
   with the rest.

### Part 3: together (a second browser, signed in as bob)

5. Bob opens the project and the chat: the new workflow and the kept dataset are there, each sees
   the other's icon and pointer on the graph, and hovering a box offers a comment, which goes into
   the chat for the agent and the others. *"Comment on auc: is this on the held-out women?"*
6. Both open that workflow. Each sees the other at the top right, and the other's pointer moving
   over the canvas with their name on it.
7. Bob adds an operator. It appears on Alice's canvas at once, and what they made goes into the next
   version in both their names.

## Without a browser

`scenario.py` attaches the file and says the three messages, answering the agent's question with the
team's unit, and prints what the agent called and answered:

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
