import io
import re

FILES = ['bot.py', 'trend_bot.py', 'entry_bot.py', 'reversal_bot.py',
         'pretrade_bot.py', 'extreme_bot.py']

for f in FILES:
    s = io.open('backend/' + f, encoding='utf-8').read()
    lines = s.split('\n')
    print('########', f)
    for name in ('_all_positions', '_all_orders'):
        i = s.find('    def ' + name + '(')
        if i < 0:
            continue
        n0 = s[:i].count('\n')
        print('  -- %s (line %d)' % (name, n0 + 1))
        for k in range(n0, n0 + 9):
            print('     %4d|%s' % (k + 1, lines[k]))
    ti = next(i for i, l in enumerate(lines) if l.startswith('    def tick('))
    print('  -- tick (line %d)' % (ti + 1))
    for k in range(ti, ti + 26):
        print('     %4d|%s' % (k + 1, lines[k]))
