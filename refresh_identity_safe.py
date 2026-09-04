"""Backward-compatible safe refresh entrypoint."""
from customer_identity import main

if __name__ == "__main__":
    raise SystemExit(main())