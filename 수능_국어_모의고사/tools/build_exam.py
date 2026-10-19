"""간단한 마크업(.exam.txt)을 B4 2단 시험지 HTML로 변환한다.

마크업 규칙
  @title 제목 | 부제 | 교시 | 과목명       첫 쪽 머리말(단 전체 폭)
  @section 과목명                           새 쪽에서 시작하는 선택과목 머리말
  @set 안내문                                지문 묶음 안내([1～3] …)
  @box / @endbox                            지문 상자(줄마다 문단, 들여쓰기)
  @poem / @endpoem                          지문 상자 안 시(줄 바꿈 유지)
  @boga 제목 / @endboga                     <보기> 상자
  @q 문항 첫 줄 / @endq                     문항(①~⑤로 시작하는 줄은 선지)
  @raw / @endraw                            HTML 그대로
  @note 각주 문장                            작은 글씨 각주
  @src 출처                                  작품 출처(오른쪽 정렬)
  @h 소제목                                  (가) 같은 소제목
  @gap                                       빈 줄
  @colbreak / @pagebreak                    단·쪽 나눔
"""
import html
import re
import sys

CIRCLED = "①②③④⑤"


def esc_tags(s):
    # <보기>, <조건> 같은 꺾쇠 표기는 HTML 태그로 오인되지 않게 바꾼다.
    return re.sub(r"<(보 ?기|조 ?건)>", r"&lt;\1&gt;", s)


def build(src, title):
    out = []
    mode = None
    buf = []
    qsub = []
    qraw = [False]

    def flush_q():
        stem, choices = [], []
        for line in buf:
            if line and line[0] in CIRCLED:
                choices.append(f'<p class="c">{line}</p>')
            elif choices:
                choices[-1] = choices[-1][:-4] + "<br>" + line + "</p>"
            else:
                stem.append(line)
        head = stem[0]
        m = re.match(r"(\d+)\.\s*(.*)", head)
        num, rest = m.group(1), m.group(2)
        body = [f'<p class="qt"><b class="qn">{num}.</b> {rest}</p>']
        body += [f'<div class="qx">{s}</div>' for s in stem[1:]]
        out.append('<div class="q">' + "".join(body) + "".join(choices) + "</div>")

    for raw in src.splitlines():
        line = esc_tags(raw.rstrip())
        if mode == "raw":
            if line == "@endraw":
                out.append("\n".join(buf)); buf = []; mode = None
            else:
                buf.append(raw)
            continue
        if mode == "q":
            st = line.strip()
            if st == "@endq":
                flush_q(); buf = []; mode = None
            elif st.startswith("@boga"):
                t = st[5:].strip() or "&lt;보 기&gt;"
                qsub.append(f'<div class="boga"><div class="bt"><span>{t}</span></div>')
            elif st == "@endboga":
                qsub.append("</div>"); buf.append("".join(qsub)); qsub.clear()
            elif st == "@raw":
                qraw[0] = True
            elif st == "@endraw":
                qraw[0] = False
            elif qraw[0]:
                qsub.append(raw)
            elif qsub:
                if st.startswith("@h"):
                    qsub.append(f'<p class="h">{st[2:].strip()}</p>')
                elif st:
                    qsub.append(f'<p class="para">{st}</p>')
            elif st:
                buf.append(st)
            continue
        if mode == "poem":
            if line == "@endpoem":
                out.append('<div class="poem">' + "<br>".join(buf) + "</div>"); buf = []; mode = None
            else:
                buf.append(line.replace("  ", "&emsp;") if line.strip() else "&nbsp;")
            continue
        s = line.strip()
        if not s:
            continue
        if s.startswith("@title"):
            parts = [p.strip() for p in s[6:].split("|")]
            out.append(
                '<header class="cover"><div class="ct">{0}</div><div class="cn">1</div>'
                '<div class="row"><span class="period">{2}</span><span class="subj">{3}</span></div>'
                '<div class="sub">{1}</div></header>'.format(*parts)
            )
        elif s.startswith("@section"):
            name = s[8:].strip()
            out.append(
                '</main><main class="cols hw"><header class="cover sec"><div class="ct">2027학년도 대학수학능력시험 대비 모의평가 문제지</div>'
                f'<div class="row"><span class="period">제 1 교시</span><span class="subj">{name}</span></div></header>'
            )
        elif s.startswith("@set"):
            out.append(f'<p class="set">{s[4:].strip()}</p>')
        elif s == "@box":
            out.append('<div class="box">')
        elif s == "@endbox":
            out.append("</div>")
        elif s.startswith("@boga"):
            t = s[5:].strip() or "&lt;보 기&gt;"
            out.append(f'<div class="boga"><div class="bt"><span>{t}</span></div>')
        elif s == "@endboga":
            out.append("</div>")
        elif s == "@poem":
            mode = "poem"
        elif s.startswith("@q"):
            mode = "q"; buf = [s[2:].strip()]
        elif s == "@raw":
            mode = "raw"
        elif s.startswith("@note"):
            out.append(f'<p class="note">{s[5:].strip()}</p>')
        elif s.startswith("@src"):
            out.append(f'<p class="src">{s[4:].strip()}</p>')
        elif s.startswith("@h"):
            out.append(f'<p class="h">{s[2:].strip()}</p>')
        elif s == "@gap":
            out.append('<div class="gap"></div>')
        elif s == "@colbreak":
            out.append('<div class="colbreak"></div>')
        elif s == "@pagebreak":
            out.append('<div class="pagebreak"></div>')
        elif s.startswith("@endsection"):
            out.append("</main><main class=\"cols hw\">")
        else:
            out.append(f'<p class="para">{s}</p>')

    body = "\n".join(out)
    return TEMPLATE.replace("%TITLE%", html.escape(title)).replace("%BODY%", body)


