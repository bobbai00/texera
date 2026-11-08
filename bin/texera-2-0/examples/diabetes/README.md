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

# A diabetes research team's project

A project a diabetes team keeps in Texera, from public data: what it holds, so that a scientist
can ask the Texera Agent what the team has, what it can do with it, and then do it.

| Kind | Name | What it is |
| --- | --- | --- |
| dataset | Pima diabetes cohort | 768 Pima women (NIDDK): eight clinical measurements and diabetes within five years; a 0 is a measurement not taken |
| dataset | Hospital diabetes encounters | 101,766 inpatient encounters at 130 US hospitals, 1999-2008 (UCI, CC BY 4.0): HbA1c testing, medications, ICD-9 diagnoses, readmission |
| dataset | Diabetes progression | 442 patients (Efron et al. 2004): ten baseline measurements and disease progression a year later |
| dataset | Adolescent T1D CGM | A week of 5-minute CGM of seven adolescents with type 1 diabetes, with their characteristics, activity and diet (Cronin et al. 2024, CC BY-NC 4.0) |
| model | Diabetes onset risk | Logistic regression for diabetes within five years, fitted on 614 of the Pima women; held-out AUC 0.847 |
| model | 30-day readmission risk | Logistic regression for readmission within 30 days, split by patient; held-out AUC 0.663 against a base rate of 0.115 |
| model | Progression regressor | Ridge regression of progression a year after baseline; held-out R2 0.407 |
| operator | CGM metrics | The consensus CGM metrics per participant: mean glucose, SD, CV, GMI, time in, below and above range |
| operator | ROC AUC | The area under the ROC curve of a score against a 0/1 label |
| operator | Risk calibration | Observed rates against predicted risk in bands of equal size |
| operator | Odds ratio | The odds ratio of an outcome between exposed and unexposed rows, with its 95% CI, overall or by group |

Each model version carries its contract (the columns it reads and adds), a model card
(README.md) and holdout.csv, the rows it never saw. The operators are the Python functions in
`operators/`, which the catalog reads into operators: their parameters are their inputs and
settings, `@returns` their columns.

## Make it

```bash
# The data and the models: downloads from the sources' own sites, fits with scikit-learn.
# The scikit-learn version must be the one the computing units run (the dev stack's: 1.7.2).
uv venv /tmp/diabetes-prep && VIRTUAL_ENV=/tmp/diabetes-prep uv pip install pandas scikit-learn==1.7.2 joblib openpyxl
/tmp/diabetes-prep/bin/python prepare.py --out ~/texera-diabetes

# Into a running stack, as alice, with bob on the team (the standard library is enough).
python3 load.py --data ~/texera-diabetes
```

Then open a chat in the project "Diabetes research", as bob, and ask what the team has, or let
`scenario.py` ask: what the project has, what could be learned from it, whether the onset model
holds up on the women it never saw, whether HbA1c testing goes with fewer readmissions by
primary diagnosis, how the adolescents' CGM metrics compare with the study's and with their
daily steps, and, citing the international consensus on time in range, how many of the
adolescents meet its target. It prints the tools the agent called and its answers, then what the chat's
graph holds and the outside sources it consulted (PubMed through biomcp), and writes the
transcript.

```bash
python3 scenario.py                 # needs the platform's model key on the stack
python3 scenario.py --ask 3         # one question, in a new chat
```

## Screening a cohort: data in, a model run, the graph

A researcher new to the team works through the agent, one message at a time, in a chat in
"Diabetes research" (or any project with the team's onset-risk model and its ROC AUC and Risk
calibration operators):

1. *"I study type 2 diabetes and I'm new to this team. What tools does this platform give me:
   data, models, operators, and where my work can run?"* The agent lists the operators by group
   (the team's own among them), the models, the profiles that can start here and the outside
   sources it can read, such as PubMed. It makes nothing.
2. *"Please get the Pima Indians diabetes data from
   https://raw.githubusercontent.com/plotly/datasets/master/diabetes.csv and put it into a new
   dataset called 'Pima cohort'."* The agent says its plan, makes the dataset and has the
   catalog fetch the file itself (`import_dataset_file`: the bytes never pass through the chat,
   and only public https addresses are fetched), commits version 1 with its source, and reads the
   header back. The project already holds a curated copy with a patient_id; this is the public
   file as published.
3. *"Now screen every woman in the Pima cohort with our diabetes onset-risk model: how well does
   its risk separate the women who developed diabetes from those who did not, and is it
   calibrated? Use the team's ROC AUC and Risk calibration operators."* The agent reads the
   model's contract and card, and before anything runs asks where: the deployment's unit, or a
   unit of the researcher's own from the profiles that can start here, Small or Large; it says
   when the deployment has no GPU.
4. Pick **Small** on the question's card. The agent makes a unit from Small (on a cluster a pod
   of 2 CPUs and 4 GB, on Compose the deployment's own unit with Small's packages), builds the
   workflow (the cohort, `predict` with the model, the two operators), runs it on that unit and
   reports. The graph left of the chat shows the Pima cohort read by the workflow, the model and
   the team's operators on the workflow's card, the workflow inside the Small unit's frame, and
   the two tables it made. Double-click the workflow to see its steps, each table level with the
   step that made it.

The model scores the women it was fitted on, so its card calls the AUC optimistic, and so should
the agent. The profiles pin scikit-learn to the version the models are fitted with (1.7.2): a
model saved with joblib does not load in a scikit-learn much newer than the one that saved it.

Two tests run the same, through the real model, each in a project of its own with the model
fitted on the public file: `tests/e2e/test_diabetes.py` (a scenario, `--model`) and
`frontend-next/e2e/diabetes.spec.ts` (in the app, clicking Small on the card).

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
- Battelino T, Danne T, Bergenstal RM, et al. Clinical targets for continuous glucose monitoring
  data interpretation: recommendations from the international consensus on time in range.
  Diabetes Care 2019;42(8):1593-1603.
