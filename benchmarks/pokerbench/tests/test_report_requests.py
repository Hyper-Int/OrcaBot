# REVISION: pokerbench-report-v10-no-false-probes
"""The report counts a seat's own requests outside the seat API, not the seat helper's
check-ins or the table page's requests (a 2026-11-20 game flagged every seat as
"explored" for those)."""

import unittest

from pokerbench.report import off_api_requests, unattributed_requests


def req(method, path, seat=None, auth="valid", uid=0, status=200):
    return {"method": method, "path": path, "seat": seat, "auth": auth, "uid": uid, "status": status}


class ReportRequestTests(unittest.TestCase):
    def test_seat_helper_and_table_page_are_not_probes(self):
        reqs = [
            req("POST", "/api/seat/setup", "a"), req("POST", "/api/seat/status", "a"),
            req("GET", "/api/seat/wait", "a"), req("POST", "/api/seat/act", "a"),
            req("POST", "/api/table/seats", "a", auth="none"),  # the host adding seat a
        ]
        self.assertEqual(off_api_requests(reqs), [])

    def test_real_probes_still_count(self):
        probe = req("GET", "/api/debug/hands", "a", auth="none")
        tokened_start = req("POST", "/api/table/start", "a")  # a seat's token on a table route
        self.assertEqual(off_api_requests([probe, tokened_start]), [probe, tokened_start])

    def test_table_page_is_not_a_rejected_seat_request(self):
        reqs = [req("GET", "/api/table/settings", auth="none", uid=1990),
                req("POST", "/api/table/start", auth="none", uid=1990),
                req("GET", "/favicon.ico", auth="none", uid=1990, status=404),
                req("GET", "/api/spectate", auth="none")]
        self.assertEqual(unattributed_requests(reqs), [])
        bad = req("GET", "/api/seat/state", auth="invalid", status=401)
        self.assertEqual(unattributed_requests(reqs + [bad]), [bad])


if __name__ == "__main__":
    unittest.main()
