#!/bin/bash
echo "Starting Vivo Dashboard..."

pkill -f api_pg.py 2>/dev/null
pkill -f sync_incremental.py 2>/dev/null
sleep 2

cd /home/runner/workspace

# Start API (serves both /api/* and React frontend)
python api_pg.py &
echo "API + Frontend started on port ${PORT:-8000}"
sleep 3

# Start sync
python sync_incremental.py &
echo "Sync started"

echo "All services running"
wait
