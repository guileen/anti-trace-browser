#!/usr/bin/env python3
"""Capture the official AmIUnique page in an isolated, visible Camoufox profile."""
from __future__ import annotations

import argparse
import asyncio
import importlib.metadata
import json
import os
import re
from pathlib import Path
import sys
import time
import uuid

from setup_camoufox import ROOT, RUNTIME, isolated_environment
from camoufox_baseline import PREFS, failure, now, profile_lock, save

URL = "https://amiunique.org/fingerprint"
EXTRACT = """() => ({
  url: location.href, title: document.title, text: document.body.innerText,
  alerts: [...document.querySelectorAll('[role=alert]')].map(e => e.innerText),
  tables: [...document.querySelectorAll('table')].map(table => ({
    headers: [...table.querySelectorAll('thead th')].map(e => e.innerText),
    rows: [...table.querySelectorAll('tbody tr')].map(row => ({
      cells: [...row.querySelectorAll('td')].map(cell => cell.innerText),
      annotations: [...row.querySelectorAll('[title],[aria-label]')].map(e => ({
        title: e.getAttribute('title'), aria_label: e.getAttribute('aria-label')
      }))
    })).filter(row => row.cells.length >= 3)
  })),
  scripts: [...document.scripts].map(s => s.src).filter(Boolean)
})"""


