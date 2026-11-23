"""독서300 단일 HTML 빌드: src.html의 /*BOOKS*/ 자리에 books.txt를 넣어 독서300_프로젝트.html을 만든다."""
from pathlib import Path
here = Path(__file__).resolve().parent
src = (here / "src.html").read_text(encoding="utf-8")
books = (here / "books.txt").read_text(encoding="utf-8").strip()
assert "</script" not in books
(here / "독서300_프로젝트.html").write_text(src.replace("/*BOOKS*/", books), encoding="utf-8")
print("ok", len(books.splitlines()), "books")
