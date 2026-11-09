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
"""The Mayo risk score for primary biliary cirrhosis: the final model of its authors, on 418 patients.

Dickson ER, Grambsch PM, Fleming TR, Fisher LD, Langworthy A. Prognosis in primary biliary
cirrhosis: model for decision making. Hepatology 1989;10(1):1-7.

    R = 0.0394 age + 0.8707 ln(bilirubin) - 2.533 ln(albumin) + 2.380 ln(prothrombin time) + 0.8592 edema

with bilirubin in mg/dL, albumin in g/dL and the prothrombin time in seconds. Edema is N for none,
S for edema without diuretics or resolved by them (0.5), and Y for edema despite them (1).
"""

import numpy as np
import pandas as pd

EDEMA = {"N": 0.0, "S": 0.5, "Y": 1.0}


def load(directory):
    return None


def predict(model, frame):
    risk = (
        0.0394 * frame["age_years"].astype(float)
        + 0.8707 * np.log(frame["bilirubin_mg_dl"].astype(float))
        - 2.533 * np.log(frame["albumin_g_dl"].astype(float))
        + 2.380 * np.log(frame["prothrombin_s"].astype(float))
        + 0.8592 * frame["edema"].map(EDEMA)
    )
    return pd.DataFrame({"mayo_risk": risk.round(2)})
