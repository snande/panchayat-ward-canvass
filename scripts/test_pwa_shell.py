import unittest

import check_pwa_shell


class PwaShellTest(unittest.TestCase):
    def test_shell_meets_acceptance_criteria(self):
        self.assertEqual(check_pwa_shell.check(), [])


if __name__ == "__main__":
    unittest.main()
