-- Run ONCE as a PostgreSQL superuser, then create the database owned by erp_owner.
-- CHANGE THESE PASSWORDS. erp_owner runs migrations only; erp_app is what the web app uses.
CREATE ROLE erp_owner LOGIN PASSWORD 'change-me-owner' CREATEDB;
CREATE ROLE erp_app   LOGIN PASSWORD 'change-me-app' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE erp OWNER erp_owner;
