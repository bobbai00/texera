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

# BigObjectManager - Manager for reading big objects from S3
#
# This file defines the BigObjectManager API and BigObjectStream class.
# Users call BigObjectManager$open() in their R UDF code to read big objects.

# Load required packages
if (!require("aws.s3", quietly = TRUE)) {
    warning("Package 'aws.s3' not installed. Install with: install.packages('aws.s3')")
}

# BigObjectStream Reference Class
# Provides stream-like access to big object content
BigObjectStream <- setRefClass("BigObjectStream",
    fields = list(conn = "ANY", uri = "character", is_closed = "logical"),
    methods = list(
        initialize = function(raw_bytes, uri_val) {
            conn <<- rawConnection(raw_bytes, open = "rb")
            uri <<- uri_val
            is_closed <<- FALSE
        },
        read = function(n = -1L) {
            if (is_closed) stop("Stream is closed")
            readBin(conn, "raw", if (n == -1L) 1e9 else n)
        },
        close = function() {
            if (!is_closed) {
                base::close(conn)
                is_closed <<- TRUE
            }
        },
        finalize = function() close()
    )
)

# BigObjectManager API
# Main interface for accessing big objects from S3
BigObjectManager <- list(
    open = function(pointer_or_uri) {
        # Extract from list if needed (for backward compatibility)
        if (is.list(pointer_or_uri) && length(pointer_or_uri) == 1) {
            pointer_or_uri <- pointer_or_uri[[1]]
        }
        
        # Get URI string
        uri <- if (inherits(pointer_or_uri, "BigObjectPointer")) {
            pointer_or_uri$uri
        } else if (is.character(pointer_or_uri)) {
            pointer_or_uri
        } else {
            stop("Expected BigObjectPointer or character URI")
        }
        
        if (!grepl("^s3://", uri)) stop(paste("Invalid S3 URI:", uri))
        
        # Parse s3://bucket/key
        parts <- strsplit(sub("^s3://", "", uri), "/", fixed = TRUE)[[1]]
        if (length(parts) < 2) stop(paste("Invalid S3 URI format:", uri))
        
        # Configure S3 credentials from environment variables
        Sys.setenv(
            AWS_ACCESS_KEY_ID = Sys.getenv("STORAGE_S3_AUTH_USERNAME", "texera_minio"),
            AWS_SECRET_ACCESS_KEY = Sys.getenv("STORAGE_S3_AUTH_PASSWORD", "password"),
            AWS_S3_ENDPOINT = Sys.getenv("STORAGE_S3_ENDPOINT", "localhost:9000"),
            AWS_DEFAULT_REGION = Sys.getenv("STORAGE_S3_REGION", "us-west-2")
        )
        
        # Fetch object from S3
        raw_bytes <- tryCatch(
            aws.s3::get_object(
                object = paste(parts[-1], collapse = "/"),
                bucket = parts[1],
                region = Sys.getenv("AWS_DEFAULT_REGION"),
                base_url = Sys.getenv("AWS_S3_ENDPOINT"),
                use_https = grepl("^https://", Sys.getenv("AWS_S3_ENDPOINT"))
            ),
            error = function(e) stop(paste("Failed to open", uri, ":", conditionMessage(e)))
        )
        
        BigObjectStream$new(raw_bytes, uri)
    }
)

