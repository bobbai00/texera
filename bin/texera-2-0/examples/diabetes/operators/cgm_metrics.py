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
import numpy as np
import pandas as pd

from pytexera import returns

MGDL_PER_MMOL = 18.018


@returns(
    participant=str,
    readings=int,
    days=float,
    coverage_pct=float,
    mean_glucose=float,
    sd_glucose=float,
    cv_pct=float,
    gmi_pct=float,
    time_in_range_pct=float,
    time_below_70_pct=float,
    time_below_54_pct=float,
    time_above_180_pct=float,
    time_above_250_pct=float,
)
def cgm_metrics(
    readings: pd.DataFrame,
    *,
    subject: str = "participant",
    glucose: str = "glucose_mmol",
    unit: str = "mmol/L",
    interval_minutes: int = 5,
) -> pd.DataFrame:
    """The international consensus CGM metrics per participant (Battelino et al., Diabetes Care 2019): mean glucose in the readings' unit with its SD and CV, the glucose management indicator, and the share of readings in range (70 to 180 mg/dL, 3.9 to 10.0 mmol/L), below 70 and 54 mg/dL, and above 180 and 250 mg/dL. Coverage is the readings against one every interval over the days they span."""
    to_mgdl = MGDL_PER_MMOL if unit == "mmol/L" else 1.0
    rows = []
    for who, group in readings.groupby(subject):
        g = group[glucose].astype(float).dropna()
        mgdl = g * to_mgdl
        taken = pd.to_datetime(group["taken_at"])
        span = (
            (taken.max() - taken.min()).total_seconds() / 86400
            if len(taken) > 1
            else 0.0
        )
        expected = span * 24 * 60 / interval_minutes + 1
        mean = float(g.mean())
        rows.append(
            {
                "participant": str(who),
                "readings": int(len(g)),
                "days": round(span, 2),
                "coverage_pct": 100 * len(g) / expected if expected > 0 else np.nan,
                "mean_glucose": mean,
                "sd_glucose": float(g.std()),
                "cv_pct": 100 * float(g.std()) / mean if mean else np.nan,
                "gmi_pct": 3.31 + 0.02392 * float(mgdl.mean()),
                "time_in_range_pct": 100 * float(((mgdl >= 70) & (mgdl <= 180)).mean()),
                "time_below_70_pct": 100 * float((mgdl < 70).mean()),
                "time_below_54_pct": 100 * float((mgdl < 54).mean()),
                "time_above_180_pct": 100 * float((mgdl > 180).mean()),
                "time_above_250_pct": 100 * float((mgdl > 250).mean()),
            }
        )
    return pd.DataFrame(rows)
