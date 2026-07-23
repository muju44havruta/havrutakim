"""과목별 세부능력 및 특기사항(세특) 작성 도우미.

학생이 수행한 결과물(PDF)이나 직접 입력한 자료를 바탕으로 Claude API를 이용해
과목별 세특 문구를 생성하고, 로컬에 저장/조회/수정할 수 있는 Streamlit 앱.
"""

import os

import streamlit as st

from utils import storage
from utils.generator import generate_setteuk
from utils.pdf_extract import extract_text_from_pdf

SUBJECTS = [
    "국어", "수학", "영어", "사회", "역사", "도덕",
    "과학", "물리학", "화학", "생명과학", "지구과학",
    "기술·가정", "정보", "체육", "음악", "미술",
    "한국사", "진로와 직업", "직접 입력",
]
CHAR_LIMITS = ["500", "800", "1000", "1500", "직접 입력"]
STYLES = ["개조식 (~함, ~보임)", "서술형 (~하였음)"]

st.set_page_config(page_title="세특 작성 도우미", page_icon="📝", layout="wide")


def get_api_key() -> str:
    env_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if env_key:
        return env_key
    return st.session_state.get("api_key", "")


def sidebar() -> str:
    st.sidebar.title("📝 세특 작성 도우미")

    if not os.environ.get("ANTHROPIC_API_KEY"):
        st.sidebar.text_input(
            "Anthropic API 키",
            type="password",
            key="api_key",
            help="세특 문구 생성을 위해 Claude API 키가 필요합니다. "
            "이 값은 저장되지 않고 현재 세션에서만 사용됩니다.",
        )
        st.sidebar.caption("환경변수 ANTHROPIC_API_KEY를 설정하면 이 입력창은 나타나지 않습니다.")

    page = st.sidebar.radio("메뉴", ["세특 작성", "저장된 기록"])
    st.sidebar.divider()
    st.sidebar.caption(
        "학생 활동 자료(직접 입력 또는 PDF)를 바탕으로 과목별 세특 문구 초안을 생성합니다. "
        "생성된 문구는 반드시 교사가 검토·수정 후 사용하세요."
    )
    return page


def material_input_section() -> None:
    st.subheader("1. 자료 입력")
    st.caption("직접 입력하거나 PDF를 업로드해서 자료를 추가하세요. 두 방식을 함께 사용할 수 있습니다.")

    if "material_text" not in st.session_state:
        st.session_state["material_text"] = ""

    uploaded_files = st.file_uploader(
        "PDF 업로드 (여러 개 가능)", type=["pdf"], accept_multiple_files=True
    )
    col_a, col_b = st.columns([1, 3])
    with col_a:
        if st.button("PDF 텍스트 추출하여 자료에 추가", disabled=not uploaded_files):
            added = []
            for f in uploaded_files:
                text = extract_text_from_pdf(f.read())
                if text:
                    added.append(f"[{f.name}]\n{text}")
                else:
                    st.warning(f"'{f.name}'에서 텍스트를 추출하지 못했습니다. 스캔본(이미지) PDF일 수 있습니다.")
            if added:
                existing = st.session_state["material_text"]
                combined = "\n\n".join(added)
                st.session_state["material_text"] = (existing + "\n\n" + combined).strip() if existing else combined
                st.rerun()

    st.text_area(
        "자료 (직접 입력하거나 PDF에서 추출된 내용을 편집할 수 있습니다)",
        key="material_text",
        height=250,
        placeholder="예) 3월 과학 탐구 프로젝트에서 광합성 실험을 설계하고 수행함. "
        "빛의 세기에 따른 산소 발생량을 측정하여 그래프로 정리하고 발표함...",
    )
    if st.button("자료 비우기"):
        st.session_state["material_text"] = ""
        st.rerun()


