"""Claude API를 이용해 과목별 세부능력 및 특기사항(세특) 문구를 생성하는 모듈."""

import anthropic

from utils.examples import prompt_reference
from utils.forbidden_check import prompt_guideline

MODEL = "claude-opus-4-8"

STYLE_GUIDES = {
    "개조식 (~함, ~보임)": (
        "각 문장은 '~함', '~보임', '~수행함', '~발표함'과 같이 명사형으로 끝나는 "
        "개조식 문체를 사용하세요. 완결된 서술형 어미('~습니다', '~였다')는 사용하지 마세요."
    ),
    "서술형 (~하였음)": (
        "각 문장은 '~하였음', '~함으로써 성장하였음'과 같이 과거형 서술로 끝나는 문체를 사용하세요."
    ),
}


def build_prompt(
    subject: str,
    material: str,
    char_limit: str,
    style: str,
    extra_request: str,
    student_info: str,
    example_subject: str = "",
) -> tuple[str, str]:
    forbidden = prompt_guideline()
    style_guide = STYLE_GUIDES.get(style, STYLE_GUIDES["개조식 (~함, ~보임)"])

    system_prompt = f"""당신은 한국 중·고등학교 교사가 학교생활기록부의 '교과 세부능력 및 특기사항(세특)'을 \
작성하도록 돕는 전문 보조 도구입니다. 아래 원칙을 반드시 지켜 작성하세요.

1. 반드시 제공된 자료(학생의 활동 내용, 결과물)에 근거해서만 작성하고, 자료에 없는 사실이나 성과를 지어내지 마세요.
2. 학생의 이름이나 '학생은'과 같은 주어를 반복해서 쓰지 말고, 활동과 탐구 과정, 배운 점, 성장 포인트를 중심으로 서술하세요.
3. {style_guide}
4. 막연하고 추상적인 미사여구(예: '매우 우수함', '뛰어난 역량을 보임')만 나열하지 말고, \
각 활동을 다음 4단계 흐름으로 서술하세요: ① 수업 맥락(어떤 성취기준·수업 활동인지) → \
② 학생의 구체적 행동(무엇을, 어떻게 했는지) → ③ 드러난 역량(그 행동에서 드러난 역량에 대한 평가) → \
④ 변화·성장(이전과 비교한 변화나 후속 탐구). 자료에 근거가 없는 단계는 지어내지 말고 생략하세요.
5. 문단을 나누지 말고 하나의 연결된 문단으로 작성하세요.
6. 전체 분량은 공백 포함 {char_limit}자 내외로 작성하세요. 지나치게 짧거나 길게 작성하지 마세요.
7. 결과물이나 자료 중 일부만 근거로 삼을 수 있는 경우, 억지로 모든 내용을 담으려 하지 말고 \
가장 의미 있는 활동을 중심으로 응집력 있게 작성하세요.
8. 학교생활기록부 기재요령상 기재할 수 없는 내용은 자료에 있더라도 절대 쓰지 마세요: {forbidden}. \
이런 내용은 빼고, 수업 안에서 드러난 활동 과정과 역량만 서술하세요."""

    student_line = f"학생 관련 정보: {student_info}\n" if student_info.strip() else ""
    extra_line = f"\n추가 요청사항: {extra_request}\n" if extra_request.strip() else ""

    reference = prompt_reference(example_subject) if example_subject else ""
    if reference:
        system_prompt += f"""
9. 아래 예시 문구는 서술 구조(수업 맥락 → 구체적 행동 → 드러난 역량 → 변화·성장)와 문체를 참고하기 위한 것입니다. \
예시에 나오는 작품, 활동, 사실은 학생의 것이 아니므로 절대 가져다 쓰지 말고, 반드시 제공된 자료의 내용만으로 작성하세요.
<예시>
{reference}
</예시>"""

    user_prompt = f"""과목: {subject}
{student_line}{extra_line}
아래는 학생이 수행한 활동 결과물 및 관련 자료입니다 (직접 입력한 내용과 PDF에서 추출한 내용이 포함될 수 있습니다):

---
{material.strip()}
---

위 자료를 바탕으로 지침에 따라 이 과목의 세부능력 및 특기사항 문구를 작성해주세요. \
문구 이외의 다른 설명이나 안내 문구는 출력하지 마세요."""

    return system_prompt, user_prompt


def generate_setteuk(
    api_key: str,
    subject: str,
    material: str,
    char_limit: str,
    style: str,
    extra_request: str = "",
    student_info: str = "",
    example_subject: str = "",
) -> str:
    if not material.strip():
        raise ValueError("자료가 비어 있습니다. 직접 입력하거나 PDF를 업로드해주세요.")

    system_prompt, user_prompt = build_prompt(
        subject, material, char_limit, style, extra_request, student_info, example_subject
    )

    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )

    text_blocks = [block.text for block in response.content if block.type == "text"]
    return "".join(text_blocks).strip()
