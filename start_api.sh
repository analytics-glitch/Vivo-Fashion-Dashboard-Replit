#!/bin/bash
while true; do
    echo "$(date) Starting api_pg.py..."
    python /home/runner/workspace/api_pg.py
    echo "$(date) api_pg.py crashed, restarting in 5s..."
    sleep 5
done