async def capture(output: Path, *, profile: Path | None = None, resolved_options: dict | None = None,
                  local_url: str | None = None) -> int:
    from camoufox.async_api import AsyncCamoufox
    from camoufox.pkgman import camoufox_path, launch_path

    output.mkdir(parents=True, exist_ok=False)
    profile = profile or ROOT / '.local' / 'profiles' / ('amiunique-' + uuid.uuid4().hex)
    report = {
        'schema_version': 1, 'status': 'error', 'started_at': now(),
        'url': URL, 'profile': str(profile), 'headless': False,
        'versions': {name: importlib.metadata.version(name) for name in ('camoufox', 'playwright', 'fpgen')},
        'setup': json.loads((RUNTIME / 'setup.json').read_text()),
        'scope': 'Official collection in an isolated profile; persisted launch options are reused when supplied. Population statistics are separate from attribute collection.',
        'external_data': 'The official site receives the test profile fingerprint and network address. No account is used.',
        'events': [], 'api_responses': [], 'timings_ms': {},
    }
    if report['setup'].get('status') != 'ready':
        raise RuntimeError('Run setup_camoufox.py to prepare the paired runtime')
    installed = camoufox_path(download_if_missing=False)
    report['browser_install'] = json.loads((installed / 'version.json').read_text())
    report['executable'] = launch_path(installed)
    tasks = []

    async def api_response(response):
        request = response.request
        if not response.url.startswith('https://amiunique.org/') or request.resource_type not in ('fetch', 'xhr'):
            return
        record = {'url': response.url, 'method': request.method, 'status': response.status}
        try:
            body = await asyncio.wait_for(response.text(), timeout=15)
            record['body'] = body[:2_000_000]
            record['truncated'] = len(body) > 2_000_000
        except Exception as error:
            record['body_error'] = str(error)
        report['api_responses'].append(record)

    if resolved_options is None:
        manager = AsyncCamoufox(
            persistent_context=True, user_data_dir=str(profile), headless=False,
            os='macos' if sys.platform == 'darwin' else 'linux',
            main_world_eval=True, firefox_user_prefs=PREFS, timeout=60000,
        )
    else:
        options = {**resolved_options, 'user_data_dir': str(profile),
                   'env': {**isolated_environment(), **resolved_options.get('env', {})}}
        manager = AsyncCamoufox(persistent_context=True, from_options=options)
        report['launch_configuration'] = resolved_options
    page = None
    started = time.perf_counter()
    with profile_lock(profile):
        try:
            context = await asyncio.wait_for(manager.__aenter__(), timeout=75)
            report['timings_ms']['launch'] = (time.perf_counter() - started) * 1000
            report['browser_version'] = context.browser.version if context.browser else None
            context.on('response', lambda response: tasks.append(asyncio.create_task(api_response(response))))
            page = context.pages[0] if context.pages else await context.new_page()
            page.on('pageerror', lambda error: report['events'].append({'type': 'pageerror', 'message': str(error)}))
            page.on('requestfailed', lambda request: report['events'].append({
                'type': 'requestfailed', 'url': request.url, 'failure': request.failure,
            }))
            if local_url:
                await page.goto(local_url, wait_until='domcontentloaded', timeout=30000)
                report['local_audit'] = await asyncio.wait_for(page.evaluate('mw:window.runAudit()'), timeout=60)
                label = profile.parent.name
                report['local_state'] = await page.evaluate(
                    'mw:((label) => { const key=\"paired-environment\"; const previous=localStorage.getItem(key); '
                    'localStorage.setItem(key,label); return {previous,current:localStorage.getItem(key)}; })('
                    + json.dumps(label) + ')')
            navigation = time.perf_counter()
            response = await page.goto(URL, wait_until='domcontentloaded', timeout=60000)
            report['http_status'] = response.status if response else None
            report['timings_ms']['navigation'] = (time.perf_counter() - navigation) * 1000
            reject = page.get_by_role('button', name=re.compile('^reject$', re.IGNORECASE))
            if await reject.is_visible():
                await reject.click(timeout=10000)
                report['cookie_banner_action'] = 'REJECT'
            await page.wait_for_function("mw:() => { const t=document.querySelectorAll('table'); return t.length>=2 && t[1].querySelectorAll('tbody tr td').length>=150 && !t[1].innerText.includes('Loading items'); }", timeout=90000)
            report['attributes'] = await page.evaluate('mw:(' + EXTRACT + ')()')
            report['timings_ms']['navigation_to_attributes'] = (time.perf_counter() - navigation) * 1000
            try:
                await page.wait_for_function("mw:() => [...document.querySelectorAll('[role=alert]')].some(e => e.innerText.trim()) || [...document.querySelectorAll('tbody td:nth-child(2)')].filter(e => /[0-9]/.test(e.innerText)).length > 10", timeout=30000)
                report['statistics_wait'] = 'result_visible'
            except Exception as error:
                report['statistics_wait'] = {'status': 'timeout', 'message': str(error)}
            try:
                await reject.wait_for(state='visible', timeout=5000)
            except Exception:
                report.setdefault('cookie_banner_action', 'banner_not_observed')
            if await reject.is_visible():
                await reject.click(timeout=10000)
                report['cookie_banner_action'] = 'REJECT'
            report['attributes'] = await page.evaluate('mw:(' + EXTRACT + ')()')
            tables = report['attributes']['tables']
            report['attribute_counts'] = {
                'http': len(tables[0]['rows']) if tables else 0,
                'javascript': len(tables[1]['rows']) if len(tables) > 1 else 0,
            }
            report['similarity_cells_with_numbers'] = sum(
                any(c.isdigit() for c in row['cells'][1])
                for table in tables for row in table['rows'] if len(row['cells']) >= 3
            )
            (output / 'page.txt').write_text(report['attributes']['text'])
            (output / 'page.html').write_text(await page.content())
            await page.screenshot(path=str(output / 'full-page.png'), full_page=True, timeout=45000)
            await page.evaluate("mw:window.scrollTo(0, Math.max(0, document.querySelector('table').getBoundingClientRect().top + window.scrollY - window.innerHeight + 250))")
            await page.screenshot(path=str(output / 'viewport.png'), timeout=30000)
            report['screenshots'] = ['viewport.png', 'full-page.png']
            report['status'] = 'attributes_collected'
            report['population_statistics'] = 'observed' if report['similarity_cells_with_numbers'] else 'pending_external_statistics'
        except Exception as error:
            report['error'] = failure(error)
            if page is not None and not page.is_closed():
                try:
                    report['partial_page'] = await page.evaluate('mw:(' + EXTRACT + ')()')
                    await page.screenshot(path=str(output / 'failure.png'), timeout=15000)
                except Exception as capture_error:
                    report['partial_capture_error'] = str(capture_error)
        finally:
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
                official = next((r for r in report['api_responses'] if r['url'] == 'https://amiunique.org/api/fingerprints' and r['status'] == 200 and not r.get('truncated')), None)
                if official:
                    try:
                        data = json.loads(official['body'])
                        report['official_api'] = {
                            'fingerprint_hash': data.get('fpHashed'),
                            'similar_fingerprints': data.get('similarFingerprints'),
                            'all_time_attribute_count': len(data.get('attributes', {}).get('0', [])),
                        }
                        save(output / 'official-api.json', data)
                    except (ValueError, OSError) as error:
                        report['official_api_error'] = str(error)
            try:
                await asyncio.wait_for(manager.__aexit__(None, None, None), timeout=20)
                report['browser_closed'] = True
            except Exception as error:
                report['close_error'] = failure(error)
            report['finished_at'] = now()
            save(output / 'report.json', report)
    print(json.dumps({key: report.get(key) for key in (
        'status', 'browser_version', 'attribute_counts', 'population_statistics',
        'similarity_cells_with_numbers', 'error', 'browser_closed',
    )} | {'output': str(output)}, ensure_ascii=False, indent=2))
    return 0 if report['status'] == 'attributes_collected' and report.get('browser_closed') else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / '.local' / 'reports' / 'amiunique' / time.strftime('%Y%m%d-%H%M%S'))
    args = parser.parse_args()
    os.environ.update(isolated_environment())
    for name in ('CAMOUFOX_EXECUTABLE_PATH', 'FPGEN_MODEL_URL'):
        os.environ.pop(name, None)
    raise SystemExit(asyncio.run(capture(args.output.resolve())))
