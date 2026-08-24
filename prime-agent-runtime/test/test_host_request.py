from __future__ import annotations

import asyncio
import importlib
import unittest
from unittest.mock import patch


rlm_module = importlib.import_module("rlm")


class SilentComm:
    def __init__(self, *args, **kwargs):
        self._on_msg = None

    def on_msg(self, callback):
        self._on_msg = callback

    def open(self, data=None):
        return None

    def close(self):
        return None


class HostRequestTimeoutTest(unittest.TestCase):
    def test_host_request_has_no_fail_open_when_comm_never_replies(self) -> None:
        async def run() -> None:
            with (
                patch.object(rlm_module, "Comm", SilentComm),
                patch.object(rlm_module, "_install_control_comm_handlers"),
            ):
                with self.assertRaises(TimeoutError):
                    await asyncio.wait_for(rlm_module.host_request("rlm.run", {"prompt": "stuck"}), 0.2)

        asyncio.run(run())
