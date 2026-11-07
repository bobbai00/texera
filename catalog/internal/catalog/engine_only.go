// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

package catalog

import "fmt"

// engineOnly are the engine's operators that no workflow names: the classes that run code
// written to the engine's own interfaces, and the operators the catalog compiles a workflow
// into. Code of a project's own is a Python function under @returns, one of its operators,
// which the catalog compiles into `function`; a run reads an earlier run's rows through
// `stored` only where the catalog found its reader may see them.
var engineOnly = map[string]bool{
	"PythonUDF":                 true,
	"PythonUDFV2":               true,
	"DualInputPortsPythonUDFV2": true,
	"PythonUDFSourceV2":         true,
	"JavaUDF":                   true,
	"RUDF":                      true,
	"RUDFSource":                true,
	functionType:                true,
	storedType:                  true,
}

// engineOnlyRefusal says why a workflow may not name an engine-only operator, and what to
// write instead.
func engineOnlyRefusal(operatorID, operatorType string) error {
	why := "write the code as a Python function under @returns(...), saved as one of the project's operators, and call that"
	if operatorType == storedType {
		why = "a run reuses what an earlier run stored by itself, where the reader may see it"
	}
	return Invalid(fmt.Sprintf("operator %s: %s is the engine's own; %s", operatorID, operatorType, why),
		map[string]any{"operator": operatorID, "field": "operatorType"})
}

// refuseEngineOnly refuses a workflow spec, as saved, that names an engine-only operator.
func refuseEngineOnly(doc map[string]any) error {
	operators, _ := doc["operators"].([]any)
	for _, o := range operators {
		op, _ := o.(map[string]any)
		t, _ := op["operatorType"].(string)
		if engineOnly[t] {
			id, _ := op["operatorID"].(string)
			return engineOnlyRefusal(id, t)
		}
	}
	return nil
}
