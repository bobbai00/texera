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

package org.apache.amber.core.tuple;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonValue;

import java.io.Serializable;
import java.net.URI;
import java.util.Objects;

/**
 * BigObjectPointer represents a pointer to a large object stored in S3.
 * The pointer is formatted as a URI: s3://bucket/path/to/object
 */
public class BigObjectPointer implements Serializable {
    
    private final String uri;
    private final transient URI parsedUri;
    
    @JsonCreator
    public BigObjectPointer(@JsonProperty("uri") String uri) {
        if (uri == null || !uri.startsWith("s3://")) {
            throw new IllegalArgumentException("BigObjectPointer URI must start with 's3://' but was: " + uri);
        }
        this.uri = uri;
        this.parsedUri = URI.create(uri);
    }
    
    @JsonValue
    public String getUri() {
        return uri;
    }
    
    public String getBucketName() {
        return parsedUri.getHost();
    }
    
    public String getObjectKey() {
        String path = parsedUri.getPath();
        return path.startsWith("/") ? path.substring(1) : path;
    }
    
    @Override
    public String toString() {
        return uri;
    }
    
    @Override
    public boolean equals(Object obj) {
        if (this == obj) return true;
        if (!(obj instanceof BigObjectPointer)) return false;
        BigObjectPointer that = (BigObjectPointer) obj;
        return Objects.equals(uri, that.uri);
    }
    
    @Override
    public int hashCode() {
        return Objects.hash(uri);
    }
}
