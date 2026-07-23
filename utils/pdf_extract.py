"""업로드된 PDF 파일에서 텍스트를 추출하는 모듈."""

import io

from pypdf import PdfReader


def extract_text_from_pdf(file_bytes: bytes) -> str:
    """PDF 바이트에서 텍스트를 추출한다. 스캔본(이미지) PDF는 텍스트가 없을 수 있다."""
    reader = PdfReader(io.BytesIO(file_bytes))
    pages_text = []
    for page in reader.pages:
        text = page.extract_text() or ""
        pages_text.append(text.strip())
    return "\n\n".join(t for t in pages_text if t)
