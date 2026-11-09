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
"""The Fatty Liver Index.

Bedogni G, Bellentani S, Miglioli L, et al. The Fatty Liver Index: a simple and accurate predictor
of hepatic steatosis in the general population. BMC Gastroenterol 2006;6:33.

    L = 0.953 ln(triglycerides) + 0.139 BMI + 0.718 ln(GGT) + 0.053 waist - 15.745
    FLI = 100 * exp(L) / (1 + exp(L))

with triglycerides in mg/dL, GGT in U/L and the waist in cm. Under 30 rules out fatty liver, 60 or
more rules it in.
"""

import numpy as np
import pandas as pd


def load(directory):
    return None


def predict(model, frame):
    linear = (
        0.953 * np.log(frame["triglycerides_mg_dl"].astype(float))
        + 0.139 * frame["bmi"].astype(float)
        + 0.718 * np.log(frame["ggt_u_l"].astype(float))
        + 0.053 * frame["waist_cm"].astype(float)
        - 15.745
    )
    index = 100 * np.exp(linear) / (1 + np.exp(linear))
    band = pd.cut(
        index,
        [0, 30, 60, np.inf],
        right=False,
        labels=["ruled out", "indeterminate", "ruled in"],
    )
    return pd.DataFrame(
        {"fatty_liver_index": index.round(1), "fatty_liver_band": band.astype(object)}
    )
