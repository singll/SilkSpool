import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('lease', Path(__file__).with_name('dsh-pilot-proxy-lease.py'))
lease = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lease)


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.rows = [dict(host='8.8.8.8', port=8080, protocol='http', grade='elite', timeout=1)]
        self.write_pool()
        self.context = dict(program='p', batch='b', identity='anonymous', scope_sha256='a' * 64)
        self.receipt = lease.issue_lease(self.root, **self.context, now=100)

    def write_pool(self):
        (self.root / 'pool.json').write_text(json.dumps(self.rows))
        (self.root / 'live.txt').write_text('\n'.join('http://%s:%s' % (r['host'], r['port']) for r in self.rows))
        (self.root / 'blocklist.txt').write_text('')

    def validate(self, **kw):
        return lease.validate_lease(self.receipt, self.root, **dict(self.context, now=101, **kw))

    def test_private_receipt_roundtrip_and_no_pool_mutation(self):
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        self.receipt = json.loads(json.dumps(self.receipt))
        route = self.validate()
        self.assertEqual(route['proxy'], 'http://8.8.8.8:8080')
        self.assertFalse(route['exit_ip_proven'])
        self.assertFalse(route['tls_transparency_proven'])
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.iterdir()})

    def test_context_cannot_cross_program_batch_identity_or_scope(self):
        for key in self.context:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate(**{key: 'b' * 64 if key == 'scope_sha256' else 'other'})

    def test_expiry_clock_and_ttl(self):
        for now in (99, 400, float('nan'), True):
            with self.subTest(now=now), self.assertRaises(ValueError):
                lease.validate_lease(self.receipt, self.root, **self.context, now=now)
        for ttl in (0, 901, float('inf'), True):
            with self.subTest(ttl=ttl), self.assertRaises(ValueError):
                lease.issue_lease(self.root, **self.context, now=100, ttl_seconds=ttl)

    def test_removed_route_cannot_be_replaced(self):
        self.rows[0]['host'] = '1.1.1.1'
        self.write_pool()
        with self.assertRaisesRegex(ValueError, 'replacement forbidden'):
            self.validate()

    def test_snapshot_change_requires_preflight_even_when_route_survives(self):
        self.rows.append(dict(self.rows[0], host='1.1.1.1', timeout=.5))
        self.write_pool()
        with self.assertRaisesRegex(ValueError, 'snapshot changed'):
            self.validate()

    def test_blocklisted_route_stops(self):
        (self.root / 'blocklist.txt').write_text('8.8.8.8:8080')
        with self.assertRaises(ValueError):
            self.validate()

    def test_receipt_corruption_stops(self):
        self.receipt['route']['proxy'] = 'http://1.1.1.1:8080'
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            self.validate()

    def test_target_denial_never_rotates_or_globally_blames_proxy(self):
        for status in (403, 429):
            result = lease.classify_outcome(phase='http', status=status)
            self.assertEqual(result['action'], 'pause_target')
            self.assertEqual(result['category'], 'target_rate_limit' if status == 429 else 'target_forbidden_unknown')
            self.assertFalse(result['rotate_proxy'])
            self.assertFalse(result['auto_retry'])
            self.assertFalse(result['global_blocklist'])

    def test_proxy_and_tls_failures_are_distinct_from_target_denial(self):
        for args, category in [
            (dict(phase='connect', status=407), 'proxy_auth'),
            (dict(phase='connect', status=403), 'proxy_connect_rejected'),
            (dict(phase='tls', error='certificate verification'), 'tls_failure'),
            (dict(phase='tcp', error='timeout'), 'transport_or_unknown_failure'),
            (dict(phase='http', status=503), 'target_response'),
            (dict(phase='tls'), 'incomplete'),
        ]:
            result = lease.classify_outcome(**args)
            self.assertEqual(result['category'], category)
            self.assertFalse(result['rotate_proxy'])


if __name__ == '__main__':
    unittest.main()
