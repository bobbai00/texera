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

# BigObjectPointer - Reference to a large object stored in S3
#
# This file defines the BigObjectPointer Reference Class, which represents
# a pointer to a big object. Users receive BigObjectPointer objects in their
# R UDF code when working with BIG_OBJECT type fields.

BigObjectPointer <- setRefClass("BigObjectPointer",
    fields = list(uri = "character"),
    methods = list(
        initialize = function(uri_val) {
            if (!grepl("^s3://", uri_val)) stop(paste("Invalid S3 URI:", uri_val))
            uri <<- uri_val
        }
    )
)

# BigObjectPointerColumn - S3 class for natural table$col[i] syntax
#
# R stores object columns as list-columns (require [[i]]), but we want [i] to work
# like other columns. This S3 class overrides [ to return elements directly.

new_BigObjectPointerColumn <- function(x) {
    structure(x, class = c("BigObjectPointerColumn", "list"))
}

`[.BigObjectPointerColumn` <- function(x, i) {
    result <- unclass(x)[i]
    if (length(i) == 1) result[[1]] else new_BigObjectPointerColumn(result)
}

`[[.BigObjectPointerColumn` <- function(x, i) unclass(x)[[i]]

length.BigObjectPointerColumn <- function(x) length(unclass(x))

