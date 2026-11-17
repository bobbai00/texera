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

package org.apache.texera.web.service

import org.apache.texera.amber.core.tuple.{Attribute, AttributeType}
import org.apache.texera.amber.operator.TestOperators
import org.apache.texera.amber.operator.udf.python.PythonUDFOpDescV2
import org.apache.texera.amber.tags.IntegrationTest

import scala.io.Source
import scala.util.Using

/**
  * [[UnitStartReadsNoPostgresSpec]] for a run whose operator is a Python process: a computing
  * unit starts a Python UDF's run without reading Postgres, and touches only the tables of the
  * run's state until the run ends.
  *
  * Tagged @IntegrationTest because it spawns a Python worker; routed to the `amber-integration`
  * CI job.
  */
@IntegrationTest
class UnitStartReadsNoPostgresIntegrationSpec
    extends UnitStartReadsNoPostgresFixture("UnitStartReadsNoPostgresIntegrationSpec") {

  override protected def firstCreatedEid: Int = 979000
  override protected def wid: Int = 9782

  /** The units sold of each order of the small sales CSV, read without the engine. */
  private lazy val unitsSoldByOrder: Map[String, Int] =
    Using.resource(Source.fromFile(TestOperators.CountrySalesSmallCsvPath)) { source =>
      val lines = source.getLines().filter(_.nonEmpty).toList
      val header = lines.head.split(",", -1).map(_.trim).toList
      lines.tail
        .map(line => header.zip(line.split(",", -1).map(_.trim)).toMap)
        .map(row => row("Order ID") -> row("Units Sold").toInt)
        .toMap
    }

  "A computing unit" should "start a scan of a CSV file and a Python UDF without reading Postgres" in {
    val udf = named(new PythonUDFOpDescV2(), "udf")
    udf.workers = 1
    udf.retainInputColumns = true
    udf.outputColumns = List(new Attribute("double units", AttributeType.INTEGER))
    udf.code = """from pytexera import *
        |
        |class ProcessTupleOperator(UDFOperatorV2):
        |    @overrides
        |    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        |        print("doubling the units of order", tuple_["Order ID"])
        |        tuple_["double units"] = tuple_["Units Sold"] * 2
        |        yield tuple_
        |""".stripMargin

    val ran = run(
      List(named(TestOperators.smallCsvScanOpDesc(), "scan"), udf),
      List(link("scan", "udf"))
    )

    assertStartedWithoutReading(ran)
    ran
      .resultOf("udf")
      .map(row =>
        row.getField[Any]("Order ID").toString -> row.getField[Int]("double units")
      ) should
      contain theSameElementsAs unitsSoldByOrder.view.mapValues(_ * 2).toList
  }
}
