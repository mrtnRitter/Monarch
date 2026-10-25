#!/usr/bin/env python3
"""Probe: download agent output files of an awork thread via temporaryFiles[].downloadUrl (read-only)."""

# ===== IMPORTS =====
import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# ===== CONFIG =====
app_name = 'probe_agent_download'
app_version = '0.1.0'
default_base_url = 'https://api.awork.com/api/v1'
token_env = 'AWORK_TOKEN'
timeout_s = 60


# ===== HTTP =====
def make_url(base_url: str, route: str) -> str:
    if route.startswith(('http://', 'https://')): return route
    base_path = urllib.parse.urlparse(base_url).path.rstrip('/')
    # downloadUrl may already contain the API base path
    if base_path and route.startswith(base_path + '/'): route = route[len(base_path):]
    return base_url.rstrip('/') + '/' + route.lstrip('/')


def request(base_url: str, token: str, route: str) -> tuple[int, bytes, str]:
    """Return (status, body, content_type). Never raises on HTTP errors."""
    req = urllib.request.Request(make_url(base_url, route), headers={'Authorization': f'Bearer {token}', 'Accept': '*/*'})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as response:
            return response.status, response.read(), response.headers.get('Content-Type', '')
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers.get('Content-Type', '')


def get_json(base_url: str, token: str, route: str):
    status, body, _ = request(base_url, token, route)
    if status != 200: sys.exit(f'GET {route} -> {status}: {body[:300].decode(errors="replace")}')
    return json.loads(body or b'null')


# ===== PROBE =====
def collect_files(messages: list[dict]) -> list[dict]:
    """temporaryFiles of all messages, deduplicated by id in stable order."""
    files = {f.get('id') or f.get('downloadUrl'): {**f, 'role': m.get('role')} for m in messages for f in m.get('temporaryFiles') or []}
    return list(files.values())


def download(base_url: str, token: str, route: str, out_dir: Path, name: str, artifact: dict | None) -> bool:
    status, body, content_type = request(base_url, token, route)
    print(f'  GET {route}\n    -> {status} {content_type} {len(body)} bytes')
    if status != 200:
        print(f'    body: {body[:300].decode(errors="replace")}')
        if status == 401: print('    hint: 401 = endpoint not released for this token type, or token invalid')
        return False
    target = out_dir / Path(name).name
    target.write_bytes(body)
    sha256 = hashlib.sha256(body).hexdigest()
    checks = {'size': artifact.get('sizeBytes') in (None, len(body)), 'sha256': (artifact.get('sha256') or sha256).lower() == sha256} if artifact else {}
    print(f'    saved: {target}  sha256={sha256}' + (f'  checks={checks}' if checks else '  (no artifact entry to compare)'))
    return all(checks.values())


# ===== MAIN =====
def main() -> int:
    parser = argparse.ArgumentParser(prog=app_name, description=__doc__)
    parser.add_argument('thread_id', help='awork agent thread id (uuid)')
    parser.add_argument('--base-url', default=default_base_url, help=f'API base URL (default: {default_base_url})')
    parser.add_argument('--out', type=Path, default=Path('probe_downloads'), help='target folder (default: ./probe_downloads)')
    args = parser.parse_args()
    token = os.environ.get(token_env)
    if not token: return print(f'Set {token_env} to an awork API key or OAuth access token.', file=sys.stderr) or 2
    args.out.mkdir(parents=True, exist_ok=True)
    print(f'{app_name} {app_version}  thread={args.thread_id}  base={args.base_url}')

    messages = get_json(args.base_url, token, f'/agents/threads/{args.thread_id}/messages') or []
    artifacts = {a.get('path'): a for a in get_json(args.base_url, token, f'/agents/threads/{args.thread_id}/artifacts') or []}
    files = collect_files(messages)
    print(f'\nmessages: {len(messages)}  temporaryFiles: {len(files)}  artifacts: {len(artifacts)}')
    for path, a in artifacts.items(): print(f'  artifact: {path}  {a.get("sizeBytes")} bytes  sha256={a.get("sha256")}')

    results = {}
    print('\n[1] download via temporaryFiles[].downloadUrl')
    for f in files:
        print(f'- {f.get("name")}  role={f.get("role")}  id={f.get("id")}  sandboxPath={f.get("sandboxPath")}  downloadUrl={f.get("downloadUrl")}')
        if not f.get('downloadUrl'): print('  no downloadUrl (uploaded file?) - skipped'); continue
        artifact = artifacts.get(f.get('sandboxPath')) or artifacts.get(f.get('id'))
        results[f['downloadUrl']] = download(args.base_url, token, f['downloadUrl'], args.out, f.get('name') or f['downloadUrl'], artifact)

    covered = {f.get('sandboxPath') for f in files} | {f.get('id') for f in files}
    rest = [p for p in artifacts if p not in covered]
    print(f'\n[2] artifacts without downloadUrl via /artifacts/download?path=  ({len(rest)})')
    for path in rest:
        route = f'/agents/threads/{args.thread_id}/artifacts/download?path={urllib.parse.quote(path, safe="")}'
        results[route] = download(args.base_url, token, route, args.out, path, artifacts[path])

    ok = sum(results.values())
    print(f'\nresult: {ok}/{len(results)} downloads ok' + ('' if results else ' (nothing to download - use a thread with agent output files)'))
    return 0 if results and ok == len(results) else 1


# ===== EXEC =====
if __name__ == '__main__':
    sys.exit(main())
