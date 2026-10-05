#!/usr/bin/env python3
"""Local bounded route bindings. No network, persistence, retry, or pool writes.

The caller privately persists receipts and supplies its preflight scope digest.
A receipt fixes the proxy address, not the actual exit IP or upstream routing.
This helper does not reserve capacity, prove scope, or enforce a fleet-wide lease.
"""
import hashlib
import importlib.util
import math
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    'pilot_proxy', Path(__file__).with_name('dsh-pilot-proxy.py'))
_selector = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_selector)


def _time(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError('invalid timestamp or duration')
    return value


def _context(program, batch, identity, scope_sha256):
    if any(not isinstance(value, str) or not value.strip() for value in (program, batch, identity)):
        raise ValueError('program, batch and identity are required')
    if not isinstance(scope_sha256, str) or len(scope_sha256) != 64 or any(c not in '0123456789abcdef' for c in scope_sha256):
        raise ValueError('preflight scope SHA256 required')
    return {'program': program, 'batch': batch, 'identity': identity, 'scope_sha256': scope_sha256}


def issue_lease(pool_dir, *, program, batch, identity, scope_sha256, now, ttl_seconds=300):
    """Explicit new batch binding; never call this as an automatic failure fallback."""
    context = _context(program, batch, identity, scope_sha256)
    _time(now)
    _time(ttl_seconds)
    if not 0 < ttl_seconds <= 900:
        raise ValueError('lease must expire within 900 seconds')
    route = _selector.select_route(pool_dir)
    return {'version': 1, **context, 'issued_at': now, 'expires_at': now + ttl_seconds,
            'route': route}


def validate_lease(lease, pool_dir, *, program, batch, identity, scope_sha256, now):
    """Recheck original route and snapshot; a changed snapshot needs new preflight.

    This cannot prevent the pool changing after this check. The caller uses the
    returned proxy once, never reselects, and checks again before each attempt.
    """
    context = _context(program, batch, identity, scope_sha256)
    _time(now)
    if lease.get('version') != 1 or any(lease.get(k) != v for k, v in context.items()):
        raise ValueError('lease context mismatch; preflight required')
    issued, expires = _time(lease['issued_at']), _time(lease['expires_at'])
    if not issued <= now < expires or not 0 < expires - issued <= 900:
        raise ValueError('lease expired or invalid clock; no replacement')
    bound = lease['route']
    if hashlib.sha256(bound['proxy'].encode()).hexdigest() != bound['proxy_sha256']:
        raise ValueError('lease route digest mismatch')
    route = _selector.select_route(pool_dir, expected_proxy_sha256=bound['proxy_sha256'])
    if route['source_sha256'] != bound['source_sha256']:
        raise ValueError('pool snapshot changed; preflight required; no replacement')
    return route


def classify_outcome(*, phase, status=None, error=None):
    """Classify observations, never mutate health or schedule a retry.

    403 is ambiguous (authorization, policy, or blocking); do not infer a ban.
    Target denials pause the target across all routes. Proxy failures only call
    for investigation of the bound route, not automatic global blocklisting.
    """
    if phase not in ('tcp', 'connect', 'tls', 'http'):
        raise ValueError('unknown phase')
    if status is not None and (isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599):
        raise ValueError('invalid HTTP status')
    if status is not None and phase not in ('connect', 'http'):
        raise ValueError('status requires CONNECT or business HTTP phase')
    if phase == 'http' and status in (403, 429):
        category, action = ('target_rate_limit' if status == 429 else 'target_forbidden_unknown'), 'pause_target'
    elif phase == 'connect' and status == 407:
        category, action = 'proxy_auth', 'stop_route_and_check_credentials'
    elif phase == 'connect' and status is not None and status != 200:
        category, action = 'proxy_connect_rejected', 'stop_route_and_investigate'
    elif phase == 'tls' and error:
        category, action = 'tls_failure', 'stop_route_and_investigate'
    elif error:
        category, action = 'transport_or_unknown_failure', 'stop_route_and_investigate'
    elif phase == 'http' and status is not None:
        category, action = 'target_response', 'record_response'
    else:
        category, action = 'incomplete', 'stop_and_check_evidence'
    return {'category': category, 'action': action, 'auto_retry': False,
            'rotate_proxy': False, 'global_blocklist': False}
