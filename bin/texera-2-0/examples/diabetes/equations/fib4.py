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
"""FIB-4: advanced liver fibrosis from four routine values.

Sterling RK, Lissen E, Clumeck N, et al. Development of a simple noninvasive index to predict
significant fibrosis in patients with HIV/HCV coinfection. Hepatology 2006;43(6):1317-1325.
The bands are those of Shah AG, Lydecker A, Murray K, et al. Clin Gastroenterol Hepatol
2009;7(10):1104-1112: under 1.30 low, 2.67 or more high.

    FIB-4 = age * AST / (platelets * sqrt(ALT))

with AST and ALT in U/L and platelets in 10^9/L.
"""

import numpy as np
import pandas as pd


def load(directory):
    return None


def predict(model, frame):
    fib4 = (
        frame["age_years"].astype(float)
        * frame["ast_u_l"].astype(float)
        / (frame["platelets_k_ul"].astype(float) * np.sqrt(frame["alt_u_l"].astype(float)))
    )
    band = pd.cut(
        fib4,
        [0, 1.3, 2.67, np.inf],
        right=False,
        labels=["low", "indeterminate", "high"],
    )
    return pd.DataFrame({"fib4": fib4.round(2), "fibrosis_band": band.astype(object)})
