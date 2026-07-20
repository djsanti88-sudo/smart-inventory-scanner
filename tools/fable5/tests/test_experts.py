from __future__ import annotations

import unittest

from tools.fable5.experts import build_claude_command


class ExpertTests(unittest.TestCase):
    def test_command_is_noninteractive_read_only_fable(self) -> None:
        command = build_claude_command("security", "fable", "review")
        self.assertIn("--print", command)
        self.assertEqual(command[command.index("--agent") + 1], "security")
        self.assertEqual(command[command.index("--model") + 1], "fable")
        self.assertEqual(command[command.index("--permission-mode") + 1], "plan")
        self.assertEqual(command[command.index("--tools") + 1], "Read,Grep,Glob")
        self.assertNotIn("--dangerously-skip-permissions", command)


if __name__ == "__main__":
    unittest.main()