def generation_form() -> None:
    st.subheader("2. 학생 정보 및 옵션")
    col1, col2 = st.columns(2)
    with col1:
        student_name = st.text_input("학생 이름 (기록 저장용, 문구에는 포함되지 않음)")
        student_info = st.text_input("학년/반/번호 등 (선택)", placeholder="예) 2학년 3반 15번")
        subject = st.selectbox("과목", SUBJECTS)
        if subject == "직접 입력":
            subject = st.text_input("과목명 직접 입력")
    with col2:
        char_limit = st.selectbox("글자수 (공백 포함, 대략적인 기준)", CHAR_LIMITS, index=1)
        if char_limit == "직접 입력":
            char_limit = st.text_input("글자수 직접 입력", value="800")
        style = st.selectbox("문체", STYLES)
        extra_request = st.text_area("추가 요청사항 (선택)", placeholder="예) 협업 태도를 강조해서 작성해주세요.")

    st.subheader("3. 세특 생성")
    api_key = get_api_key()
    if not api_key:
        st.info("사이드바에 Anthropic API 키를 입력하면 세특 문구를 생성할 수 있습니다.")

    generate_clicked = st.button("✨ 세특 생성", type="primary", disabled=not api_key)

    if generate_clicked:
        material = st.session_state.get("material_text", "")
        if not material.strip():
            st.error("자료를 먼저 입력하거나 PDF를 업로드해주세요.")
        elif not subject.strip():
            st.error("과목을 입력해주세요.")
        else:
            with st.spinner("세특 문구를 생성하는 중입니다..."):
                try:
                    result = generate_setteuk(
                        api_key=api_key,
                        subject=subject,
                        material=material,
                        char_limit=str(char_limit),
                        style=style,
                        extra_request=extra_request,
                        student_info=student_info,
                    )
                    st.session_state["generated_text"] = result
                    st.session_state["last_meta"] = {
                        "student_name": student_name,
                        "student_info": student_info,
                        "subject": subject,
                        "char_limit": str(char_limit),
                        "style": style,
                        "extra_request": extra_request,
                    }
                except Exception as e:
                    st.error(f"생성 중 오류가 발생했습니다: {e}")

    if st.session_state.get("generated_text"):
        st.subheader("4. 생성 결과 (검토 및 수정)")
        result_text = st.text_area(
            "생성된 세특 문구 (직접 수정 가능)",
            value=st.session_state["generated_text"],
            height=200,
            key="result_editor",
        )
        st.caption(f"글자수: {len(result_text)}자 (공백 포함)")

        col1, col2, col3 = st.columns(3)
        with col1:
            if st.button("💾 기록으로 저장"):
                meta = st.session_state.get("last_meta", {})
                storage.add_record(
                    student_name=meta.get("student_name", ""),
                    student_info=meta.get("student_info", ""),
                    subject=meta.get("subject", ""),
                    material=st.session_state.get("material_text", ""),
                    generated_text=result_text,
                    char_limit=meta.get("char_limit", ""),
                    style=meta.get("style", ""),
                    extra_request=meta.get("extra_request", ""),
                )
                st.success("저장되었습니다. '저장된 기록' 메뉴에서 확인할 수 있습니다.")
        with col2:
            st.download_button(
                "⬇️ 텍스트 파일로 다운로드",
                data=result_text,
                file_name=f"{st.session_state.get('last_meta', {}).get('subject', '세특')}.txt",
                mime="text/plain",
            )
        with col3:
            if st.button("🗑️ 결과 지우기"):
                st.session_state["generated_text"] = ""
                st.rerun()


def records_page() -> None:
    st.title("저장된 세특 기록")
    records = storage.load_records()

    if not records:
        st.info("저장된 기록이 없습니다. '세특 작성' 메뉴에서 먼저 문구를 생성하고 저장해보세요.")
        return

    student_names = sorted({r["student_name"] for r in records if r["student_name"]})
    filter_name = st.selectbox("학생 이름으로 필터링", ["전체"] + student_names)

    filtered = [r for r in records if filter_name == "전체" or r["student_name"] == filter_name]
    filtered.sort(key=lambda r: r["updated_at"], reverse=True)

    for record in filtered:
        title = f"{record['student_name'] or '(이름 없음)'} · {record['subject']} · {record['updated_at']}"
        with st.expander(title):
            edited_text = st.text_area(
                "세특 문구", value=record["generated_text"], height=180, key=f"text_{record['id']}"
            )
            st.caption(f"글자수: {len(edited_text)}자 | 학생 정보: {record.get('student_info', '') or '-'}")

            with st.expander("원본 자료 보기"):
                st.text(record.get("material", ""))

            col1, col2, col3 = st.columns(3)
            with col1:
                if st.button("수정 내용 저장", key=f"save_{record['id']}"):
                    storage.update_record(record["id"], generated_text=edited_text)
                    st.success("수정되었습니다.")
                    st.rerun()
            with col2:
                st.download_button(
                    "다운로드",
                    data=edited_text,
                    file_name=f"{record['student_name'] or '세특'}_{record['subject']}.txt",
                    mime="text/plain",
                    key=f"download_{record['id']}",
                )
            with col3:
                if st.button("삭제", key=f"delete_{record['id']}"):
                    storage.delete_record(record["id"])
                    st.rerun()


def main() -> None:
    page = sidebar()
    if page == "세특 작성":
        st.title("과목별 세부능력 및 특기사항(세특) 작성")
        material_input_section()
        st.divider()
        generation_form()
    else:
        records_page()


if __name__ == "__main__":
    main()
