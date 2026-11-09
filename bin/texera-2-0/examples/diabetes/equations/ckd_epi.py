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
"""CKD-EPI 2021 creatinine equation: estimated kidney function without a race term.

Inker LA, Eneanya ND, Coresh J, et al. New creatinine- and cystatin C-based equations to estimate
GFR without race. N Engl J Med 2021;385:1737-1749.

    eGFR = 142 * min(Scr/k, 1)^a * max(Scr/k, 1)^-1.200 * 0.9938^age * 1.012 [if female]

with k = 0.7 for women and 0.9 for men, a = -0.241 for women and -0.302 for men, and serum
creatinine (Scr) in mg/dL. For adults.
"""

import numpy as np
import pandas as pd


def load(directory):
    return None


def predict(model, frame):
    sex = frame["sex"].str.lower().str[0]
    female = sex == "f"
    ratio = frame["creatinine_mg_dl"].astype(float) / np.where(female, 0.7, 0.9)
    egfr = (
        142
        * ratio.clip(upper=1) ** np.where(female, -0.241, -0.302)
        * ratio.clip(lower=1) ** -1.2
        * 0.9938 ** frame["age_years"].astype(float)
        * np.where(female, 1.012, 1.0)
    ).where(sex.isin(["f", "m"]))
    stage = pd.cut(
        egfr,
        [0, 15, 30, 45, 60, 90, np.inf],
        right=False,
        labels=["G5", "G4", "G3b", "G3a", "G2", "G1"],
    )
    return pd.DataFrame({"egfr": egfr.round(1), "ckd_stage": stage.astype(object)})
