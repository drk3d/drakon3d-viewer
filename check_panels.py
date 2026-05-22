import re

with open('www/index.html', 'r', encoding='utf-8') as f:
    text = f.read()

panels = ['object-properties', 'color-panel', 'clipping-panel', 'find-panel']
for p in panels:
    m = re.search(rf'id="{p}"', text)
    if m:
        start = m.start()
        # print 5 lines before and 20 lines after
        lines = text[:start].split('\n')
        start_line = max(0, len(lines) - 3)
        all_lines = text.split('\n')
        print(f"--- Panel {p} ---")
        for idx in range(start_line, min(len(all_lines), start_line + 15)):
            print(f"{idx+1}: {all_lines[idx]}")
        print("="*40)
