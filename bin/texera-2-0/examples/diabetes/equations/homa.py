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
"""HOMA: insulin resistance and beta-cell function from a fasting blood sample.

Matthews DR, Hosker JP, Rudenski AS, et al. Homeostasis model assessment: insulin resistance and
beta-cell function from fasting plasma glucose and insulin concentrations in man. Diabetologia
1985;28(7):412-419.

    HOMA-IR = glucose * insulin / 405
    HOMA-beta = 360 * insulin / (glucose - 63)

with glucose in mg/dL and insulin in uU/mL. HOMA-beta has no meaning at a glucose of 63 or less,
and is left empty there.
"""

import pandas as pd


def load(directory):
    return None


def predict(model, frame):
    glucose = frame["fasting_glucose_mg_dl"].astype(float)
    insulin = frame["fasting_insulin_uu_ml"].astype(float)
    return pd.DataFrame(
        {
            "homa_ir": (glucose * insulin / 405).round(2),
            "homa_beta": (360 * insulin / (glucose - 63).where(glucose > 63)).round(1),
        }
    )
