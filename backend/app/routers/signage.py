"""شاشات الفرع: منتجات مارا وإعلاناتها بين المباريات.

الفكرة: لا نمسّ بث القناة ولا نضع شيئاً فوقه. جهاز صغير خلف كل شاشة يشغّل
قائمة العرض، فإذا بدأ الفاصل طلب الجهاز صورة الشاشة عبر HDMI-CEC وعرض
الإعلانات، وإذا انتهى أعاد الشاشة إلى مصدرها السابق (الرسيفر).
"""
from __future__ import annotations

import secrets
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..config import MAX_UPLOAD_BYTES, UPLOAD_DIR
from ..database import get_db
from ..models import (
    BreakSession,
    BreakTrigger,
    MatchFixture,
    Playlist,
    PlaylistItem,
    Screen,
    ScreenMode,
    Slide,
    SlideImpression,
    SlideKind,
    User,
)
from ..security import require_hr, require_manager
from ..security_extra import content_problem
from ..services import audit
from ..services import signage as service

router = APIRouter(prefix="/api/signage", tags=["signage"])

IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".webp"}


# ------------------------------ نماذج الإدخال والإخراج ------------------------------


class ScreenIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    zone: str | None = Field(default=None, max_length=60)
    mode: ScreenMode = ScreenMode.break_only
    playlist_id: int | None = None
    break_playlist_id: int | None = None
    cec_enabled: bool = True
    rotation: int = Field(default=0, ge=0, le=270)
    is_active: bool = True


class ScreenPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=80)
    zone: str | None = Field(default=None, max_length=60)
    mode: ScreenMode | None = None
    playlist_id: int | None = None
    break_playlist_id: int | None = None
    cec_enabled: bool | None = None
    rotation: int | None = Field(default=None, ge=0, le=270)
    is_active: bool | None = None


class ScreenOut(BaseModel):
    id: int
    name: str
    zone: str | None
    mode: ScreenMode
    playlist_id: int | None
    playlist_name: str | None = None
    break_playlist_id: int | None
    break_playlist_name: str | None = None
    cec_enabled: bool
    rotation: int
    is_active: bool
    online: bool
    last_seen_at: datetime | None
    playing: str
    play_url: str


class SlideIn(BaseModel):
    kind: SlideKind = SlideKind.product
    title: str = Field(min_length=1, max_length=120)
    subtitle: str | None = Field(default=None, max_length=200)
    price: float | None = Field(default=None, ge=0)
    old_price: float | None = Field(default=None, ge=0)
    badge: str | None = Field(default=None, max_length=40)
    duration_seconds: int = Field(default=8, ge=2, le=120)
    starts_on: date | None = None
    ends_on: date | None = None
    is_active: bool = True


class SlidePatch(BaseModel):
    kind: SlideKind | None = None
    title: str | None = Field(default=None, min_length=1, max_length=120)
    subtitle: str | None = Field(default=None, max_length=200)
    price: float | None = Field(default=None, ge=0)
    old_price: float | None = Field(default=None, ge=0)
    badge: str | None = Field(default=None, max_length=40)
    duration_seconds: int | None = Field(default=None, ge=2, le=120)
    starts_on: date | None = None
    ends_on: date | None = None
    is_active: bool | None = None


class SlideOut(BaseModel):
    id: int
    kind: SlideKind
    title: str
    subtitle: str | None
    price: float | None
    old_price: float | None
    badge: str | None
    image_url: str | None
    duration_seconds: int
    starts_on: date | None
    ends_on: date | None
    is_active: bool
    is_live: bool
    playlists: list[str] = []


class PlaylistIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    description: str | None = Field(default=None, max_length=255)
    is_active: bool = True


class PlaylistOut(BaseModel):
    id: int
    name: str
    description: str | None
    is_active: bool
    slide_ids: list[int]
    live_count: int


class PlaylistItemsIn(BaseModel):
    slide_ids: list[int] = Field(default_factory=list)


