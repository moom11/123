"""شاشات العرض: ماذا يجب أن تعرض كل شاشة في هذه اللحظة.

القاعدة: شاشة المباراة سوداء ما لم يكن هناك **فاصل** جارٍ — إما ضغطة يدوية من
الكاشير، وإما نافذة استراحة محسوبة من موعد مباراة مسجّلة. وشاشة الإعلانات
المخصّصة تعرض قائمتها طوال الوقت. الأوقات كلها بتوقيت الخادم المحلي كبقية النظام.
"""
from __future__ import annotations

import hashlib
import json
import secrets
from datetime import date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    BreakSession,
    BreakTrigger,
    MatchFixture,
    Playlist,
    PlaylistItem,
    Screen,
    ScreenMode,
    Slide,
)

# مهلة اعتبار جهاز التشغيل متصلاً: نبضة كل ٣٠ ثانية، فثلاث نبضات ضائعة تعني انقطاعاً
ONLINE_GRACE_SECONDS = 100


def new_token() -> str:
    """مفتاح تشغيل الشاشة: يقوم مقام كلمة المرور لجهاز بلا لوحة مفاتيح."""
    return secrets.token_urlsafe(24)


def zone_matches(target: str | None, screen_zone: str | None) -> bool:
    """فاصل بلا مجموعة يشمل كل الشاشات، وفاصل بمجموعة يشمل شاشاتها وحدها."""
    return target is None or target == "" or target == (screen_zone or "")


# ------------------------------ الفواصل ------------------------------


def active_break(db: Session, screen: Screen, now: datetime | None = None) -> BreakSession | None:
    """الفاصل اليدوي الجاري الذي يشمل هذه الشاشة، إن وُجد."""
    now = now or datetime.now()
    rows = db.scalars(
        select(BreakSession)
        .where(
            BreakSession.stopped_at.is_(None),
            BreakSession.started_at <= now,
            BreakSession.ends_at > now,
        )
        .order_by(BreakSession.started_at.desc())
    ).all()
    for row in rows:
        if zone_matches(row.zone, screen.zone):
            return row
    return None


def fixture_window(db: Session, screen: Screen, now: datetime | None = None) -> MatchFixture | None:
    """مباراة نحن الآن داخل نافذة استراحتها المحسوبة من موعد انطلاقها."""
    now = now or datetime.now()
    earliest = now - timedelta(hours=4)
    rows = db.scalars(
        select(MatchFixture)
        .where(MatchFixture.auto_break.is_(True), MatchFixture.kickoff_at >= earliest,
               MatchFixture.kickoff_at <= now)
        .order_by(MatchFixture.kickoff_at.desc())
    ).all()
    for fixture in rows:
        if not zone_matches(fixture.zone, screen.zone):
            continue
        start = fixture.kickoff_at + timedelta(minutes=fixture.halftime_after_minutes)
        if start <= now < start + timedelta(minutes=fixture.break_minutes):
            return fixture
    return None


