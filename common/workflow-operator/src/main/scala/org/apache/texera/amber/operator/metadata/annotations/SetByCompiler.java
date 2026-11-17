/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

package org.apache.texera.amber.operator.metadata.annotations;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a descriptor property that the compiler sets when it makes a plan, and a user never
 * does: what the plan fixes for the operator's executor, such as a limit of the site's as it
 * stood when the plan was made, or the links the executor reads its files through. The property
 * is optional, absent until a compile sets it. The compiler replaces whatever value it arrived
 * with. The operator's schema leaves it out
 * ({@code OperatorMetadataGenerator.generateOperatorJsonSchema}), so no editor shows it, and so
 * does the logical plan kept beside an execution's plan ({@code LogicalPlanPojo.asSent}).
 */
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.FIELD})
public @interface SetByCompiler {
}
