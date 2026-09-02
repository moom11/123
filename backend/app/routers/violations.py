"""المخالفات والجزاءات: الأنواع، التسجيل، إقرار الموظف أو تظلّمه، والاعتماد."""
from __future__ import annotations

import csv
import io
import secrets
from datetime import date

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import MAX_UPLOAD_BYTES, UPLOAD_DIR
from ..database import get_db
from ..models import Employee, Role, User, Violation, ViolationStatus, ViolationType
from ..schemas import (
    ViolationDecision,
    ViolationIn,
    ViolationOut,
    ViolationPreview,
    ViolationTypeIn,
    ViolationTypeOut,
)
from ..security import can_view_employee, get_current_user, require_hr, require_manager
from ..services import audit, notifications
from ..services import violations as service

router = APIRouter(prefix="/api", tags=["violations"])

ALLOWED_ATTACHMENTS = {".pdf", ".png", ".jpg", ".jpeg", ".webp"}


def violation_out(v: Violation) -> ViolationOut:
    return ViolationOut(
        id=v.id,
        employee_id=v.employee_id,
        employee_code=v.employee.code if v.employee else None,
        employee_name=v.employee.full_name if v.employee else None,
        violation_type_id=v.violation_type_id,
        violation_type_name=v.violation_type.name if v.violation_type else None,
        category=v.violation_type.category if v.violation_type else None,
        occurred_on=v.occurred_on,
        description=v.description,
        repetition_no=v.repetition_no,
        penalty_action=v.penalty_action,
        penalty_action_label=service.PENALTY_LABELS.get(v.penalty_action),
        penalty_value=v.penalty_value,
        penalty_amount=v.penalty_amount,
        status=v.status,
        status_label=service.STATUS_LABELS.get(v.status),
        employee_note=v.employee_note,
        decision_note=v.decision_note,
        attachment_path=v.attachment_path,
        site_id=v.site_id,
        latitude=v.latitude,
        longitude=v.longitude,
        created_at=v.created_at,
    )


