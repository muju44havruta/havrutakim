"""세특 문구의 기재 금지 사항 자동 점검.

「학교생활기록부 기재요령」에서 교과 세부능력 및 특기사항(및 학생부 전 항목)에 쓸 수 없다고
정한 내용과 관련된 키워드를 찾아 경고합니다. 키워드 일치만으로 판정하므로 오탐·누락이 있을 수
있으며, 최종 판단은 반드시 해당 학년도 기재요령 원문과 학교 학업성적관리위원회 기준에 따릅니다.

※ 관찰에서_세특까지.html 안의 FORBIDDEN_RULES 와 같은 규칙입니다. 한쪽을 고치면 다른 쪽도 함께 고치세요.
"""

import re
from dataclasses import dataclass

# level: "금지" = 기재요령상 명시적 기재 불가 / "주의" = 맥락에 따라 기재 불가일 수 있어 확인 필요
RULES = [
    {
        "category": "대회·수상",
        "level": "금지",
        "reason": "교내·교외 대회 참여 사실과 성적·수상 실적은 세특에 기재할 수 없습니다. "
        "대회명을 행사명으로 바꿔 적는 것도 금지됩니다.",
        "patterns": [
            r"대회", r"경시", r"경연", r"공모전", r"올림피아드", r"챔피언십",
            r"수상", r"입상", r"(?:금|은|최우수|우수|장려|특|인기)상", r"대상을\s*(?:받|차지|수상)",
            r"[1-9]\s*(?:위|등(?!급|분|변))", r"본선\s*진출", r"예선\s*통과",
        ],
    },
    {
        "category": "교외 온라인 강의",
        "level": "금지",
        "reason": "K-MOOC·MOOC·KOCW 등 교외 온라인 강의 이수 내용은 기재할 수 없습니다.",
        "patterns": [r"K-?MOOC", r"MOOC", r"KOCW", r"무크", r"온라인\s*공개\s*강(?:좌|의)", r"코세라", r"Coursera", r"edX"],
    },
    {
        "category": "공인어학시험",
        "level": "금지",
        "reason": "공인어학시험 응시 사실과 성적은 기재할 수 없습니다.",
        "patterns": [
            r"토익", r"TOEIC", r"토플", r"TOEFL", r"텝스", r"TEPS", r"IELTS", r"아이엘츠",
            r"OPIc", r"오픽", r"TOSEL", r"토셀", r"HSK", r"JLPT", r"JPT", r"DELF", r"DELE",
            r"TestDaF", r"ZD", r"FLEX", r"G-TELP", r"지텔프",
        ],
    },
    {
        "category": "교외 인증시험·검정",
        "level": "금지",
        "reason": "교외 기관이 주관하는 각종 인증시험·검정의 참여 사실과 성적은 기재할 수 없습니다.",
        "patterns": [r"한국사\s*능력\s*검정", r"한자\s*능력\s*검정", r"(?:급수|등급)\s*(?:취득|합격)", r"인증\s*시험", r"검정\s*시험"],
    },
    {
        "category": "논문·출판·지식재산권",
        "level": "금지",
        "reason": "논문(학회지) 투고·등재, 학회 발표, 도서 출간, 특허 등 지식재산권 출원·등록은 기재할 수 없습니다.",
        "patterns": [r"학회", r"학술지", r"등재", r"투고", r"출간", r"책을\s*출판", r"특허", r"실용신안", r"상표\s*등록", r"지식\s*재산권", r"저작권\s*등록"],
    },
    {
        "category": "해외 활동",
        "level": "금지",
        "reason": "해외 봉사, 어학연수 등 해외 활동 실적은 기재할 수 없습니다.",
        "patterns": [r"어학\s*연수", r"해외\s*(?:봉사|연수|캠프|탐방|활동)", r"교환\s*학생"],
    },
    {
        "category": "사교육 유발 요인",
        "level": "주의",
        "reason": "사교육 유발 요인이 큰 사항(학원·과외·교외 캠프 등)은 학생부 어느 항목에도 기재할 수 없습니다.",
        "patterns": [r"(?<!대)학원", r"과외(?!\s*활동)", r"인강", r"사설\s*캠프", r"컨설팅"],
    },
    {
        "category": "부모·가정 배경",
        "level": "금지",
        "reason": "부모(친인척)의 사회·경제적 지위(직업·직장 등)를 암시하는 내용은 기재할 수 없습니다.",
        "patterns": [r"(?:부모|아버지|어머니|아빠|엄마)(?:님)?의?\s*(?:직업|직장|회사|병원|연구소)", r"장학(?:금|생)"],
    },
    {
        "category": "특정 대학·기관명",
        "level": "주의",
        "reason": "특정 대학·기관명, 교외 기관의 수료·인증 내용은 기재가 제한될 수 있습니다. 기재요령을 확인하세요.",
        "patterns": [r"[가-힣]{2,}대학교", r"[가-힣]{2,}대(?:학)?\s*(?:주최|주관|캠프|프로그램)", r"KAIST", r"카이스트", r"POSTECH", r"수료(?:증|함)?"],
    },
]

_LATIN_WORD = re.compile(r"^[A-Za-z\-?]+$")


def _wrap(pattern: str) -> str:
    # 영문 약어(FLEX, DELE 등)가 flexible, delete 같은 영단어 안에서 잡히지 않도록 경계를 둡니다.
    if _LATIN_WORD.match(pattern):
        return f"(?<![A-Za-z]){pattern}(?![A-Za-z])"
    return pattern


_COMPILED = [
    {**rule, "regex": re.compile("|".join(f"(?:{_wrap(p)})" for p in rule["patterns"]), re.IGNORECASE)}
    for rule in RULES
]


@dataclass
class Finding:
    category: str
    level: str
    reason: str
    matches: list[str]


def check_text(text: str) -> list[Finding]:
    """텍스트에서 기재 금지 의심 표현을 찾아 범주별로 돌려줍니다."""
    findings = []
    if not text:
        return findings
    for rule in _COMPILED:
        found = []
        for m in rule["regex"].finditer(text):
            word = m.group(0)
            if word not in found:
                found.append(word)
        if found:
            findings.append(Finding(rule["category"], rule["level"], rule["reason"], found))
    findings.sort(key=lambda f: 0 if f.level == "금지" else 1)
    return findings


def prompt_guideline() -> str:
    """생성 프롬프트에 넣을 기재 금지 사항 요약."""
    return "; ".join(f"{r['category']}({r['reason']})" for r in RULES if r["level"] == "금지")
