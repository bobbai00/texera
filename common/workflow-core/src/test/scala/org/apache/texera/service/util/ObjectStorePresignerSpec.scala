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

package org.apache.texera.service.util

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.{URI, URLDecoder}
import java.nio.charset.StandardCharsets
import java.time.format.DateTimeFormatter
import java.time.{Duration, Instant, ZoneOffset}

/**
  * Spec for [[ObjectStorePresigner]]: what a link it signs is, read off the link. Nothing here
  * asks a store anything, and no store is at the endpoints named; `PresignedLinkObjectStoreSpec`
  * shows what a real store makes of the links.
  */
class ObjectStorePresignerSpec extends AnyFlatSpec with Matchers {

  /** The endpoint a single-node deployment's services reach the object store at. */
  private val presigner = new ObjectStorePresigner(
    new URI("http://texera-rustfs:9000"),
    "us-west-2",
    "texera_rustfs",
    "password"
  )

  /** The parameters of `url`'s query, decoded. */
  private def queryOf(url: String): Map[String, String] =
    new URI(url).getRawQuery
      .split('&')
      .map { parameter =>
        val Array(name, value) = parameter.split("=", 2)
        URLDecoder.decode(name, StandardCharsets.UTF_8) ->
          URLDecoder.decode(value, StandardCharsets.UTF_8)
      }
      .toMap

  /** The seconds `lifetime` is signed for, as the link states them. */
  private def secondsSignedFor(lifetime: Duration): Long =
    queryOf(presigner.presignGet("bucket", "key", lifetime).url)("X-Amz-Expires").toLong

  "ObjectStorePresigner" should "sign a path-style GET at the endpoint it was given" in {
    val signed = presigner.presignGet(
      "texera-dataset",
      "dataset-12/data/gdm5 a/b+c,_Zs.csv",
      Duration.ofHours(1)
    )

    // The reader's address of the store, whatever the bucket: scheme, host and port are what a
    // computing unit checks a link against before it follows it.
    val url = new URI(signed.url)
    (url.getScheme, url.getHost, url.getPort) shouldBe (("http", "texera-rustfs", 9000))
    url.getPath shouldBe "/texera-dataset/dataset-12/data/gdm5 a/b+c,_Zs.csv"
    val query = queryOf(signed.url)
    query("X-Amz-Algorithm") shouldBe "AWS4-HMAC-SHA256"
    query("X-Amz-Credential") should fullyMatch regex
      """texera_rustfs/\d{8}/us-west-2/s3/aws4_request"""
    query("X-Amz-Signature") should fullyMatch regex "[0-9a-f]{64}"
    // A bare GET uses it: the host is the only header the signature covers.
    query("X-Amz-SignedHeaders") shouldBe "host"
    // The secret key signs the link and is no part of it.
    signed.url should not include "password"
  }

  it should "leave the port out of a link to an endpoint on its scheme's own port" in {
    val aws = new ObjectStorePresigner(
      new URI("https://s3.us-west-2.amazonaws.com"),
      "us-west-2",
      "AKIAIOSFODNN7EXAMPLE",
      "secret"
    )

    val url =
      new URI(aws.presignGet("texera-dataset", "dataset-12/data/x.csv", Duration.ofHours(1)).url)

    (url.getScheme, url.getHost, url.getPort) shouldBe (("https", "s3.us-west-2.amazonaws.com", -1))
    url.getPath shouldBe "/texera-dataset/dataset-12/data/x.csv"
  }

  it should "answer, as the link's expiry, the one the link states" in {
    val before = Instant.now()
    val signed = presigner.presignGet("bucket", "key", Duration.ofHours(6))
    val after = Instant.now()

    val query = queryOf(signed.url)
    val signedAt = Instant.from(
      DateTimeFormatter
        .ofPattern("yyyyMMdd'T'HHmmss'Z'")
        .withZone(ZoneOffset.UTC)
        .parse(query("X-Amz-Date"))
    )
    signed.expiresAt shouldBe signedAt.plusSeconds(query("X-Amz-Expires").toLong)
    // Six hours from when it was signed, to the second the link names.
    signed.expiresAt should be > before.plus(Duration.ofHours(6)).minusSeconds(1)
    signed.expiresAt should be <= after.plus(Duration.ofHours(6))
  }

  it should "sign for the lifetime it is asked for, in whole seconds" in {
    secondsSignedFor(Duration.ofHours(1)) shouldBe 3600
    secondsSignedFor(Duration.ofMillis(90999)) shouldBe 90
    secondsSignedFor(ObjectStorePresigner.MinLifetime) shouldBe 60
    secondsSignedFor(ObjectStorePresigner.MaxLifetime) shouldBe 604800
  }

  it should "bring a lifetime no link can have to the nearest one it can" in {
    // A store refuses a link signed for more than seven days.
    secondsSignedFor(Duration.ofDays(30)) shouldBe 604800
    secondsSignedFor(Duration.ofSeconds(604801)) shouldBe 604800
    secondsSignedFor(Duration.ofSeconds(59)) shouldBe 60
    secondsSignedFor(Duration.ZERO) shouldBe 60
    secondsSignedFor(Duration.ofHours(-1)) shouldBe 60
  }
}
