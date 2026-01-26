# D1 Shim (SQLite)

Local HTTP service that emulates the D1 API using SQLite for desktop mode.

## Endpoints
- POST /query  {"sql": "...", "params": [ ... ]}
- POST /batch  {"statements": [{"sql": "...", "params": [ ... ]}, ...]}
- POST /exec   {"sql": "..."}

## Env vars
- D1_SHIM_ADDR  (default: 127.0.0.1:9001)
- D1_SQLITE_PATH (default: ~/.orcabot/desktop/d1/controlplane.sqlite)
- D1_DATA_DIR   (base dir for default sqlite path)

## Run
```
cd desktop/d1-shim
D1_SHIM_ADDR=127.0.0.1:9001 go run .
```
