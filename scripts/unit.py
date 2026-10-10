#!/usr/bin/env python3
"""Run every Python regression suite in either repository test directory."""
from pathlib import Path
import unittest
import sys

# Script execution puts scripts/ on sys.path; app server packages live at root.
sys.path.insert(0, str(Path.cwd().resolve()))
suite = unittest.TestSuite()
for folder in ('test', 'tests'):
    if Path(folder).is_dir():
        suite.addTests(unittest.TestLoader().discover(folder, pattern='test_*.py'))
result = unittest.TextTestRunner(verbosity=1).run(suite)
sys.exit(not result.wasSuccessful())
