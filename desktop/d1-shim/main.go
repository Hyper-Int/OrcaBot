package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type queryPayload struct {
	SQL    string        `json:"sql"`
	Params []interface{} `json:"params"`
}

type batchPayload struct {
	Statements []queryPayload `json:"statements"`
}

type execPayload struct {
	SQL string `json:"sql"`
}

type d1Meta struct {
	Duration     float64     `json:"duration"`
	LastRowID    int64       `json:"last_row_id"`
	Changes      int64       `json:"changes"`
	ServedBy     string      `json:"served_by"`
	InternalStat interface{} `json:"internal_stats"`
}

type d1Result struct {
	Results []map[string]interface{} `json:"results"`
	Success bool                     `json:"success"`
	Meta    d1Meta                   `json:"meta"`
}

type d1ExecResult struct {
	Count    int     `json:"count"`
	Duration float64 `json:"duration"`
}

func main() {
	dbPath := getenv("D1_SQLITE_PATH", defaultDbPath())
	debugEnabled := getenv("D1_SHIM_DEBUG", "") != ""
	if err := ensureDir(dbPath); err != nil {
		log.Fatalf("failed to create db dir: %v", err)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		log.Fatalf("failed to open db: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(5 * time.Minute)

	if err := configureSQLite(db); err != nil {
		log.Fatalf("failed to configure sqlite: %v", err)
	}

	addr := getenv("D1_SHIM_ADDR", "127.0.0.1:9001")

	http.HandleFunc("/query", func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		payload, err := decodeJSON[queryPayload](r)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if debugEnabled {
			logQuery("query", payload.SQL, payload.Params)
		}

		result, err := runQuery(db, payload.SQL, payload.Params)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		result.Meta.Duration = durationMs(start)
		writeJSON(w, result)
	})

	http.HandleFunc("/batch", func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		payload, err := decodeJSON[batchPayload](r)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if debugEnabled {
			for _, stmt := range payload.Statements {
				logQuery("batch", stmt.SQL, stmt.Params)
			}
		}

		results, err := runBatch(db, payload.Statements)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		for i := range results {
			results[i].Meta.Duration = durationMs(start)
		}
		writeJSON(w, results)
	})

	http.HandleFunc("/exec", func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		payload, err := decodeJSON[execPayload](r)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if debugEnabled {
			logQuery("exec", payload.SQL, nil)
		}

		count, err := runExec(db, payload.SQL)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		writeJSON(w, d1ExecResult{Count: count, Duration: durationMs(start)})
	})

	log.Printf("D1 shim listening on %s (db: %s)", addr, dbPath)
	log.Fatal(http.ListenAndServe(addr, nil))
}

func logQuery(kind string, sql string, params []interface{}) {
	clean := strings.TrimSpace(sql)
	log.Printf("[d1-shim] %s: %s params=%d", kind, clean, len(params))
}

func runQuery(db *sql.DB, query string, params []interface{}) (d1Result, error) {
	return withRetry(func() (d1Result, error) {
		if isQueryStatement(query) {
			rows, err := db.Query(query, params...)
			if err != nil {
				return d1Result{}, err
			}
			defer rows.Close()
			cols, err := rows.Columns()
			if err != nil {
				return d1Result{}, err
			}
			results := make([]map[string]interface{}, 0)
			for rows.Next() {
				row, err := scanRow(rows, cols)
				if err != nil {
					return d1Result{}, err
				}
				results = append(results, row)
			}
			if err := rows.Err(); err != nil {
				return d1Result{}, err
			}
			return d1Result{
				Results: results,
				Success: true,
				Meta:    metaResult(0, 0),
			}, nil
		}

		result, execErr := db.Exec(query, params...)
		if execErr != nil {
			return d1Result{}, execErr
		}
		changes, _ := result.RowsAffected()
		lastID, _ := result.LastInsertId()
		return d1Result{
			Results: []map[string]interface{}{},
			Success: true,
			Meta:    metaResult(lastID, changes),
		}, nil
	})
}

func runBatch(db *sql.DB, statements []queryPayload) ([]d1Result, error) {
	if len(statements) == 0 {
		return []d1Result{}, nil
	}

	return withRetry(func() ([]d1Result, error) {
		tx, err := db.Begin()
		if err != nil {
			return nil, err
		}

		results := make([]d1Result, 0, len(statements))
		for _, stmt := range statements {
			result, err := runQueryTx(tx, stmt.SQL, stmt.Params)
			if err != nil {
				_ = tx.Rollback()
				return nil, err
			}
			results = append(results, result)
		}

		if err := tx.Commit(); err != nil {
			return nil, err
		}

		return results, nil
	})
}

