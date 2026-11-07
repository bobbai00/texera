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


@returns(n=int, positives=int, auc=float)
def roc_auc(
    scored: pd.DataFrame, *, label: str = "Outcome", score: str = "risk"
) -> pd.DataFrame:
    """The area under the ROC curve of a score against a 0/1 label: the chance that a random positive row scores above a random negative one, ties counting half. Rows missing either are left out."""
    d = scored[[label, score]].dropna()
    y = d[label].astype(int)
    ranks = d[score].astype(float).rank(method="average")
    positives = int(y.sum())
    negatives = len(y) - positives
    auc = (
        (ranks[y == 1].sum() - positives * (positives + 1) / 2)
        / (positives * negatives)
        if positives and negatives
        else float("nan")
    )
    return pd.DataFrame({"n": [len(y)], "positives": [positives], "auc": [float(auc)]})
