# Shell resolution for bash(): pure environment-driven tests that run on every
# platform, unlike test_bash.py, which needs POSIX process groups.
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

import rlm.bash

bash_module = sys.modules["rlm.bash"]


class ShellResolutionTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch.dict(os.environ))
        os.environ.pop("PRIME_AGENT_BASH_SHELL", None)
        os.environ.pop("PRIME_AGENT_BASH_SHELL_ISSUE", None)

    def test_absolute_override_wins(self):
        shell = r"C:\Git\bin\bash.exe" if os.name == "nt" else "/opt/bin/bash"
        os.environ["PRIME_AGENT_BASH_SHELL"] = shell
        os.environ["PRIME_AGENT_BASH_SHELL_ISSUE"] = "ignored when a shell is injected"

        self.assertEqual(bash_module._shell(), shell)

    def test_relative_override_rejected(self):
        os.environ["PRIME_AGENT_BASH_SHELL"] = "bash"

        with self.assertRaises(ValueError):
            bash_module._shell()

    def test_host_issue_raises_on_every_platform(self):
        # A rejected shell setting must surface, not fall back to PATH bash.
        issue = "kernelShellPath does not exist: /opt/missing/bash"
        os.environ["PRIME_AGENT_BASH_SHELL_ISSUE"] = issue
        for posix in (True, False):
            with self.subTest(posix=posix):
                with mock.patch.object(bash_module, "_IS_POSIX", posix):
                    with mock.patch.object(bash_module.shutil, "which") as which:
                        with self.assertRaisesRegex(RuntimeError, issue):
                            bash_module._shell()
                        which.assert_not_called()

    def test_windows_without_injected_shell_raises_teaching_error(self):
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module.shutil, "which") as which:
                with self.assertRaisesRegex(RuntimeError, "PRIME_AGENT_BASH_SHELL"):
                    bash_module._shell()
                which.assert_not_called()


if __name__ == "__main__":
    unittest.main()
