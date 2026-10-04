import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('pilot', Path(__file__).with_name('dsh-pilot-proxy.py'))
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


class RouteTests(unittest.TestCase):
    def select(self, rows, live=None, blocked=''):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)
            (p / 'pool.json').write_text(json.dumps(rows))
            (p / 'live.txt').write_text(live if live is not None else '\n'.join('http://%s:%s' % (r['host'], r['port']) for r in rows))
            (p / 'blocklist.txt').write_text(blocked)
            before = {f.name: f.read_bytes() for f in p.iterdir()}
            result = pilot.select_route(p)
            self.assertEqual(before, {f.name: f.read_bytes() for f in p.iterdir()})
            return result

    def row(self, **kw):
        return dict(dict(host='8.8.8.8', port=8080, protocol='http', grade='elite', timeout=1), **kw)

    def test_deterministic_readonly_selection(self):
        rows = [self.row(), self.row(host='1.1.1.1', timeout=.5)]
        a = self.select(rows)
        self.assertEqual(a['proxy'], 'http://1.1.1.1:8080')
        self.assertEqual(a['proxy'], self.select(rows[::-1])['proxy'])
        self.assertFalse(a['exit_ip_proven'])
        self.assertFalse(a['tls_transparency_proven'])

    def test_ineligible_and_untrusted_routes(self):
        for patch in [dict(host='127.0.0.1'), dict(host='224.0.0.1'), dict(host='proxy.example'),
                      dict(protocol='socks5'), dict(grade='unknown'), dict(username='u'),
                      dict(password='secret'), dict(port=True), dict(timeout=float('nan'))]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.select([self.row(**patch)])

    def test_membership_and_blocklist(self):
        for live, blocked in [('', ''), (None, '8.8.8.8:8080 # denied'), (None, 'http://8.8.8.8:8080')]:
            with self.subTest(blocked=blocked), self.assertRaises(ValueError):
                self.select([self.row()], live, blocked)

    def test_no_route_fails_closed(self):
        with self.assertRaises(ValueError):
            self.select([])


if __name__ == '__main__':
    unittest.main()
