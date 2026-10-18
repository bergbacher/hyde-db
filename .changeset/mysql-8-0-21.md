---
"hyde-db": minor
---

MySQL 8.0 is supported from 8.0.21, beside 8.4 and 9.7. The generated MySQL scripts no longer use `REVOKE … IGNORE UNKNOWN USER`, which needs MySQL 8.0.30: they look the reader account up in `mysql.user` and revoke only when it exists. The drop script now reads `mysql.user`, which the deploying user already needs `SELECT` on for the apply script. The MySQL attack suite can target a running server through `MYSQL_URL`.
