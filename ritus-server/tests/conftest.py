"""
Pytest picks this up automatically for any test run rooted at or above
tests/. It puts ritus-server/ (the parent of this file) on sys.path so
`import multi_column_layout` / `import layout_parser_preprocessing` resolve
regardless of the current working directory or how pytest was invoked.

The individual test files also do this themselves (so they keep working
when run directly with `python3 test_x.py`, not just under pytest) - this
conftest is just a second safety net for pytest-based runs.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
