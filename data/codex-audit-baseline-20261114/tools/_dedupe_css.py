import io

p = 'web/styles-glass.css'
raw = io.open(p, encoding='utf-8').read()
print('stray BOM count:', raw.count('\ufeff'))
lines = raw.split('\n')
# second copy of the layout-safety block starts at line 1825 (1-based)
start = None
for i, l in enumerate(lines):
    if 'LAYOUT SAFETY PASS' in l:
        if start is None:
            start = i
            continue
        # drop from the blank line before this comment to the end of its last block
        j = i
        # find the trailing "}" that closes the final @media of this copy
        k = j
        depth = 0
        started = False
        while k < len(lines):
            depth += lines[k].count('{') - lines[k].count('}')
            if '{' in lines[k]:
                started = True
            if started and depth == 0:
                break
            k += 1
        cut_from = j - 1 if lines[j - 1].strip() == '' else j
        print('removing lines', cut_from + 1, 'to', k + 1)
        out = lines[:cut_from] + lines[k + 1:]
        break
else:
    out = None
    print('second copy not found')

if out is not None:
    io.open(p, 'w', encoding='utf-8', newline='\n').write('\n'.join(out))
    print('new line count', len(out))
    txt = '\n'.join(out)
    print('open braces', txt.count('{'), 'close braces', txt.count('}'))
