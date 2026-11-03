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

package org.apache.texera.amber.storage

import org.apache.texera.amber.core.storage.FileResolver
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.io.FileNotFoundException
import java.net.URI
import java.nio.file.Files

/**
  * The engine resolves no datasets itself: the catalog hands it presigned URLs. What is left is
  * keeping a URI as is and finding a file on the unit's own disk.
  */
class FileResolverSpec extends AnyFlatSpec with Matchers {

  "FileResolver.resolve" should "keep a URI with a scheme as it is" in {
    val presigned =
      "https://storage.example.org/datasets/versions/abc/v1/iris.csv?X-Amz-Signature=x"
    FileResolver.resolve(presigned) shouldBe new URI(presigned)
    FileResolver.resolve("file:///tmp/iris.csv") shouldBe new URI("file:///tmp/iris.csv")
  }

  it should "find a file on the unit's own disk" in {
    val file = Files.createTempFile("resolver-spec", ".csv")
    try FileResolver.resolve(file.toString) shouldBe file.toUri
    finally Files.deleteIfExists(file)
  }

  it should "explain how datasets arrive when given an old dashboard path or a missing file" in {
    Seq("/dataset/bob@example.org/iris/v1/iris.csv", "/no/such/file.csv", "").foreach { name =>
      val error = the[FileNotFoundException] thrownBy FileResolver.resolve(name)
      error.getMessage should include("dataset://<rid>@<version>/<path>")
    }
  }

  "FileResolver.isFileResolved" should "accept URIs and refuse paths, including Windows drive letters" in {
    FileResolver.isFileResolved("https://example.org/f.csv") shouldBe true
    FileResolver.isFileResolved("vfs:///wid/1/eid/2/result") shouldBe true
    FileResolver.isFileResolved("/home/bob/f.csv") shouldBe false
    FileResolver.isFileResolved("C:\\data\\f.csv") shouldBe false
    FileResolver.isFileResolved("not a uri %%") shouldBe false
  }
}
