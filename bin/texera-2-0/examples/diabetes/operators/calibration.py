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
import pandas as pd

from pytexera import returns


@returns(band=int, n=int, low=float, high=float, mean_risk=float, observed_rate=float)
def calibration(
    scored: pd.DataFrame,
    *,
    label: str = "Outcome",
    score: str = "risk",
    bands: int = 10,
) -> pd.DataFrame:
    """Calibration of a predicted risk: the rows in bands of equal size by their risk, and in each band the risk's range and mean next to the observed rate of the 0/1 label. A calibrated model's two columns agree."""
    d = scored[[label, score]].dropna().copy()
    d["band"] = (
        pd.qcut(
            d[score].astype(float).rank(method="first"),
            q=min(bands, len(d)),
            labels=False,
        )
        + 1
    )
    g = d.groupby("band")
    return pd.DataFrame(
        {
            "n": g.size(),
            "low": g[score].min(),
            "high": g[score].max(),
            "mean_risk": g[score].mean(),
            "observed_rate": g[label].mean(),
        }
    ).reset_index()