class FixtureIn(BaseModel):
    title: str = Field(min_length=2, max_length=140)
    competition: str | None = Field(default=None, max_length=80)
    kickoff_at: datetime
    halftime_after_minutes: int = Field(default=47, ge=1, le=180)
    break_minutes: int = Field(default=12, ge=1, le=60)
    zone: str | None = Field(default=None, max_length=60)
    auto_break: bool = True


class FixtureOut(FixtureIn):
    id: int
    break_starts_at: datetime
    break_ends_at: datetime


class BreakStartIn(BaseModel):
    minutes: int = Field(default=12, ge=1, le=60)
    zone: str | None = Field(default=None, max_length=60)
    playlist_id: int | None = None
    note: str | None = Field(default=None, max_length=160)


class BreakOut(BaseModel):
    id: int | None = None
    zone: str | None = None
    started_at: datetime | None = None
    ends_at: datetime | None = None
    seconds_left: int | None = None
    playlist_id: int | None = None
    note: str | None = None
    started_by: str | None = None
    active: bool = False


class ImpressionIn(BaseModel):
    slide_id: int
    seconds: int = Field(default=0, ge=0, le=600)
    break_session_id: int | None = None


# ------------------------------ أدوات مشتركة ------------------------------


def _playlist_or_404(db: Session, playlist_id: int) -> Playlist:
    row = db.get(Playlist, playlist_id)
    if not row:
        raise HTTPException(status_code=404, detail="قائمة التشغيل غير موجودة")
    return row


def _check_playlists(db: Session, *ids: int | None) -> None:
    for pid in ids:
        if pid:
            _playlist_or_404(db, pid)


def screen_out(db: Session, row: Screen, now: datetime | None = None) -> ScreenOut:
    state = service.screen_state(db, row, now)
    return ScreenOut(
        id=row.id,
        name=row.name,
        zone=row.zone,
        mode=row.mode,
        playlist_id=row.playlist_id,
        playlist_name=row.playlist.name if row.playlist else None,
        break_playlist_id=row.break_playlist_id,
        break_playlist_name=row.break_playlist.name if row.break_playlist else None,
        cec_enabled=row.cec_enabled,
        rotation=row.rotation,
        is_active=row.is_active,
        online=service.is_online(row, now),
        last_seen_at=row.last_seen_at,
        playing=state["playing"],
        play_url=f"/player/?k={row.play_token}",
    )


def slide_out(db: Session, row: Slide, today: date | None = None) -> SlideOut:
    names = db.scalars(
        select(Playlist.name)
        .join(PlaylistItem, PlaylistItem.playlist_id == Playlist.id)
        .where(PlaylistItem.slide_id == row.id)
        .order_by(Playlist.name)
    ).all()
    return SlideOut(
        id=row.id,
        kind=row.kind,
        title=row.title,
        subtitle=row.subtitle,
        price=row.price,
        old_price=row.old_price,
        badge=row.badge,
        image_url=f"/uploads/{row.image_path}" if row.image_path else None,
        duration_seconds=row.duration_seconds,
        starts_on=row.starts_on,
        ends_on=row.ends_on,
        is_active=row.is_active,
        is_live=service.slide_is_live(row, today or date.today()),
        playlists=list(names),
    )


def playlist_out(db: Session, row: Playlist) -> PlaylistOut:
    ids = db.scalars(
        select(PlaylistItem.slide_id)
        .where(PlaylistItem.playlist_id == row.id)
        .order_by(PlaylistItem.sort_order, PlaylistItem.id)
    ).all()
    return PlaylistOut(
        id=row.id,
        name=row.name,
        description=row.description,
        is_active=row.is_active,
        slide_ids=list(ids),
        live_count=len(service.playlist_slides(db, row.id)),
    )


def fixture_out(row: MatchFixture) -> FixtureOut:
    start = row.kickoff_at + timedelta(minutes=row.halftime_after_minutes)
    return FixtureOut(
        id=row.id,
        title=row.title,
        competition=row.competition,
        kickoff_at=row.kickoff_at,
        halftime_after_minutes=row.halftime_after_minutes,
        break_minutes=row.break_minutes,
        zone=row.zone,
        auto_break=row.auto_break,
        break_starts_at=start,
        break_ends_at=start + timedelta(minutes=row.break_minutes),
    )


