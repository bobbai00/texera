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
"""The 4-variable Kidney Failure Risk Equation, with its North American baselines.

Tangri N, Grams ME, Levey AS, et al. Multinational assessment of accuracy of equations for
predicting risk of kidney failure. JAMA 2016;315(2):164-174.

    risk = 1 - baseline ^ exp(-0.2201 (age/10 - 7.036) + 0.2467 (male - 0.5642)
                              - 0.5567 (eGFR/5 - 7.222) + 0.4510 (ln(ACR) - 5.137))

with ACR in mg/g, and a baseline of 0.9750 at two years and 0.9240 at five. It was made for people
with an eGFR under 60: for anyone else, and for an ACR of 0, the risk is left empty.
"""

import numpy as np
import pandas as pd

BASELINE_2Y, BASELINE_5Y = 0.9750, 0.9240


def load(directory):
    return None


def predict(model, frame):
    sex = frame["sex"].str.lower().str[0]
    egfr = frame["egfr"].astype(float)
    acr = frame["uacr_mg_g"].astype(float)
    score = np.exp(
        -0.2201 * (frame["age_years"].astype(float) / 10 - 7.036)
        + 0.2467 * ((sex == "m").astype(float) - 0.5642)
        - 0.5567 * (egfr / 5 - 7.222)
        + 0.4510 * (np.log(acr.where(acr > 0)) - 5.137)
    ).where(sex.isin(["f", "m"]) & (egfr < 60))
    return pd.DataFrame(
        {
            "kidney_failure_risk_2y": (1 - BASELINE_2Y**score).round(4),
            "kidney_failure_risk_5y": (1 - BASELINE_5Y**score).round(4),
        }
    )