TEMPLATE = r"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>%TITLE%</title>
<link rel="stylesheet" href="fonts/myeongjo/400.css">
<link rel="stylesheet" href="fonts/myeongjo/700.css">
<link rel="stylesheet" href="fonts/gothic/400.css">
<link rel="stylesheet" href="fonts/gothic/700.css">
<link rel="stylesheet" href="fonts/gothic/800.css">
<style>
@page {
  size: 257mm 364mm;
  margin: 24mm 15mm 20mm 15mm;
  @top-center { content: "국어 영역"; font-family: 'Nanum Gothic'; font-weight: 800; font-size: 22pt;
                border-bottom: 1.6pt solid #000; vertical-align: bottom; padding-bottom: 2mm; }
  @top-left { content: counter(page); font-family: 'Nanum Myeongjo'; font-weight: 700; font-size: 26pt;
              border-bottom: 1.6pt solid #000; vertical-align: bottom; padding-bottom: 1mm; }
  @top-right { content: ""; border-bottom: 1.6pt solid #000; }
  @bottom-center { content: counter(page) " / " counter(pages); font-family: 'Nanum Myeongjo'; font-size: 11pt; }
  @bottom-right { content: "이 문제지는 연습용으로 새로 제작한 모의 문항입니다."; font-family: 'Nanum Gothic';
                  font-size: 7.5pt; color: #2a4fa8; }
}
@page :first { @top-center { content: none; border: 0 } @top-left { content: none; border: 0 } @top-right { content: none; border: 0 } }
@page hwfirst { @top-center { content: none; border: 0 } @top-left { content: none; border: 0 } @top-right { content: none; border: 0 } }
@page hw {
  @top-center { content: "국어 영역(화법과 작문)"; font-family: 'Nanum Gothic'; font-weight: 800; font-size: 22pt;
                border-bottom: 1.6pt solid #000; vertical-align: bottom; padding-bottom: 2mm; }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; color: #000; }
body { font-family: 'Nanum Myeongjo', serif; font-size: 10.2pt; line-height: 1.62; word-break: keep-all;
       -webkit-print-color-adjust: exact; print-color-adjust: exact; }
main.cols { column-count: 2; column-gap: 9mm; column-rule: 0.8pt solid #000; column-fill: auto; }
main.hw { page: hw; break-before: page; }
main.hw > header.cover:first-child { page: hwfirst; }
header.cover { column-span: all; margin: 0 0 4mm; padding-bottom: 2mm; border-bottom: 1.6pt solid #000; text-align: center; position: relative; }
header.cover .ct { font-family: 'Nanum Gothic'; font-size: 17pt; letter-spacing: -0.3pt; }
header.cover .cn { position: absolute; right: 0; top: -2mm; font-size: 30pt; font-weight: 700; }
header.cover .row { position: relative; margin-top: 2mm; }
header.cover .period { position: absolute; left: 0; top: 4mm; border: 1pt solid #000; border-radius: 20mm;
                       padding: 1mm 6mm; font-family: 'Nanum Myeongjo'; font-size: 14pt; font-weight: 700; }
header.cover .subj { font-family: 'Nanum Gothic'; font-weight: 800; font-size: 34pt; letter-spacing: 2pt; }
header.cover .sub { font-family: 'Nanum Gothic'; font-size: 10pt; margin-top: 1mm; }
header.sec .subj { font-size: 28pt; }
p { margin: 0; }
.set { font-family: 'Nanum Gothic'; font-weight: 700; font-size: 10.2pt; margin: 3mm 0 2mm; break-after: avoid; }
.box { border: 0.8pt solid #000; padding: 3mm 3.2mm; margin: 0 0 4mm; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.box .para { text-indent: 1em; text-align: justify; }
.box .h { font-family: 'Nanum Gothic'; font-weight: 700; margin: 2mm 0 1mm; }
.box .h:first-child { margin-top: 0; }
.poem { margin: 1mm 0 1mm 1em; line-height: 1.7; }
.src { text-align: right; margin: 1mm 0 2mm; }
.note { font-size: 8.6pt; line-height: 1.45; padding-left: 1em; text-indent: -1em; }
.q { break-inside: avoid; margin: 0 0 6mm; }
.qt { padding-left: 1.9em; text-indent: -1.9em; margin-bottom: 1.5mm; }
.qn { font-family: 'Nanum Gothic'; font-weight: 800; font-size: 11.5pt; }
.qx { margin: 1mm 0 2mm; }
.c { padding-left: 1.25em; text-indent: -1.25em; margin-left: 0.6em; }
.boga { border: 0.8pt solid #000; padding: 4.5mm 3.2mm 2.5mm; margin: 4mm 0 2.5mm; position: relative; }
.boga .bt { position: absolute; top: -2.6mm; left: 0; right: 0; text-align: center; }
.boga .bt span { background: #fff; padding: 0 2mm; font-family: 'Nanum Gothic'; font-size: 9.5pt; }
.boga .para { text-indent: 1em; text-align: justify; }
.boga .h { font-family: 'Nanum Gothic'; font-weight: 700; margin: 1.5mm 0 0.5mm; }
table { border-collapse: collapse; width: 100%; margin: 1.5mm 0; font-size: 9.2pt; line-height: 1.4; }
th, td { border: 0.6pt solid #000; padding: 1mm 1.5mm; text-align: center; vertical-align: middle; }
th { font-family: 'Nanum Gothic'; font-weight: 700; background: #eee; }
td.l { text-align: left; }
.colbreak { break-after: column; }
.pagebreak { break-after: page; }
.gap { height: 4mm; }
u { text-underline-offset: 2px; }
.mk { font-family: 'Nanum Gothic'; }
.bracket { border-right: 0.8pt solid #000; padding-right: 2mm; }
.endbox { border: 0.8pt solid #000; padding: 3mm; margin-top: 6mm; font-family: 'Nanum Gothic'; font-size: 9.5pt; break-inside: avoid; }
svg text { font-family: 'Nanum Gothic'; }
</style></head>
<body><main class="cols">
%BODY%
</main></body></html>
"""

if __name__ == "__main__":
    src_path, out_path, title = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(src_path, encoding="utf-8") as f:
        src = f.read()
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(build(src, title))