func runQueryTx(tx *sql.Tx, query string, params []interface{}) (d1Result, error) {
	if isQueryStatement(query) {
		rows, err := tx.Query(query, params...)
		if err != nil {
			return d1Result{}, err
		}
		defer rows.Close()
		cols, err := rows.Columns()
		if err != nil {
			return d1Result{}, err
		}
		results := make([]map[string]interface{}, 0)
		for rows.Next() {
			row, err := scanRow(rows, cols)
			if err != nil {
				return d1Result{}, err
			}
			results = append(results, row)
		}
		if err := rows.Err(); err != nil {
			return d1Result{}, err
		}
		return d1Result{
			Results: results,
			Success: true,
			Meta:    metaResult(0, 0),
		}, nil
	}

	result, execErr := tx.Exec(query, params...)
	if execErr != nil {
		return d1Result{}, execErr
	}
	changes, _ := result.RowsAffected()
	lastID, _ := result.LastInsertId()
	return d1Result{
		Results: []map[string]interface{}{},
		Success: true,
		Meta:    metaResult(lastID, changes),
	}, nil
}

func runExec(db *sql.DB, sqlText string) (int, error) {
	if strings.TrimSpace(sqlText) == "" {
		return 0, nil
	}

	return withRetry(func() (int, error) {
		if _, err := db.Exec(sqlText); err != nil {
			return 0, err
		}

		return countStatements(sqlText), nil
	})
}

func scanRow(rows *sql.Rows, cols []string) (map[string]interface{}, error) {
	values := make([]interface{}, len(cols))
	valuePtrs := make([]interface{}, len(cols))
	for i := range values {
		valuePtrs[i] = &values[i]
	}

	if err := rows.Scan(valuePtrs...); err != nil {
		return nil, err
	}

	result := make(map[string]interface{}, len(cols))
	for i, col := range cols {
		val := values[i]
		switch typed := val.(type) {
		case []byte:
			result[col] = string(typed)
		default:
			result[col] = typed
		}
	}
	return result, nil
}

func decodeJSON[T any](r *http.Request) (T, error) {
	var payload T
	if r.Method != http.MethodPost {
		return payload, errors.New("method not allowed")
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return payload, err
	}
	return payload, nil
}

func writeJSON(w http.ResponseWriter, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	encoder := json.NewEncoder(w)
	if err := encoder.Encode(payload); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func writeError(w http.ResponseWriter, status int, err error) {
	http.Error(w, err.Error(), status)
}

func metaResult(lastRowID, changes int64) d1Meta {
	return d1Meta{
		Duration:     0,
		LastRowID:    lastRowID,
		Changes:      changes,
		ServedBy:     "desktop",
		InternalStat: nil,
	}
}

func durationMs(start time.Time) float64 {
	return float64(time.Since(start).Milliseconds())
}

func isQueryStatement(statement string) bool {
	trimmed := strings.TrimSpace(statement)
	if trimmed == "" {
		return false
	}

	upper := strings.ToUpper(trimmed)
	if strings.HasPrefix(upper, "SELECT") ||
		strings.HasPrefix(upper, "WITH") ||
		strings.HasPrefix(upper, "PRAGMA") {
		return true
	}

	return strings.Contains(upper, "RETURNING")
}

func countStatements(sqlText string) int {
	parts := strings.Split(sqlText, ";")
	count := 0
	for _, part := range parts {
		if strings.TrimSpace(part) != "" {
			count++
		}
	}
	return count
}

func configureSQLite(db *sql.DB) error {
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		return err
	}
	if _, err := db.Exec("PRAGMA busy_timeout=5000"); err != nil {
		return err
	}
	return nil
}

func withRetry[T any](fn func() (T, error)) (T, error) {
	var zero T
	const attempts = 5
	for i := 0; i < attempts; i++ {
		result, err := fn()
		if err == nil {
			return result, nil
		}
		if !isBusyError(err) || i == attempts-1 {
			return zero, err
		}
		time.Sleep(time.Duration((i+1)*75) * time.Millisecond)
	}
	return zero, errors.New("retry exhausted")
}

func isBusyError(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "SQLITE_BUSY") || strings.Contains(msg, "database is locked")
}

func ensureDir(path string) error {
	dir := filepath.Dir(path)
	return os.MkdirAll(dir, 0o755)
}

func defaultDbPath() string {
	base := getenv("D1_DATA_DIR", filepath.Join(os.Getenv("HOME"), ".orcabot", "desktop", "d1"))
	return filepath.Join(base, "controlplane.sqlite")
}

func getenv(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok && value != "" {
		return value
	}
	return fallback
}
