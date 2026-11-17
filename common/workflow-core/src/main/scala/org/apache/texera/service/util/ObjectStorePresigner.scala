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

import org.apache.texera.service.util.ObjectStorePresigner.{
  MaxLifetime,
  MinLifetime,
  SignedGet,
  SigningTime
}
import software.amazon.awssdk.auth.credentials.{AwsBasicCredentials, StaticCredentialsProvider}
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.s3.S3Configuration
import software.amazon.awssdk.services.s3.model.GetObjectRequest
import software.amazon.awssdk.services.s3.presigner.S3Presigner
import software.amazon.awssdk.services.s3.presigner.model.{
  GetObjectPresignRequest,
  PresignedGetObjectRequest
}

import java.net.URI
import java.time.format.DateTimeFormatter
import java.time.{Duration, Instant, ZoneOffset}

object ObjectStorePresigner {

  /** The longest a link can last: a store refuses one signed for longer (AWS Signature V4). */
  val MaxLifetime: Duration = Duration.ofDays(7)

  /** The shortest a link is made to last. */
  val MinLifetime: Duration = Duration.ofMinutes(1)

  /**
    * A presigned GET of an object.
    *
    * @param url       where the object is read from, with the signature in its query: a secret
    * @param expiresAt when the store stops honouring the link
    */
  final case class SignedGet(url: String, expiresAt: Instant)

  /** How a link's query states the second it was signed in (`X-Amz-Date`). */
  private val SigningTime =
    DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC)
}

/**
  * Signs links to the objects of an S3-compatible store: presigned GETs, each of which lets
  * whoever holds it read one object, with no credentials of their own, until it expires.
  *
  * Signing asks the store nothing. A link is made from the object's address and this signer's
  * keys alone, so one is made whether or not the object exists, and the store checks it only
  * when it is used.
  *
  * A link works only at the endpoint it was signed for, as the signature covers the host. That
  * endpoint is the address the link's reader reaches the store at, which need not be the address
  * this service reaches it at. Links are path-style, `<endpoint>/<bucket>/<key>`, so every link
  * of a store has its endpoint's scheme, host and port, whatever the bucket.
  *
  * @param endpoint  the store's endpoint, as the links' readers reach it
  * @param region    the store's region, which the signature covers
  * @param accessKey the key the links are signed with, which must be allowed to read the objects
  * @param secretKey that key's secret
  */
class ObjectStorePresigner(endpoint: URI, region: String, accessKey: String, secretKey: String) {

  private val presigner: S3Presigner = S3Presigner
    .builder()
    .endpointOverride(endpoint)
    .region(Region.of(region))
    .credentialsProvider(
      StaticCredentialsProvider.create(AwsBasicCredentials.create(accessKey, secretKey))
    )
    .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
    .build()

  /**
    * Signs a GET of object `key` of `bucket` that works for `lifetime` from now, in whole
    * seconds. A lifetime outside [[MinLifetime]] to [[MaxLifetime]] is brought to the nearer of
    * the two.
    */
  def presignGet(bucket: String, key: String, lifetime: Duration): SignedGet = {
    val signed = presigner.presignGetObject(
      GetObjectPresignRequest
        .builder()
        .signatureDuration(Duration.ofSeconds(lifetimeInBounds(lifetime).getSeconds))
        .getObjectRequest(GetObjectRequest.builder().bucket(bucket).key(key).build())
        .build()
    )
    SignedGet(signed.url().toString, expiryOf(signed))
  }

  private def lifetimeInBounds(lifetime: Duration): Duration =
    if (lifetime.compareTo(MinLifetime) < 0) MinLifetime
    else if (lifetime.compareTo(MaxLifetime) > 0) MaxLifetime
    else lifetime

  /**
    * When the store stops honouring `signed`: as many seconds as its query says it lasts
    * (`X-Amz-Expires`) after the second its query says it was signed in (`X-Amz-Date`). That is
    * the store's own reckoning, which the signer's `expiration` can be a second away from.
    */
  private def expiryOf(signed: PresignedGetObjectRequest): Instant = {
    def stated(parameter: String): String =
      signed
        .httpRequest()
        .firstMatchingRawQueryParameter(parameter)
        .orElseThrow(() => new IllegalStateException(s"The signed link has no $parameter."))
    Instant
      .from(SigningTime.parse(stated("X-Amz-Date")))
      .plusSeconds(stated("X-Amz-Expires").toLong)
  }
}