# ------------------------------ الشاشات ------------------------------


@router.get("/screens", response_model=list[ScreenOut])
def list_screens(db: Session = Depends(get_db), user: User = Depends(require_manager)):
    now = datetime.now()
    rows = db.scalars(select(Screen).order_by(Screen.zone, Screen.name)).all()
    return [screen_out(db, row, now) for row in rows]


@router.post("/screens", response_model=ScreenOut, status_code=201)
def create_screen(
    payload: ScreenIn, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    _check_playlists(db, payload.playlist_id, payload.break_playlist_id)
    row = Screen(**payload.model_dump(), play_token=service.new_token())
    db.add(row)
    db.commit()
    db.refresh(row)
    audit.log(db, user, "create", "screen", row.id, f"شاشة: {row.name}")
    return screen_out(db, row)


@router.patch("/screens/{screen_id}", response_model=ScreenOut)
def update_screen(
    screen_id: int,
    payload: ScreenPatch,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    row = db.get(Screen, screen_id)
    if not row:
        raise HTTPException(status_code=404, detail="الشاشة غير موجودة")
    changes = payload.model_dump(exclude_unset=True)
    _check_playlists(db, changes.get("playlist_id"), changes.get("break_playlist_id"))
    for key, value in changes.items():
        setattr(row, key, value)
    db.commit()
    db.refresh(row)
    audit.log(db, user, "update", "screen", row.id, "، ".join(changes.keys()))
    return screen_out(db, row)


@router.post("/screens/{screen_id}/token", response_model=ScreenOut)
def rotate_screen_token(
    screen_id: int, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    """مفتاح جديد للشاشة: يُبطل الرابط القديم فوراً إن تسرّب أو بيع الجهاز."""
    row = db.get(Screen, screen_id)
    if not row:
        raise HTTPException(status_code=404, detail="الشاشة غير موجودة")
    row.play_token = service.new_token()
    db.commit()
    db.refresh(row)
    audit.log(db, user, "update", "screen", row.id, "تجديد مفتاح تشغيل الشاشة")
    return screen_out(db, row)


@router.delete("/screens/{screen_id}", status_code=204)
def delete_screen(screen_id: int, db: Session = Depends(get_db), user: User = Depends(require_hr)):
    row = db.get(Screen, screen_id)
    if not row:
        raise HTTPException(status_code=404, detail="الشاشة غير موجودة")
    name = row.name
    db.delete(row)
    db.commit()
    audit.log(db, user, "delete", "screen", screen_id, f"حذف شاشة: {name}")


@router.get("/zones", response_model=list[str])
def list_zones(db: Session = Depends(get_db), user: User = Depends(require_manager)):
    """مجموعات الشاشات المستخدمة فعلاً — تملأ قوائم اختيار الفاصل."""
    rows = db.scalars(select(Screen.zone).where(Screen.zone.is_not(None)).distinct()).all()
    return sorted({z for z in rows if z})


# ------------------------------ الشرائح ------------------------------


@router.get("/slides", response_model=list[SlideOut])
def list_slides(
    active_only: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    today = date.today()
    stmt = select(Slide).order_by(Slide.is_active.desc(), Slide.id.desc())
    rows = db.scalars(stmt).all()
    if active_only:
        rows = [r for r in rows if service.slide_is_live(r, today)]
    return [slide_out(db, row, today) for row in rows]


@router.post("/slides", response_model=SlideOut, status_code=201)
def create_slide(payload: SlideIn, db: Session = Depends(get_db), user: User = Depends(require_hr)):
    row = Slide(**payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    audit.log(db, user, "create", "slide", row.id, f"شريحة عرض: {row.title}")
    return slide_out(db, row)


@router.patch("/slides/{slide_id}", response_model=SlideOut)
def update_slide(
    slide_id: int,
    payload: SlidePatch,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    row = db.get(Slide, slide_id)
    if not row:
        raise HTTPException(status_code=404, detail="الشريحة غير موجودة")
    changes = payload.model_dump(exclude_unset=True)
    for key, value in changes.items():
        setattr(row, key, value)
    db.commit()
    db.refresh(row)
    audit.log(db, user, "update", "slide", row.id, "، ".join(changes.keys()))
    return slide_out(db, row)


@router.post("/slides/{slide_id}/image", response_model=SlideOut)
def upload_slide_image(
    slide_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    row = db.get(Slide, slide_id)
    if not row:
        raise HTTPException(status_code=404, detail="الشريحة غير موجودة")
    name = (file.filename or "").lower()
    suffix = "." + name.rsplit(".", 1)[-1] if "." in name else ""
    if suffix not in IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="نوع الصورة غير مدعوم (PNG أو JPG أو WEBP)")
    content = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="حجم الصورة أكبر من الحد المسموح")
    problem = content_problem(content, suffix)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    stored = f"slide_{row.id}_{secrets.token_hex(5)}{suffix}"
    (UPLOAD_DIR / stored).write_bytes(content)
    previous = row.image_path
    row.image_path = stored
    db.commit()
    if previous and previous != stored:
        (UPLOAD_DIR / previous).unlink(missing_ok=True)
    db.refresh(row)
    audit.log(db, user, "update", "slide", row.id, "تحديث صورة الشريحة")
    return slide_out(db, row)


@router.delete("/slides/{slide_id}", status_code=204)
def delete_slide(slide_id: int, db: Session = Depends(get_db), user: User = Depends(require_hr)):
    row = db.get(Slide, slide_id)
    if not row:
        raise HTTPException(status_code=404, detail="الشريحة غير موجودة")
    title, stored = row.title, row.image_path
    db.delete(row)
    db.commit()
    if stored:
        (UPLOAD_DIR / stored).unlink(missing_ok=True)
    audit.log(db, user, "delete", "slide", slide_id, f"حذف شريحة: {title}")


# ------------------------------ قوائم التشغيل ------------------------------


@router.get("/playlists", response_model=list[PlaylistOut])
def list_playlists(db: Session = Depends(get_db), user: User = Depends(require_manager)):
    rows = db.scalars(select(Playlist).order_by(Playlist.name)).all()
    return [playlist_out(db, row) for row in rows]


@router.post("/playlists", response_model=PlaylistOut, status_code=201)
def create_playlist(
    payload: PlaylistIn, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    if db.scalar(select(Playlist).where(Playlist.name == payload.name)):
        raise HTTPException(status_code=400, detail="يوجد قائمة تشغيل بهذا الاسم")
    row = Playlist(**payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    audit.log(db, user, "create", "playlist", row.id, f"قائمة تشغيل: {row.name}")
    return playlist_out(db, row)


@router.patch("/playlists/{playlist_id}", response_model=PlaylistOut)
def update_playlist(
    playlist_id: int,
    payload: PlaylistIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    row = _playlist_or_404(db, playlist_id)
    clash = db.scalar(
        select(Playlist).where(Playlist.name == payload.name, Playlist.id != playlist_id)
    )
    if clash:
        raise HTTPException(status_code=400, detail="يوجد قائمة تشغيل بهذا الاسم")
    for key, value in payload.model_dump().items():
        setattr(row, key, value)
    db.commit()
    db.refresh(row)
    audit.log(db, user, "update", "playlist", row.id, f"تعديل قائمة: {row.name}")
    return playlist_out(db, row)


@router.put("/playlists/{playlist_id}/items", response_model=PlaylistOut)
def set_playlist_items(
    playlist_id: int,
    payload: PlaylistItemsIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """يستبدل محتوى القائمة كاملاً بالترتيب المُرسل — أبسط من تحريك عنصر عنصر."""
    row = _playlist_or_404(db, playlist_id)
    seen: list[int] = []
    for slide_id in payload.slide_ids:
        if slide_id in seen:
            continue
        if not db.get(Slide, slide_id):
            raise HTTPException(status_code=400, detail=f"الشريحة {slide_id} غير موجودة")
        seen.append(slide_id)
    db.execute(delete(PlaylistItem).where(PlaylistItem.playlist_id == playlist_id))
    for order, slide_id in enumerate(seen):
        db.add(PlaylistItem(playlist_id=playlist_id, slide_id=slide_id, sort_order=order))
    db.commit()
    db.refresh(row)
    audit.log(db, user, "update", "playlist", row.id, f"ترتيب {len(seen)} شريحة")
    return playlist_out(db, row)


@router.delete("/playlists/{playlist_id}", status_code=204)
def delete_playlist(
    playlist_id: int, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    row = _playlist_or_404(db, playlist_id)
    used = db.scalar(
        select(func.count(Screen.id)).where(
            (Screen.playlist_id == playlist_id) | (Screen.break_playlist_id == playlist_id)
        )
    )
    if used:
        raise HTTPException(status_code=400, detail="القائمة مرتبطة بشاشات — غيّر قائمتها أولاً")
    name = row.name
    db.delete(row)
    db.commit()
    audit.log(db, user, "delete", "playlist", playlist_id, f"حذف قائمة: {name}")


# ------------------------------ المباريات ------------------------------


@router.get("/fixtures", response_model=list[FixtureOut])
def list_fixtures(
    upcoming_only: bool = True,
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    stmt = select(MatchFixture).order_by(MatchFixture.kickoff_at)
    if upcoming_only:
        stmt = stmt.where(MatchFixture.kickoff_at >= datetime.now() - timedelta(hours=4))
    return [fixture_out(row) for row in db.scalars(stmt).all()]


@router.post("/fixtures", response_model=FixtureOut, status_code=201)
def create_fixture(
    payload: FixtureIn, db: Session = Depends(get_db), user: User = Depends(require_manager)
):
    row = MatchFixture(**payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    audit.log(db, user, "create", "fixture", row.id, f"مباراة: {row.title}")
    return fixture_out(row)


@router.patch("/fixtures/{fixture_id}", response_model=FixtureOut)
def update_fixture(
    fixture_id: int,
    payload: FixtureIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    row = db.get(MatchFixture, fixture_id)
    if not row:
        raise HTTPException(status_code=404, detail="المباراة غير موجودة")
    for key, value in payload.model_dump().items():
        setattr(row, key, value)
    db.commit()
    db.refresh(row)
    audit.log(db, user, "update", "fixture", row.id, f"تعديل مباراة: {row.title}")
    return fixture_out(row)


@router.delete("/fixtures/{fixture_id}", status_code=204)
def delete_fixture(
    fixture_id: int, db: Session = Depends(get_db), user: User = Depends(require_manager)
):
    row = db.get(MatchFixture, fixture_id)
    if not row:
        raise HTTPException(status_code=404, detail="المباراة غير موجودة")
    title = row.title
    db.delete(row)
    db.commit()
    audit.log(db, user, "delete", "fixture", fixture_id, f"حذف مباراة: {title}")


# ------------------------------ الفاصل الإعلاني ------------------------------


def break_out(db: Session, row: BreakSession | None) -> BreakOut:
    if not row:
        return BreakOut(active=False)
    now = datetime.now()
    return BreakOut(
        id=row.id,
        zone=row.zone,
        started_at=row.started_at,
        ends_at=row.ends_at,
        seconds_left=max(0, int((row.ends_at - now).total_seconds())),
        playlist_id=row.playlist_id,
        note=row.note,
        started_by=row.started_by.username if row.started_by else None,
        active=row.stopped_at is None and row.ends_at > now,
    )


@router.get("/break", response_model=list[BreakOut])
def current_breaks(db: Session = Depends(get_db), user: User = Depends(require_manager)):
    now = datetime.now()
    rows = db.scalars(
        select(BreakSession)
        .where(BreakSession.stopped_at.is_(None), BreakSession.ends_at > now)
        .order_by(BreakSession.started_at.desc())
    ).all()
    return [break_out(db, row) for row in rows]


@router.post("/break/start", response_model=BreakOut, status_code=201)
def start_break(
    payload: BreakStartIn, db: Session = Depends(get_db), user: User = Depends(require_manager)
):
    """ابدأ الفاصل الآن — هذه هي الضغطة التي يستعملها الكاشير من جواله."""
    _check_playlists(db, payload.playlist_id)
    row = service.start_break(
        db,
        minutes=payload.minutes,
        zone=payload.zone,
        playlist_id=payload.playlist_id,
        trigger=BreakTrigger.manual,
        user_id=user.id,
        note=payload.note,
    )
    audit.log(
        db, user, "create", "break", row.id,
        f"فاصل إعلاني {payload.minutes} دقيقة على {payload.zone or 'كل الشاشات'}",
    )
    return break_out(db, row)


@router.post("/break/stop", response_model=dict)
def stop_break(
    zone: str | None = Query(default=None, max_length=60),
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    """أعد الشاشات إلى المباراة فوراً."""
    stopped = service.stop_break(db, zone=zone)
    if stopped:
        audit.log(db, user, "update", "break", None, f"إنهاء {stopped} فاصل إعلاني")
    return {"stopped": stopped}


# ------------------------------ تقرير العرض ------------------------------


class ReportRow(BaseModel):
    slide_id: int
    title: str
    impressions: int
    seconds: int


@router.get("/report", response_model=list[ReportRow])
def impressions_report(
    date_from: date | None = None,
    date_to: date | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    """كم مرة ظهر كل منتج أو إعلان، وكم ثانية — خلال الفترة المطلوبة."""
    start = datetime.combine(date_from or (date.today() - timedelta(days=29)), datetime.min.time())
    end = datetime.combine((date_to or date.today()) + timedelta(days=1), datetime.min.time())
    rows = db.execute(
        select(
            Slide.id,
            Slide.title,
            func.count(SlideImpression.id),
            func.coalesce(func.sum(SlideImpression.seconds), 0),
        )
        .join(SlideImpression, SlideImpression.slide_id == Slide.id)
        .where(SlideImpression.shown_at >= start, SlideImpression.shown_at < end)
        .group_by(Slide.id, Slide.title)
        .order_by(func.count(SlideImpression.id).desc())
    ).all()
    return [
        ReportRow(slide_id=r[0], title=r[1], impressions=r[2], seconds=int(r[3])) for r in rows
    ]


# ------------------------------ واجهة جهاز التشغيل ------------------------------
# لا تستعمل حساب مستخدم: الجهاز خلف الشاشة بلا لوحة مفاتيح، ومفتاحه في الرابط.


def _screen_by_token(db: Session, token: str) -> Screen:
    row = db.scalar(select(Screen).where(Screen.play_token == token))
    if not row or not row.is_active:
        raise HTTPException(status_code=404, detail="مفتاح الشاشة غير صالح")
    return row


@router.get("/play/{token}")
def play_state(
    token: str,
    db: Session = Depends(get_db),
    user_agent: str | None = Header(default=None),
):
    """ما تعرضه الشاشة الآن. الجهاز يسأل كل بضع ثوانٍ ويقارن `revision`."""
    screen = _screen_by_token(db, token)
    state = service.screen_state(db, screen)
    service.touch(db, screen, user_agent)
    return state


@router.post("/play/{token}/impression", status_code=204)
def log_impression(
    token: str, payload: ImpressionIn, db: Session = Depends(get_db)
):
    """الجهاز يبلّغ بما عرضه فعلاً — لا نفترض العرض من القائمة وحدها."""
    screen = _screen_by_token(db, token)
    if not db.get(Slide, payload.slide_id):
        raise HTTPException(status_code=404, detail="الشريحة غير موجودة")
    db.add(
        SlideImpression(
            screen_id=screen.id,
            slide_id=payload.slide_id,
            break_session_id=payload.break_session_id,
            shown_at=datetime.now(),
            seconds=payload.seconds,
        )
    )
    db.commit()
