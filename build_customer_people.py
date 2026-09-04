"""Backward-compatible entrypoint: identity and people publish together."""
from customer_identity import main

if __name__ == "__main__":
    raise SystemExit(main())