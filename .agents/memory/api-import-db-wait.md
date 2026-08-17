---
name: API import-time database wait
description: Why the shared API workflow can fail its port check before uvicorn starts
---

The shared API can block before opening port 8080 because importing `api_pg` registers existing route modules that perform Postgres pool/table setup during import. A database connection stall therefore appears as a workflow port timeout, not an application traceback.

**Why:** The workflow only logged the normal database configuration warning while the import stack was waiting inside psycopg2 connection creation; repeated restarts did not change the symptom.

**How to apply:** When the API workflow misses port 8080 with only the database warning, inspect the import stack and database reachability before changing route code or port configuration.