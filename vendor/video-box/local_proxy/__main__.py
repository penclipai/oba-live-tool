try:
    from .server import main
except ImportError:
    from local_proxy.server import main


if __name__ == "__main__":
    raise SystemExit(main())
