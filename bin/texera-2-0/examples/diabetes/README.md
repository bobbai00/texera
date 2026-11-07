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
primary diagnosis, and how the adolescents' CGM metrics compare with the study's and with their
daily steps. It prints the tools the agent called and its answers, and writes the transcript.

```bash
python3 scenario.py                 # needs the platform's model key on the stack
python3 scenario.py --ask 3         # one question, in a new chat
```

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
