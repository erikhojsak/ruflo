# RuVector PostgreSQL Testing Environment

A Docker-based testing environment for the RuVector PostgreSQL Bridge feature.

## Quick Start

### 1. Start the PostgreSQL container

```bash
# From this directory
docker-compose up -d

# Or from the project root
docker-compose -f docs/ruvector-postgres/docker-compose.yml up -d
```

### 2. Verify the container is running

```bash
docker-compose ps
```

You should see:
```
NAME                STATUS              PORTS
ruvector-postgres   running (healthy)   0.0.0.0:5432->5432/tcp
```

### 3. Test the connection

```bash
# Using psql
docker exec -it ruvector-postgres psql -U claude -d claude_flow -c "SELECT version();"

# Or run our test script
./scripts/test-connection.sh
```

### 4. Initialize RuVector CLI

```bash
# Run from project root
npx claude-flow@alpha ruvector status \
  --host localhost \
  --port 5432 \
  --database claude_flow \
  --user claude
```

When prompted for password, enter: `claude-flow-test`

## Directory Structure

```
docs/ruvector-postgres/
├── README.md                 # This file
├── docker-compose.yml        # Docker services configuration
├── scripts/
│   ├── init-db.sql          # Database initialization (runs on container start)
│   ├── test-connection.sh   # Connection test script
│   ├── run-migrations.sh    # Run RuVector migrations
│   └── cleanup.sh           # Remove all data and reset
├── examples/
│   ├── basic-queries.sql    # Basic vector operations
│   ├── similarity-search.sql # Semantic search examples
│   └── attention-ops.sql    # Attention mechanism examples
└── tests/
    ├── test-vectors.ts      # TypeScript test suite
    └── benchmark.sh         # Performance benchmarks
```

## Connection Details

| Setting | Value |
|---------|-------|
| Host | `localhost` |
| Port | `5432` |
| Database | `claude_flow` |
| Username | `claude` |
| Password | `claude-flow-test` |
| Schema | `claude_flow` |

## Available Services

### PostgreSQL with pgvector

- **Container**: `ruvector-postgres`
- **Image**: `pgvector/pgvector:pg16`
- **Port**: 5432

Pre-configured with:
- pgvector extension enabled
- `claude_flow` schema created
- Sample tables (embeddings, patterns, agents)
- HNSW indices for fast similarity search
- Sample test data

### pgAdmin (Optional)

For visual database management:

```bash
# Start with pgAdmin
docker-compose --profile gui up -d
```

Access at: http://localhost:5050
- Email: `admin@claude-flow.local`
- Password: `admin`

## Common Tasks

### View sample data

```bash
docker exec -it ruvector-postgres psql -U claude -d claude_flow -c \
  "SELECT id, content, metadata FROM claude_flow.embeddings;"
```

### Run similarity search (after adding embeddings)

```bash
docker exec -it ruvector-postgres psql -U claude -d claude_flow -c \
  "SELECT * FROM claude_flow.search_similar(
    (SELECT embedding FROM claude_flow.embeddings LIMIT 1),
    5,
    0.3
  );"
```

### Check HNSW indices

```bash
docker exec -it ruvector-postgres psql -U claude -d claude_flow -c \
  "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'claude_flow';"
```

### Run all migrations

```bash
./scripts/run-migrations.sh
```

### Reset everything

```bash
./scripts/cleanup.sh
docker-compose down -v
docker-compose up -d
```

## Testing with Claude-Flow CLI

### Check status

```bash
npx claude-flow@alpha ruvector status \
  --host localhost \
  --database claude_flow \
  --user claude \
  --verbose
```

### Run migrations

```bash
npx claude-flow@alpha ruvector migrate \
  --host localhost \
  --database claude_flow \
  --user claude \
  --up
```

### Run benchmarks

```bash
npx claude-flow@alpha ruvector benchmark \
  --host localhost \
  --database claude_flow \
  --user claude \
  --iterations 100
```

### Optimize indices

```bash
npx claude-flow@alpha ruvector optimize \
  --host localhost \
  --database claude_flow \
  --user claude \
  --analyze
```

## Environment Variables

You can also use environment variables instead of CLI flags:

```bash
export PGHOST=localhost
export PGPORT=5432
export PGDATABASE=claude_flow
export PGUSER=claude
export PGPASSWORD=claude-flow-test

# Then run without connection flags
npx claude-flow@alpha ruvector status --verbose
```

## Troubleshooting

### Container won't start

```bash
# Check logs
docker-compose logs postgres

# Check if port 5432 is in use
lsof -i :5432
```

### Permission denied errors

```bash
# Reset permissions
docker exec -it ruvector-postgres psql -U claude -d claude_flow -c \
  "GRANT ALL ON SCHEMA claude_flow TO claude;"
```

### pgvector extension missing

```bash
# Manually enable
docker exec -it ruvector-postgres psql -U claude -d claude_flow -c \
  "CREATE EXTENSION IF NOT EXISTS vector;"
```

### Reset to clean state

```bash
docker-compose down -v
docker-compose up -d
```

## Learn More

- [RuVector PostgreSQL Bridge Documentation](https://github.com/ruvnet/claude-flow/issues/963)
- [ADR-027: RuVector PostgreSQL Integration](../../v3/implementation/adrs/ADR-027-ruvector-postgresql-integration.md)
- [pgvector Documentation](https://github.com/pgvector/pgvector)
