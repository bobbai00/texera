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
import math

import pandas as pd

from pytexera import returns


@returns(
    group=str,
    exposed=int,
    exposed_events=int,
    unexposed=int,
    unexposed_events=int,
    odds_ratio=float,
    ci_low=float,
    ci_high=float,
)
def odds_ratio(
    table: pd.DataFrame, *, exposure: str, outcome: str, group: str = ""
) -> pd.DataFrame:
    """The odds ratio of an outcome for the rows exposed against those not, each a 0/1 or true/false column, with its 95% confidence interval by Woolf's method; 0.5 is added to every cell of a table with an empty one. With group, one row per value of that column, else one for all rows."""
    keys = table[group].astype(str) if group else pd.Series("all", index=table.index)
    rows = []
    for name, d in table.assign(_group=keys).groupby("_group"):
        x = d[exposure].astype(bool)
        y = d[outcome].astype(bool)
        a, b = int((x & y).sum()), int((x & ~y).sum())
        c, e = int((~x & y).sum()), int((~x & ~y).sum())
        cells = [a, b, c, e]
        if min(cells) == 0:
            cells = [v + 0.5 for v in cells]
        ratio = (cells[0] * cells[3]) / (cells[1] * cells[2])
        spread = 1.96 * math.sqrt(sum(1 / v for v in cells))
        rows.append(
            {
                "group": str(name),
                "exposed": a + b,
                "exposed_events": a,
                "unexposed": c + e,
                "unexposed_events": c,
                "odds_ratio": ratio,
                "ci_low": math.exp(math.log(ratio) - spread),
                "ci_high": math.exp(math.log(ratio) + spread),
            }
        )
    return pd.DataFrame(rows)