# ------------------------------ أنواع المخالفات ------------------------------
@router.get("/violation-types", response_model=list[ViolationTypeOut])
def list_types(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return db.scalars(select(ViolationType).order_by(ViolationType.category, ViolationType.name)).all()


@router.post("/violation-types", response_model=ViolationTypeOut, status_code=201)
def create_type(
    payload: ViolationTypeIn, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    if db.scalar(select(ViolationType).where(ViolationType.code == payload.code)):
        raise HTTPException(status_code=400, detail="رمز نوع المخالفة مستخدم مسبقاً")
    vtype = ViolationType(**payload.model_dump())
    db.add(vtype)
    db.flush()
    audit.log(db, user, "create", "violation_type", vtype.id, vtype.name, commit=False)
    db.commit()
    db.refresh(vtype)
    return vtype


@router.patch("/violation-types/{type_id}", response_model=ViolationTypeOut)
def update_type(
    type_id: int,
    payload: ViolationTypeIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    vtype = db.get(ViolationType, type_id)
    if not vtype:
        raise HTTPException(status_code=404, detail="نوع المخالفة غير موجود")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(vtype, key, value)
    audit.log(db, user, "update", "violation_type", vtype.id, vtype.name, commit=False)
    db.commit()
    db.refresh(vtype)
    return vtype


# ------------------------------ المخالفات ------------------------------
@router.get("/violations", response_model=list[ViolationOut])
def list_violations(
    employee_id: int | None = None,
    status: ViolationStatus | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = select(Violation)
    if user.role == Role.employee:
        stmt = stmt.where(Violation.employee_id == (user.employee_id or 0))
    elif user.role == Role.manager and user.employee_id:
        team = db.scalars(
            select(Employee.id).where(
                (Employee.manager_id == user.employee_id) | (Employee.id == user.employee_id)
            )
        ).all()
        stmt = stmt.where(Violation.employee_id.in_(list(team)))
    if employee_id:
        if not can_view_employee(user, employee_id, db):
            raise HTTPException(status_code=403, detail="لا تملك صلاحية عرض هذا الموظف")
        stmt = stmt.where(Violation.employee_id == employee_id)
    if status:
        stmt = stmt.where(Violation.status == status)
    if date_from:
        stmt = stmt.where(Violation.occurred_on >= date_from)
    if date_to:
        stmt = stmt.where(Violation.occurred_on <= date_to)
    rows = db.scalars(stmt.order_by(Violation.occurred_on.desc(), Violation.id.desc())).all()
    return [violation_out(v) for v in rows]


@router.post("/violations/preview", response_model=ViolationPreview)
def preview_penalty(
    payload: ViolationIn, db: Session = Depends(get_db), _: User = Depends(require_manager)
):
    """معاينة رقم التكرار والجزاء المستحق قبل تسجيل المخالفة."""
    employee = db.get(Employee, payload.employee_id)
    vtype = db.get(ViolationType, payload.violation_type_id)
    if not employee or not vtype:
        raise HTTPException(status_code=404, detail="الموظف أو نوع المخالفة غير موجود")
    return ViolationPreview(**service.preview(db, employee, vtype, payload.occurred_on))


@router.post("/violations", response_model=ViolationOut, status_code=201)
def create_violation(
    payload: ViolationIn, db: Session = Depends(get_db), user: User = Depends(require_manager)
):
    employee = db.get(Employee, payload.employee_id)
    vtype = db.get(ViolationType, payload.violation_type_id)
    if not employee or not vtype:
        raise HTTPException(status_code=404, detail="الموظف أو نوع المخالفة غير موجود")
    if not vtype.is_active:
        raise HTTPException(status_code=400, detail="نوع المخالفة غير مفعّل")
    if payload.occurred_on > date.today():
        raise HTTPException(status_code=400, detail="لا يمكن تسجيل مخالفة بتاريخ مستقبلي")
    if user.role == Role.manager and not can_view_employee(user, employee.id, db):
        raise HTTPException(status_code=403, detail="لا تملك صلاحية تسجيل مخالفة على هذا الموظف")

    violation = Violation(
        employee_id=employee.id,
        violation_type_id=vtype.id,
        occurred_on=payload.occurred_on,
        description=payload.description,
        latitude=payload.latitude,
        longitude=payload.longitude,
        site_id=payload.site_id,
        reported_by_id=user.id,
        status=ViolationStatus.pending,
    )
    db.add(violation)
    db.flush()
    service.apply_penalty(db, violation)
    audit.log(
        db, user, "create", "violation", violation.id,
        f"{employee.full_name} - {vtype.name} (تكرار {violation.repetition_no})", commit=False,
    )
    notifications.notify_employee(
        db,
        employee.id,
        f"تم تسجيل مخالفة: {vtype.name}",
        body=(
            f"التاريخ: {violation.occurred_on} — التكرار رقم {violation.repetition_no}\n"
            f"الجزاء: {service.PENALTY_LABELS[violation.penalty_action]}"
            + (f" بقيمة {violation.penalty_amount} ريال" if violation.penalty_amount else "")
            + "\nيمكنك الإقرار بالاطلاع أو تقديم تظلّم من صفحة المخالفات."
        ),
        category="violation",
        link_page="violations",
        commit=False,
    )
    db.commit()
    db.refresh(violation)
    return violation_out(violation)


@router.post("/violations/{violation_id}/attachment", response_model=ViolationOut)
def upload_attachment(
    violation_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    violation = db.get(Violation, violation_id)
    if not violation:
        raise HTTPException(status_code=404, detail="المخالفة غير موجودة")
    suffix = "." + (file.filename or "").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else ""
    if suffix not in ALLOWED_ATTACHMENTS:
        raise HTTPException(status_code=400, detail="نوع الملف غير مدعوم (PDF أو صورة فقط)")
    content = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="حجم الملف أكبر من الحد المسموح")
    name = f"violation_{violation.id}_{secrets.token_hex(6)}{suffix}"
    (UPLOAD_DIR / name).write_bytes(content)
    violation.attachment_path = name
    db.commit()
    db.refresh(violation)
    return violation_out(violation)


@router.post("/violations/{violation_id}/acknowledge", response_model=ViolationOut)
def acknowledge(
    violation_id: int,
    payload: ViolationDecision | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """إقرار الموظف بالاطلاع على المخالفة."""
    violation = db.get(Violation, violation_id)
    if not violation:
        raise HTTPException(status_code=404, detail="المخالفة غير موجودة")
    if violation.employee_id != user.employee_id:
        raise HTTPException(status_code=403, detail="هذا الإجراء للموظف صاحب المخالفة فقط")
    if violation.status != ViolationStatus.pending:
        raise HTTPException(status_code=400, detail="تمت معالجة المخالفة مسبقاً")
    violation.status = ViolationStatus.acknowledged
    violation.employee_note = payload.note if payload else None
    audit.log(db, user, "update", "violation", violation.id, "إقرار الموظف بالاطلاع", commit=False)
    db.commit()
    db.refresh(violation)
    return violation_out(violation)


@router.post("/violations/{violation_id}/object", response_model=ViolationOut)
def object_violation(
    violation_id: int,
    payload: ViolationDecision,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """تظلّم الموظف من المخالفة."""
    violation = db.get(Violation, violation_id)
    if not violation:
        raise HTTPException(status_code=404, detail="المخالفة غير موجودة")
    if violation.employee_id != user.employee_id:
        raise HTTPException(status_code=403, detail="هذا الإجراء للموظف صاحب المخالفة فقط")
    if violation.status not in (ViolationStatus.pending, ViolationStatus.acknowledged):
        raise HTTPException(status_code=400, detail="لا يمكن التظلّم بعد اعتماد المخالفة أو إلغائها")
    if not (payload.note or "").strip():
        raise HTTPException(status_code=400, detail="اكتب سبب التظلّم")
    violation.status = ViolationStatus.objected
    violation.employee_note = payload.note
    audit.log(db, user, "update", "violation", violation.id, "تظلّم الموظف", commit=False)
    notifications.notify_approvers(
        db,
        violation.employee_id,
        f"تظلّم من مخالفة: {violation.violation_type.name}",
        body=f"الموظف {violation.employee.full_name} قدّم تظلّماً: {payload.note}",
        category="violation",
        link_page="violations",
        commit=False,
    )
    db.commit()
    db.refresh(violation)
    return violation_out(violation)


@router.post("/violations/{violation_id}/approve", response_model=ViolationOut)
def approve_violation(
    violation_id: int,
    payload: ViolationDecision | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """اعتماد المخالفة وتطبيق الجزاء (يُخصم في مسير الرواتب)."""
    violation = db.get(Violation, violation_id)
    if not violation:
        raise HTTPException(status_code=404, detail="المخالفة غير موجودة")
    service.apply_penalty(db, violation)
    violation = service.decide(
        db, violation, ViolationStatus.approved, user.id, payload.note if payload else None
    )
    audit.log(db, user, "approve", "violation", violation.id, f"جزاء {violation.penalty_amount} ريال")
    notifications.notify_employee(
        db,
        violation.employee_id,
        f"اعتماد المخالفة: {violation.violation_type.name}",
        body=(
            f"الجزاء المعتمد: {service.PENALTY_LABELS[violation.penalty_action]}"
            + (f" بقيمة {violation.penalty_amount} ريال" if violation.penalty_amount else "")
        ),
        category="violation",
        link_page="violations",
    )
    return violation_out(violation)


@router.post("/violations/{violation_id}/cancel", response_model=ViolationOut)
def cancel_violation(
    violation_id: int,
    payload: ViolationDecision | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    violation = db.get(Violation, violation_id)
    if not violation:
        raise HTTPException(status_code=404, detail="المخالفة غير موجودة")
    violation = service.decide(
        db, violation, ViolationStatus.cancelled, user.id, payload.note if payload else None
    )
    audit.log(db, user, "cancel", "violation", violation.id, payload.note if payload else None)
    notifications.notify_employee(
        db, violation.employee_id, f"إلغاء المخالفة: {violation.violation_type.name}",
        category="violation", link_page="violations",
    )
    return violation_out(violation)


@router.get("/violations-export.csv")
def export_violations(
    year: int = Query(default_factory=lambda: date.today().year),
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    rows = db.scalars(
        select(Violation)
        .where(Violation.occurred_on >= date(year, 1, 1), Violation.occurred_on <= date(year, 12, 31))
        .order_by(Violation.occurred_on)
    ).all()
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        ["#", "التاريخ", "رقم الموظف", "الموظف", "المخالفة", "التصنيف", "التكرار",
         "الجزاء", "القيمة", "الخصم (ريال)", "الحالة", "الوصف"]
    )
    for v in rows:
        writer.writerow([
            v.id, v.occurred_on,
            v.employee.code if v.employee else "",
            v.employee.full_name if v.employee else "",
            v.violation_type.name if v.violation_type else "",
            v.violation_type.category if v.violation_type else "",
            v.repetition_no,
            service.PENALTY_LABELS.get(v.penalty_action, ""),
            v.penalty_value,
            v.penalty_amount,
            service.STATUS_LABELS.get(v.status, ""),
            (v.description or "").replace("\n", " "),
        ])
    return Response(
        "﻿" + buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=violations_{year}.csv"},
    )