def start_break(
    db: Session,
    minutes: int,
    zone: str | None = None,
    playlist_id: int | None = None,
    trigger: BreakTrigger = BreakTrigger.manual,
    fixture_id: int | None = None,
    user_id: int | None = None,
    note: str | None = None,
) -> BreakSession:
    """يبدأ فاصلاً الآن. أي فاصل جارٍ يشمل المجموعة نفسها يُنهى أولاً فلا يتداخلان."""
    now = datetime.now()
    stop_break(db, zone=zone, commit=False)
    row = BreakSession(
        zone=zone or None,
        started_at=now,
        ends_at=now + timedelta(minutes=max(1, minutes)),
        trigger=trigger,
        fixture_id=fixture_id,
        playlist_id=playlist_id,
        started_by_id=user_id,
        note=note,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def stop_break(db: Session, zone: str | None = None, commit: bool = True) -> int:
    """يُنهي الفواصل الجارية التي تتقاطع مع المجموعة المطلوبة. يعيد عددها."""
    now = datetime.now()
    rows = db.scalars(
        select(BreakSession).where(BreakSession.stopped_at.is_(None), BreakSession.ends_at > now)
    ).all()
    stopped = 0
    for row in rows:
        # تقاطع: فاصل عام يشمل أي مجموعة، وإنهاء عام يُنهي الجميع
        if zone in (None, "") or row.zone in (None, "") or row.zone == zone:
            row.stopped_at = now
            stopped += 1
    if commit:
        db.commit()
    return stopped


# ------------------------------ الشرائح وقوائم التشغيل ------------------------------


def slide_is_live(slide: Slide, today: date) -> bool:
    if not slide.is_active:
        return False
    if slide.starts_on and today < slide.starts_on:
        return False
    if slide.ends_on and today > slide.ends_on:
        return False
    return True


def playlist_slides(db: Session, playlist_id: int | None, today: date | None = None) -> list[Slide]:
    """شرائح القائمة بترتيبها، بعد استبعاد المعطّل ومنتهي الصلاحية."""
    if not playlist_id:
        return []
    today = today or date.today()
    rows = db.scalars(
        select(Slide)
        .join(PlaylistItem, PlaylistItem.slide_id == Slide.id)
        .where(PlaylistItem.playlist_id == playlist_id)
        .order_by(PlaylistItem.sort_order, PlaylistItem.id)
    ).all()
    return [s for s in rows if slide_is_live(s, today)]


def slide_payload(slide: Slide) -> dict:
    return {
        "id": slide.id,
        "kind": slide.kind.value,
        "title": slide.title,
        "subtitle": slide.subtitle,
        "price": slide.price,
        "old_price": slide.old_price,
        "badge": slide.badge,
        "image_url": f"/uploads/{slide.image_path}" if slide.image_path else None,
        "duration": max(2, slide.duration_seconds or 8),
    }


# ------------------------------ حالة الشاشة ------------------------------


def screen_state(db: Session, screen: Screen, now: datetime | None = None) -> dict:
    """ما تعرضه الشاشة الآن: الحالة، القائمة، ومتى ينتهي الفاصل.

    `revision` بصمة للمحتوى: يبقى ثابتاً ما دام المعروض هو نفسه، فلا يعيد
    الجهاز بناء العرض مع كل نبضة ولا تقفز الشريحة الظاهرة.
    """
    now = now or datetime.now()
    today = now.date()
    session = active_break(db, screen, now)
    fixture = None if session else fixture_window(db, screen, now)

    if session or fixture:
        playing = "break"
        ends_at = (
            session.ends_at
            if session
            else fixture.kickoff_at
            + timedelta(minutes=fixture.halftime_after_minutes + fixture.break_minutes)
        )
        playlist_id = (
            (session.playlist_id if session else None)
            or screen.break_playlist_id
            or screen.playlist_id
        )
        label = (session.note if session else fixture.title) or "فاصل إعلاني"
    elif screen.mode == ScreenMode.always:
        playing = "always"
        ends_at = None
        playlist_id = screen.playlist_id
        label = None
    else:
        playing = "idle"
        ends_at = None
        playlist_id = None
        label = None

    slides = [slide_payload(s) for s in playlist_slides(db, playlist_id, today)]
    playlist = db.get(Playlist, playlist_id) if playlist_id else None
    if playlist and not playlist.is_active:
        slides = []

    payload = {
        "screen_id": screen.id,
        "screen_name": screen.name,
        "zone": screen.zone,
        "mode": screen.mode.value,
        "rotation": screen.rotation,
        "cec_enabled": screen.cec_enabled,
        "playing": playing,
        "label": label,
        "playlist_id": playlist_id,
        "playlist_name": playlist.name if playlist else None,
        "break_session_id": session.id if session else None,
        "ends_at": ends_at.isoformat(timespec="seconds") if ends_at else None,
        "seconds_left": int((ends_at - now).total_seconds()) if ends_at else None,
        "server_time": now.isoformat(timespec="seconds"),
        "slides": slides,
        "poll_seconds": 10 if playing == "idle" else 20,
    }
    payload["revision"] = _revision(payload)
    return payload


def _revision(payload: dict) -> str:
    """بصمة المحتوى وحده: لا تشمل الوقت ولا العدّاد التنازلي."""
    seed = json.dumps(
        {
            "playing": payload["playing"],
            "label": payload["label"],
            "rotation": payload["rotation"],
            "break": payload["break_session_id"],
            "ends_at": payload["ends_at"],
            "slides": payload["slides"],
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]


def touch(db: Session, screen: Screen, agent: str | None = None) -> None:
    """تسجيل نبضة الجهاز حتى تُظهر لوحة التحكم الشاشات المنقطعة."""
    screen.last_seen_at = datetime.now()
    if agent:
        screen.last_agent = agent[:160]
    db.commit()


def is_online(screen: Screen, now: datetime | None = None) -> bool:
    if not screen.last_seen_at:
        return False
    now = now or datetime.now()
    return (now - screen.last_seen_at).total_seconds() <= ONLINE_GRACE_SECONDS
