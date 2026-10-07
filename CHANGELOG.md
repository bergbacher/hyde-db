# hyde-db

## 1.0.0

### Major Changes

- c075465: First release of hyde-db. From `/// @hyde.*` annotations in a Prisma schema it generates read-only PostgreSQL views, a locked-down reader role and a Markdown description of the views for whoever reads them. Columns stay hidden unless annotated visible, and sensitive-looking names are flagged. The apply script runs in one transaction and ends with a final check that refuses every way the reader could reach table data outside the views, printing a fix that works when pasted. Supports Prisma 6 and 7, PostgreSQL 14 to 18 and Node.js 20.19+, 22.12+ and 24+, with no runtime dependencies.
