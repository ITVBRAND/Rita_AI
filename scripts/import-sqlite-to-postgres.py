#!/usr/bin/env python3
"""One-time, transactional copy of Rita's SQLite data into PostgreSQL."""

import json
import math
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import psycopg2
from psycopg2 import sql
from psycopg2.extras import execute_values


TABLES = [
    "Project",
    "ChatBinding",
    "Ticket",
    "TicketMessage",
    "TicketLink",
    "Meta",
    "DialogueTurn",
    "TurnMemoryIndex",
    "DialogueSummary",
    "Lesson",
    "Memory",
    "SharedMemory",
]
BOOLEAN_COLUMNS = {"hasMedia", "active"}
DATETIME_COLUMNS = {"createdAt", "updatedAt", "resolvedAt", "extractedAt"}
VECTOR_COLUMNS = {
    "TurnMemoryIndex": "embedding",
    "SharedMemory": "embedding",
}


def decode_vector(raw):
    if raw is None:
        return None
    value = raw
    for _ in range(3):
        if not isinstance(value, str):
            break
        try:
            value = json.loads(value)
        except Exception:
            return None
    if not isinstance(value, list) or len(value) != 1536:
        return None
    if not all(isinstance(item, (int, float)) and math.isfinite(item) for item in value):
        return None
    return value


def database_url(path: str) -> dict[str, object]:
    values = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.startswith("DATABASE_URL="):
            values["url"] = line.partition("=")[2].strip().strip("\"'")
            break
    parsed = urlparse(str(values.get("url", "")))
    if parsed.scheme != "postgresql" or not parsed.hostname or not parsed.username or not parsed.password:
        raise RuntimeError("A valid PostgreSQL DATABASE_URL is required in the protected URL file")
    return {
        "host": parsed.hostname,
        "port": parsed.port or 5432,
        "dbname": parsed.path.lstrip("/"),
        "user": parsed.username,
        "password": parsed.password,
    }


def convert(column: str, value):
    if value is None:
        return None
    if column in BOOLEAN_COLUMNS:
        return bool(value)
    if column in DATETIME_COLUMNS and isinstance(value, (int, float)):
        seconds = value / 1000 if abs(value) > 100_000_000_000 else value
        return datetime.fromtimestamp(seconds, timezone.utc).replace(tzinfo=None)
    if column in DATETIME_COLUMNS and isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        parsed = parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def main() -> None:
    sqlite_path = os.environ.get("SQLITE_PATH", "/opt/rita/data/pm.db.pre-postgres")
    postgres_url_file = os.environ.get("POSTGRES_URL_FILE", "/opt/rita/.env.postgres")
    source = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    target = psycopg2.connect(**database_url(postgres_url_file))

    try:
        source_counts = {}
        for table in TABLES:
            source_counts[table] = source.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]

        dimensions: dict[int, int] = {}
        missing_vectors = {table: 0 for table in VECTOR_COLUMNS}
        for table, column in VECTOR_COLUMNS.items():
            for (raw,) in source.execute(f'SELECT "{column}" FROM "{table}" WHERE "{column}" IS NOT NULL'):
                vector = decode_vector(raw)
                if vector is not None:
                    dimensions[1536] = dimensions.get(1536, 0) + 1

        with target:
            with target.cursor() as cursor:
                existing = {}
                for table in TABLES:
                    cursor.execute(sql.SQL("SELECT COUNT(*) FROM {}").format(sql.Identifier(table)))
                    existing[table] = cursor.fetchone()[0]
                if any(existing.values()):
                    raise RuntimeError("Target database is not empty; refusing to import duplicate production data")

                for table in TABLES:
                    source_cursor = source.execute(f'SELECT * FROM "{table}"')
                    columns = [description[0] for description in source_cursor.description]
                    rows = source_cursor.fetchall()
                    if not rows:
                        continue
                    statement = sql.SQL("INSERT INTO {} ({}) VALUES %s").format(
                        sql.Identifier(table),
                        sql.SQL(", ").join(map(sql.Identifier, columns)),
                    )
                    values = []
                    vector_updates = []
                    for row in rows:
                        row_values = []
                        for column in columns:
                            value = row[column]
                            if column == "embedding" and table in VECTOR_COLUMNS and value is not None:
                                vector = decode_vector(value)
                                if vector is None:
                                    value = None
                                    missing_vectors[table] += 1
                                else:
                                    value = json.dumps(vector, separators=(",", ":"))
                                    vector_literal = "[" + ",".join(str(item) for item in vector) + "]"
                                    vector_updates.append((vector_literal, row["id"]))
                            row_values.append(convert(column, value))
                        values.append(tuple(row_values))
                    execute_values(cursor, statement.as_string(target), values, page_size=500)
                    if vector_updates:
                        update = sql.SQL('UPDATE {} SET "embeddingVector" = %s::vector WHERE "id" = %s').format(sql.Identifier(table))
                        cursor.executemany(update.as_string(target), vector_updates)

                target_counts = {}
                for table in TABLES:
                    cursor.execute(sql.SQL("SELECT COUNT(*) FROM {}").format(sql.Identifier(table)))
                    target_counts[table] = cursor.fetchone()[0]
                if source_counts != target_counts:
                    raise RuntimeError(f"Row-count mismatch: source={source_counts}, target={target_counts}")

        print("IMPORT_OK")
        print(f"TABLES={len(TABLES)} ROWS={sum(source_counts.values())} EMBEDDINGS={sum(dimensions.values())}")
        print(f"LEGACY_EMBEDDINGS_NEED_REINDEX={sum(missing_vectors.values())}")
    finally:
        source.close()
        target.close()


if __name__ == "__main__":
    main()
