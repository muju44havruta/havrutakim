"""화법과 작문 문제지(.md)를 시험지 마크업(.exam.txt)으로 바꾼다."""
import re
import sys

md = open(sys.argv[1], encoding="utf-8").read()
section_name = sys.argv[3] if len(sys.argv) > 3 else "국어 영역(화법과 작문)"
md = md.split("---", 2)[2]  # 머리말(front matter) 제거


def inline(s):
    s = s.rstrip("\\").strip()
    s = re.sub(r"\[([^\]]+)\]\{\.underline\}", r"<u>\1</u>", s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = s.replace("\\<", "&lt;").replace("\\>", "&gt;")
    return s


def table_html(rows):
    cells = [[c.strip() for c in r.strip().strip("|").split("|")] for r in rows]
    cells = [r for r in cells if not all(re.fullmatch(r":?-+:?", c) for c in r)]
    out = ["<table>"]
    for i, r in enumerate(cells):
        tag = "th" if i == 0 else "td"
        out.append("<tr>" + "".join(f"<{tag}>{inline(c)}</{tag}>" for c in r) + "</tr>")
    out.append("</table>")
    return "".join(out)


def quote_html(lines, kind):
    """blockquote 줄 묶음을 HTML로 바꾼다. kind: box | boga"""
    body, title, i = [], None, 0
    while i < len(lines):
        l = lines[i]
        t = l.strip()
        if not t:
            i += 1
            continue
        m = re.fullmatch(r"\*\*\\<(보 기|조 건)\\>\*\*", t)
        if m:
            title = f"&lt;{m.group(1)}&gt;"
        elif t.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(lines[i]); i += 1
            body.append(table_html(rows)); continue
        elif t.startswith("- "):
            body.append(f'<p class="para" style="text-indent:0;padding-left:1em;text-indent:-1em">· {inline(t[2:])}</p>')
        elif re.fullmatch(r"\*\*\[.+\]\*\*\\?", t):
            body.append(f'<p class="h">{inline(t)}</p>')
        elif re.match(r"\*\*(학생|회장|부회장|총무부장|환경부장|청중|강연자|사회자)", t):
            body.append(f'<p class="para" style="text-indent:-1em;padding-left:1em">{inline(t)}</p>')
        elif re.fullmatch(r"\*\*\[[A-Z]\]\*\*", t):
            body.append(f'<p class="para" style="text-indent:0;text-align:center">{inline(t)}</p>')
        else:
            body.append(f'<p class="para">{inline(t)}</p>')
        i += 1
    if kind == "boga":
        t = title or "&lt;보 기&gt;"
        return f'<div class="boga"><div class="bt"><span>{t}</span></div>' + "".join(body) + "</div>"
    return "".join(body)


lines = md.split("\n")
out = [f"@section {section_name}"]
i = 0
in_box = False
in_q = False


def close_q():
    global in_q
    if in_q:
        out.append("@endq")
        in_q = False


def close_box():
    global in_box
    if in_box:
        out.append("@raw\n</div>\n@endraw")
        in_box = False


while i < len(lines):
    l = lines[i]
    t = l.strip()
    if t.startswith("> **안내**") or t.startswith("\\* 확인 사항") or t == "---":
        i += 1
        continue
    if t.startswith("## "):
        close_q(); close_box()
        out.append("@set " + t[3:].replace("~", "～"))
    elif re.fullmatch(r"\*\*\((가|나)\)\*\*", t):
        if not in_box:
            out.append('@raw\n<div class="box">\n@endraw'); in_box = True
        out.append(f"@raw\n<p class=\"h\">{inline(t)}</p>\n@endraw")
    elif t.startswith(">"):
        block = []
        while i < len(lines) and lines[i].strip().startswith(">"):
            block.append(lines[i].strip()[1:].strip()); i += 1
        is_boga = any(re.fullmatch(r"\*\*\\<(보 기|조 건)\\>\*\*", b) for b in block)
        if in_q:
            out.append(quote_html(block, "boga" if is_boga else "box").replace("\n", " ") if is_boga
                       else '<div class="boga" style="padding-top:3mm">' + quote_html(block, "box") + "</div>")
        else:
            if not in_box:
                out.append('@raw\n<div class="box">\n@endraw'); in_box = True
            out.append("@raw\n" + quote_html(block, "box") + "\n@endraw")
            # (가) 다음 (나)가 이어지면 같은 상자에 넣는다.
            j = i
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines) and re.fullmatch(r"\*\*\((가|나)\)\*\*", lines[j].strip()):
                pass
            else:
                close_box()
        continue
    elif re.match(r"\*\*\d+\.\*\*", t):
        close_q(); close_box()
        m = re.match(r"\*\*(\d+)\.\*\*\s*(.*)", t)
        out.append(f"@q {m.group(1)}. {inline(m.group(2))}")
        in_q = True
    elif t.startswith("|") and in_q:
        rows = []
        while i < len(lines) and lines[i].strip().startswith("|"):
            rows.append(lines[i]); i += 1
        out.append(table_html(rows))
        continue
    elif t and in_q:
        out.append(inline(t))
    i += 1
close_q(); close_box()
open(sys.argv[2], "w", encoding="utf-8").write("\n".join(out) + "\n")
