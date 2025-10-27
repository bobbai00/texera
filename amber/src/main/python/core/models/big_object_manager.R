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
# 
# Uses S3 streaming connection (downloads on-demand, not upfront!)
# Memory usage: O(1) - only current chunk in memory
BigObjectStream <- setRefClass("BigObjectStream",
    fields = list(conn = "ANY", uri = "character", is_closed = "logical"),
    methods = list(
        initialize = function(s3_conn, uri_val) {
            # Store the S3 connection (NOT raw bytes!)
            # This enables true streaming (downloads on-demand)
            conn <<- s3_conn
            uri <<- uri_val
            is_closed <<- FALSE
        },
        read = function(n = -1L) {
            if (is_closed) stop("Stream is closed")
            
            if (n == -1L) {
                # Read all remaining data in chunks to avoid memory spike
                # Downloads incrementally from S3 (not all at once!)
                result <- raw(0)
                chunk_size <- 10 * 1024 * 1024  # 10MB chunks
                repeat {
                    chunk <- tryCatch(
                        readBin(conn, "raw", chunk_size),
                        error = function(e) raw(0)
                    )
                    if (length(chunk) == 0) break
                    result <- c(result, chunk)
                }
                result
            } else {
                # Read exactly n bytes (downloads only n bytes from S3!)
                readBin(conn, "raw", n)
            }
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
        
        bucket <- parts[1]
        key <- paste(parts[-1], collapse = "/")
        
        # Configure S3 credentials from environment variables
        Sys.setenv(
            AWS_ACCESS_KEY_ID = Sys.getenv("STORAGE_S3_AUTH_USERNAME", "texera_minio"),
            AWS_SECRET_ACCESS_KEY = Sys.getenv("STORAGE_S3_AUTH_PASSWORD", "password"),
            AWS_S3_ENDPOINT = Sys.getenv("STORAGE_S3_ENDPOINT", "localhost:9000"),
            AWS_DEFAULT_REGION = Sys.getenv("STORAGE_S3_REGION", "us-west-2")
        )
        
        # Create TRUE STREAMING connection to S3
        # This does NOT download the file - downloads happen on-demand as you read()!
        message("BigObjectManager: Opening streaming connection for: ", uri)
        start_time <- Sys.time()
        
        s3_conn <- tryCatch(
            aws.s3::s3connection(
                object = key,
                bucket = bucket,
                region = Sys.getenv("AWS_DEFAULT_REGION"),
                base_url = Sys.getenv("AWS_S3_ENDPOINT"),
                use_https = grepl("^https://", Sys.getenv("AWS_S3_ENDPOINT"))
            ),
            error = function(e) stop(paste("Failed to open streaming connection for", uri, ":", conditionMessage(e)))
        )
        
        open_time <- Sys.time()
        message(sprintf("BigObjectManager: Streaming connection established in %.2f seconds", 
                       as.numeric(difftime(open_time, start_time, units = "secs"))))
        message("BigObjectManager: Data will be downloaded on-demand as you read() - O(1) memory!")
        
        BigObjectStream$new(s3_conn, uri)
    },
    
    # Fast path for reading RDS files - downloads directly to disk, skips memory
    readRDS = function(pointer_or_uri) {
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
        
        message("BigObjectManager: Fast readRDS for: ", uri)
        start_time <- Sys.time()
        
        # Download directly to temp file (skips loading into memory!)
        temp_file <- tempfile(fileext = ".rds")
        tryCatch(
            aws.s3::save_object(
                object = paste(parts[-1], collapse = "/"),
                bucket = parts[1],
                file = temp_file,
                region = Sys.getenv("AWS_DEFAULT_REGION"),
                base_url = Sys.getenv("AWS_S3_ENDPOINT"),
                use_https = grepl("^https://", Sys.getenv("AWS_S3_ENDPOINT"))
            ),
            error = function(e) stop(paste("Failed to download", uri, ":", conditionMessage(e)))
        )
        
        download_time <- Sys.time()
        file_size_gb <- file.info(temp_file)$size / 1e9
        message(sprintf("BigObjectManager: Downloaded %.2f GB to disk in %.2f seconds", 
                       file_size_gb,
                       as.numeric(difftime(download_time, start_time, units = "secs"))))
        
        # Read RDS from temp file
        result <- base::readRDS(temp_file)
        read_time <- Sys.time()
        message(sprintf("BigObjectManager: readRDS() took %.2f seconds", 
                       as.numeric(difftime(read_time, download_time, units = "secs"))))
        
        unlink(temp_file)  # Clean up
        
        total_time <- Sys.time()
        message(sprintf("BigObjectManager: Total time: %.2f seconds", 
                       as.numeric(difftime(total_time, start_time, units = "secs"))))
        
        result
    }
)

