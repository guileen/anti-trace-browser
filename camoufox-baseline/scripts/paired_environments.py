#!/usr/bin/env python3
"""Compare two fixed Camoufox configurations, each before and after restart."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys
import time

from setup_camoufox import ROOT, isolated_environment
from camoufox_baseline import PREFS, failure, now, save
from amiunique_baseline import capture


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def measured(value):
    return value is not None and value != '' and value != [] and value != {}


def features(report, directory):
    observations = {row['id']: row for row in report.get('local_audit', {}).get('observations', [])}
    def value(rule, key):
        row = observations.get(rule, {})
        return row.get('value', {}).get(key)
    api_path = directory / 'official-api.json'
    api = json.loads(api_path.read_text()) if api_path.exists() else {}
    official = {row['attribute']: row.get('value') for row in api.get('attributes', {}).get('0', [])}
    geometry = observations.get('geometry', {}).get('value', {})
    webgl = observations.get('webgl_render', {}).get('value', {})
    return {
        'canvas_pixels': value('canvas_render', 'pixel_hash'),
        'canvas_png': value('canvas_render', 'png_hash'),
        'audio_samples': value('audio_render', 'hash'),
        'webgl_renderer': webgl.get('unmasked_renderer'),
        'webgl_parameters': {'max_texture_size': webgl['max_texture_size'], 'subpixel_bits': webgl.get('subpixel_bits'), 'extensions': sorted(webgl.get('extensions', []))} if webgl.get('max_texture_size') else None,
        'font_widths': observations.get('font_privacy', {}).get('value', {}).get('measurements'),
        'screen': {key: geometry[key] for key in ('screen_width', 'screen_height', 'color_depth', 'dpr') if key in geometry} or None,
        'hardware_concurrency': value('navigator_http', 'hardware_concurrency'),
        'device_memory': value('navigator_http', 'device_memory'),
        'official_canvas': digest(official['canvas']) if measured(official.get('canvas')) else None,
        'official_webgl_data': digest(official['webGLData']) if measured(official.get('webGLData')) else None,
        'official_fonts': digest(official['font-js']) if measured(official.get('font-js')) else None,
        'official_audio': digest(official['audioData']) if measured(official.get('audioData')) and official.get('audioData') != 'Not supported' else None,
    }


def compare(left, right):
    return {key: {'status': 'different' if left[key] != right[key] else 'same',
                  'left': left[key], 'right': right[key]}
            if measured(left[key]) and measured(right[key]) else
            {'status': 'unobserved', 'left': left[key], 'right': right[key]}
            for key in left}


async def run(root, local_url, policy='default'):
    from camoufox.utils import launch_options
    root.mkdir(parents=True, exist_ok=False)
    report = {'schema_version': 1, 'started_at': now(), 'sessions': {},
              'policy': policy,
              'method': 'Generate two configurations once, persist resolved native launch options, replay them across restarts, and retain raw observations even when functionality controls fail.',
              'risk_evidence': {'production_accounts': 'unused', 'network': 'shared host exit',
                                'cross_site_linkability': 'not_tested', 'account_risk': 'not_tested',
                                'active_challenges': 'not_tested'}}
    identities = {}
    for name in ('A', 'B'):
        directory = root / name
        directory.mkdir()
        protection = {}
        if policy == 'native-protection':
            from camoufox.webgl import firefox_gpus
            target = 'mac' if sys.platform == 'darwin' else 'lin'
            catalog = sorted(firefox_gpus(target))
            preferred = [('Apple', 'Apple M1, or similar'), ('Intel Inc.', 'Intel(R) HD Graphics, or similar')]
            selected = preferred if target == 'mac' and all(gpu in catalog for gpu in preferred) else catalog[:2]
            if len(selected) < 2:
                raise RuntimeError('Two recorded native GPU configurations are required')
            protection = {'canvas_noise': True, 'webgl_config': selected[0 if name == 'A' else 1]}
            report.setdefault('native_protection', {})[name] = protection
        elif policy == 'font-isolation':
            font_sets = {
                'A': ['Arial', 'Times New Roman', 'Courier New'],
                'B': ['Menlo', 'Georgia', 'Helvetica Neue'],
            }
            protection = {'canvas_noise': False, 'custom_fonts_only': True, 'fonts': font_sets[name]}
            report.setdefault('font_isolation', {})[name] = protection
        elif policy == 'targeted':
            font_sets = {
                'A': ['Arial', 'Times New Roman', 'Courier New'],
                'B': ['Menlo', 'Georgia', 'Helvetica Neue'],
            }
            gpu_configs = {
                'A': ('Apple', 'Apple M1, or similar'),
                'B': ('Intel Inc.', 'Intel(R) HD Graphics, or similar'),
            }
            core_counts = {'A': 8, 'B': 12}
            window_sizes = {'A': (1440, 900), 'B': (1366, 768)}
            protection = {
                'canvas_noise': False,
                'custom_fonts_only': True,
                'fonts': font_sets[name],
                'webgl_config': gpu_configs[name],
                'config': {'navigator.hardwareConcurrency': core_counts[name]},
                'window': window_sizes[name],
                'i_know_what_im_doing': True,
            }
            report.setdefault('targeted', {})[name] = {
                'fonts': font_sets[name],
                'gpu': gpu_configs[name],
                'cores': core_counts[name],
                'window': window_sizes[name],
            }
        options = launch_options(headless=False, os='macos' if sys.platform == 'darwin' else 'linux',
                                 main_world_eval=True, firefox_user_prefs=PREFS, timeout=60000,
                                 pin_cpu_cores=False, **protection)
        options['env'] = {key: value for key, value in options['env'].items()
                          if key.startswith(('CAMOU_', 'FONTCONFIG'))}
        identity_path = directory / 'launch-options.json'
        save(identity_path, options)
        identity_path.chmod(0o600)
        identities[name] = options
    binaries = {str(Path(options['executable_path']).resolve()) for options in identities.values()}
    report['runtime'] = {'executables': sorted(binaries), 'same_executable': len(binaries) == 1,
                         'sha256': {path: hashlib.file_digest(open(path, 'rb'), 'sha256').hexdigest() for path in binaries}}
    report['configuration_sha256'] = {name: digest(options) for name, options in identities.items()}
    for iteration in (1, 2):
        for name in ('A', 'B'):
            directory = root / name / f'run-{iteration}'
            try:
                options = json.loads((root / name / 'launch-options.json').read_text())
                await capture(directory, profile=root / name / 'profile', resolved_options=options, local_url=local_url)
                data = json.loads((directory / 'report.json').read_text())
                report['sessions'][f'{name}{iteration}'] = {
                    'status': data['status'], 'browser_closed': data.get('browser_closed'),
                    'browser_version': data.get('browser_version'), 'report': str(directory / 'report.json'),
                    'features': features(data, directory), 'local_state': data.get('local_state'),
                    'scores': data.get('local_audit', {}).get('scores'),
                    'probe_statuses': {row['id']: row['status'] for row in data.get('local_audit', {}).get('observations', [])},
                    'official': data.get('official_api'),
                    'configuration_sha256': digest(options),
                    'timings_ms': data.get('timings_ms'),
                    'error': data.get('error'),
                }
            except Exception as error:
                report['sessions'][f'{name}{iteration}'] = {'status': 'error', 'error': failure(error)}
            save(root / 'comparison.json', report)
    sessions = report['sessions']
    if all('features' in sessions.get(key, {}) for key in ('A1', 'B1', 'A2', 'B2')):
        report['between_environments'] = compare(sessions['A1']['features'], sessions['B1']['features'])
        report['between_environments_after_restart'] = compare(sessions['A2']['features'], sessions['B2']['features'])
        report['restart'] = {name: compare(sessions[name + '1']['features'], sessions[name + '2']['features']) for name in ('A', 'B')}
        required_different = ('canvas_pixels', 'webgl_renderer', 'webgl_parameters', 'font_widths', 'screen', 'hardware_concurrency')
        required_stable = ('canvas_pixels', 'audio_samples', 'webgl_renderer', 'webgl_parameters', 'font_widths', 'screen', 'hardware_concurrency')
        report['gates'] = {
            'same_runtime': report['runtime']['same_executable'] and len({s['browser_version'] for s in sessions.values()}) == 1,
            'all_collections_completed': all(s['status'] == 'attributes_collected' and s.get('browser_closed') for s in sessions.values()),
            'all_configurable_hardware_different': all(comparison[key]['status'] == 'different' for comparison in (report['between_environments'], report['between_environments_after_restart']) for key in required_different),
            'stable_required_hardware_on_restart': all(report['restart'][name][key]['status'] == 'same' for name in ('A', 'B') for key in required_stable),
            'audio_architecture_bound': all(comparison['audio_samples']['status'] == 'same' for comparison in (report['between_environments'], report['between_environments_after_restart'])),
            'independent_persistent_local_state': all(
                sessions[name + '1'].get('local_state') == {'previous': None, 'current': name} and
                sessions[name + '2'].get('local_state') == {'previous': name, 'current': name}
                for name in ('A', 'B')),
            'fixed_launch_configuration': all(sessions[name + str(i)]['configuration_sha256'] == report['configuration_sha256'][name]
                                               for name in ('A', 'B') for i in (1, 2)),
            'distinct_launch_configurations': report['configuration_sha256']['A'] != report['configuration_sha256']['B'],
            'functionality_controls': all(s.get('scores', {}).get('functionality', {}).get('score') == 100 for s in sessions.values()),
            'local_consistency_controls': all(s.get('scores', {}).get('automation', {}).get('score') == 100 for s in sessions.values()),
            'low_account_risk': 'not_tested',
        }
        report['gates']['joint_acceptance'] = (
            report['gates']['same_runtime'] and
            report['gates']['all_collections_completed'] and
            report['gates']['all_configurable_hardware_different'] and
            report['gates']['stable_required_hardware_on_restart'] and
            report['gates']['independent_persistent_local_state'] and
            report['gates']['fixed_launch_configuration'] and
            report['gates']['distinct_launch_configurations'] and
            report['gates']['functionality_controls'] and
            report['gates']['local_consistency_controls']
        )
        report['risk_acceptance'] = 'not_tested'
    report['finished_at'] = now()
    report['execution_status'] = 'complete' if len(sessions) == 4 and all(s.get('status') == 'attributes_collected' and s.get('browser_closed') for s in sessions.values()) else 'error'
    save(root / 'comparison.json', report)
    print(json.dumps({'output': str(root / 'comparison.json'), 'execution_status': report['execution_status'],
                      'gates': report.get('gates'),
                      'between_environments': {k: v['status'] for k, v in report.get('between_environments', {}).items()}}, ensure_ascii=False, indent=2))
    return 0 if report['execution_status'] == 'complete' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / '.local' / 'reports' / 'paired' / time.strftime('%Y%m%d-%H%M%S'))
    parser.add_argument('--url', default='http://127.0.0.1:8765')
    parser.add_argument('--policy', choices=('default', 'native-protection', 'font-isolation', 'targeted'), default='default')
    args = parser.parse_args()
    os.environ.update(isolated_environment())
    for key in ('CAMOUFOX_EXECUTABLE_PATH', 'FPGEN_MODEL_URL'):
        os.environ.pop(key, None)
    raise SystemExit(asyncio.run(run(args.output.resolve(), args.url, args.policy)))
