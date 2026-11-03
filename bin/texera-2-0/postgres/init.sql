-- Databases for the dev stack. The catalog's own schema is applied by its migrations.
CREATE DATABASE keycloak;
CREATE DATABASE openfga;
CREATE DATABASE lakekeeper;
-- Test suites: the catalog's Go integration tests and the engine's Iceberg JDBC catalog.
CREATE DATABASE catalog_test;
CREATE DATABASE texera_iceberg_catalog;
