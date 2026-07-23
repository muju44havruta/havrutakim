"""세특 기록을 로컬 JSON 파일에 저장/조회/수정/삭제하는 모듈."""

import json
import uuid
from datetime import datetime
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
RECORDS_PATH = DATA_DIR / "records.json"


def _ensure_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not RECORDS_PATH.exists():
        RECORDS_PATH.write_text("[]", encoding="utf-8")


def load_records() -> list[dict]:
    _ensure_storage()
    with open(RECORDS_PATH, encoding="utf-8") as f:
        return json.load(f)


def _save_records(records: list[dict]) -> None:
    _ensure_storage()
    with open(RECORDS_PATH, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)


def add_record(
    student_name: str,
    student_info: str,
    subject: str,
    material: str,
    generated_text: str,
    char_limit: str,
    style: str,
    extra_request: str,
) -> dict:
    records = load_records()
    now = datetime.now().isoformat(timespec="seconds")
    record = {
        "id": str(uuid.uuid4()),
        "student_name": student_name,
        "student_info": student_info,
        "subject": subject,
        "material": material,
        "generated_text": generated_text,
        "char_limit": char_limit,
        "style": style,
        "extra_request": extra_request,
        "created_at": now,
        "updated_at": now,
    }
    records.append(record)
    _save_records(records)
    return record


def update_record(record_id: str, **fields) -> None:
    records = load_records()
    for record in records:
        if record["id"] == record_id:
            record.update(fields)
            record["updated_at"] = datetime.now().isoformat(timespec="seconds")
            break
    _save_records(records)


def delete_record(record_id: str) -> None:
    records = load_records()
    records = [r for r in records if r["id"] != record_id]
    _save_records(records)


def get_record(record_id: str) -> dict | None:
    for record in load_records():
        if record["id"] == record_id:
            return record
    return None
