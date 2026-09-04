"""Backward-compatible entrypoint for the canonical identity publisher."""
from customer_identity import main

if __name__ == "__main__":
    raise SystemExit(main())