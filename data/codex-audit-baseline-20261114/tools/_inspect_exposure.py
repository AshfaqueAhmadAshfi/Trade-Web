import io
import re

FILES = ['bot.py', 'trend_bot.py', 'entry_bot.py', 'reversal_bot.py',
         'pretrade_bot.py', 'extreme_bot.py']

for f in FILES:
    s = io.open('backend/' + f, encoding='utf-8').read()
    lines = s.split('\n')
    ti = next(i for i, l in enumerate(lines) if l == '    def tick(self) -> None:')
    print('==== %s  tick at %d' % (f, ti + 1))
    for i in range(ti, min(ti + 34, len(lines))):
        print('%5d|%s' % (i + 1, lines[i]))
    # exact except blocks around positions/orders
    for m in re.finditer(r'( +)raw = mt5\.(?:positions|orders)_get\([^\n]*\n\1except [^\n]*\n\1{0,1} +return \[\]', s):
        print('  EXC @', s[:m.start()].count('\n') + 1, repr(m.group(0)[-60:]))
