"""اختبارات شاشات العرض: دورة الفاصل، اشتقاقه من موعد المباراة، وحماية مفتاح الشاشة."""
from __future__ import annotations

import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest

TMP = tempfile.mkdtemp(prefix="signage_test_")
os.environ["HR_DATA_DIR"] = TMP
os.environ.setdefault("HR_DATABASE_URL", f"sqlite:///{Path(TMP) / 'test.db'}")
os.environ["HR_ADMIN_PASSWORD"] = "admin123"

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.seed import init_db  # noqa: E402


@pytest.fixture(scope="module")
def client():
    init_db()
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    from app import security_extra

    security_extra.reset_rate()
    yield


@pytest.fixture(scope="module")
def auth(client):
    res = client.post("/api/auth/login", data={"username": "admin", "password": "admin123"})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


@pytest.fixture(scope="module")
def setup(client, auth):
    """شاشة مباراة وشاشة إعلانات، وقائمة عرض فيها شريحتان."""
    playlist = client.post("/api/signage/playlists", headers=auth,
                           json={"name": "عروض الفاصل"}).json()
    slides = [
        client.post("/api/signage/slides", headers=auth, json={
            "kind": "product", "title": f"منتج {i}", "price": 25.0 + i, "duration_seconds": 6,
        }).json()
        for i in range(2)
    ]
    res = client.put(f"/api/signage/playlists/{playlist['id']}/items", headers=auth,
                     json={"slide_ids": [s["id"] for s in slides]})
    assert res.status_code == 200, res.text

    match_screen = client.post("/api/signage/screens", headers=auth, json={
        "name": "شاشة الصالة ١", "zone": "الصالة", "mode": "break_only",
        "break_playlist_id": playlist["id"],
    }).json()
    always_screen = client.post("/api/signage/screens", headers=auth, json={
        "name": "شاشة الكاشير", "zone": "الكاشير", "mode": "always",
        "playlist_id": playlist["id"],
    }).json()
    return {"playlist": playlist, "slides": slides,
            "match": match_screen, "always": always_screen}


def _key(screen):
    return screen["play_url"].split("k=")[1]


def test_match_screen_is_dark_until_a_break(client, setup):
    state = client.get(f"/api/signage/play/{_key(setup['match'])}").json()
    assert state["playing"] == "idle"
    assert state["slides"] == []


def test_ads_screen_plays_all_the_time(client, setup):
    state = client.get(f"/api/signage/play/{_key(setup['always'])}").json()
    assert state["playing"] == "always"
    assert len(state["slides"]) == 2
    assert state["slides"][0]["title"] == "منتج 0"


def test_break_cycle(client, auth, setup):
    started = client.post("/api/signage/break/start", headers=auth,
                          json={"minutes": 10, "zone": "الصالة"})
    assert started.status_code == 201, started.text

    state = client.get(f"/api/signage/play/{_key(setup['match'])}").json()
    assert state["playing"] == "break"
    assert len(state["slides"]) == 2
    assert 0 < state["seconds_left"] <= 600

    # مجموعة أخرى لا يمسّها فاصل «الصالة»
    other = client.get(f"/api/signage/play/{_key(setup['always'])}").json()
    assert other["playing"] == "always"

    stopped = client.post("/api/signage/break/stop?zone=الصالة", headers=auth)
    assert stopped.json()["stopped"] == 1
    back = client.get(f"/api/signage/play/{_key(setup['match'])}").json()
    assert back["playing"] == "idle"


def test_starting_a_break_replaces_the_running_one(client, auth, setup):
    client.post("/api/signage/break/start", headers=auth, json={"minutes": 5, "zone": "الصالة"})
    client.post("/api/signage/break/start", headers=auth, json={"minutes": 20, "zone": "الصالة"})
    rows = client.get("/api/signage/break", headers=auth).json()
    assert len([r for r in rows if r["zone"] == "الصالة"]) == 1
    assert rows[0]["seconds_left"] > 600
    client.post("/api/signage/break/stop", headers=auth)


def test_fixture_opens_and_closes_its_own_break(client, auth, setup):
    """مباراة انطلقت قبل ٥٠ دقيقة: نحن داخل نافذة استراحتها."""
    kickoff = datetime.now() - timedelta(minutes=50)
    fixture = client.post("/api/signage/fixtures", headers=auth, json={
        "title": "مباراة الاختبار", "kickoff_at": kickoff.isoformat(timespec="seconds"),
        "halftime_after_minutes": 47, "break_minutes": 12, "zone": "الصالة",
    })
    assert fixture.status_code == 201, fixture.text

    state = client.get(f"/api/signage/play/{_key(setup['match'])}").json()
    assert state["playing"] == "break"
    assert state["label"] == "مباراة الاختبار"

    # خارج النافذة: نفس المباراة بعد انتهاء استراحتها
    client.patch(f"/api/signage/fixtures/{fixture.json()['id']}", headers=auth, json={
        "title": "مباراة الاختبار",
        "kickoff_at": (datetime.now() - timedelta(minutes=120)).isoformat(timespec="seconds"),
        "halftime_after_minutes": 47, "break_minutes": 12, "zone": "الصالة",
    })
    after = client.get(f"/api/signage/play/{_key(setup['match'])}").json()
    assert after["playing"] == "idle"
    client.delete(f"/api/signage/fixtures/{fixture.json()['id']}", headers=auth)


def test_expired_slide_is_dropped_from_the_playlist(client, auth, setup):
    slide = setup["slides"][0]
    yesterday = (datetime.now() - timedelta(days=1)).date().isoformat()
    client.patch(f"/api/signage/slides/{slide['id']}", headers=auth, json={"ends_on": yesterday})
    state = client.get(f"/api/signage/play/{_key(setup['always'])}").json()
    assert [s["id"] for s in state["slides"]] == [setup["slides"][1]["id"]]
    client.patch(f"/api/signage/slides/{slide['id']}", headers=auth, json={"ends_on": None})


def test_revision_is_stable_while_content_is(client, setup):
    first = client.get(f"/api/signage/play/{_key(setup['always'])}").json()
    second = client.get(f"/api/signage/play/{_key(setup['always'])}").json()
    assert first["revision"] == second["revision"]


def test_bad_key_is_rejected(client):
    assert client.get("/api/signage/play/not-a-real-key").status_code == 404


def test_rotating_the_key_kills_the_old_link(client, auth, setup):
    screen = client.post("/api/signage/screens", headers=auth,
                         json={"name": "شاشة مؤقتة", "mode": "always"}).json()
    old = _key(screen)
    assert client.get(f"/api/signage/play/{old}").status_code == 200
    rotated = client.post(f"/api/signage/screens/{screen['id']}/token", headers=auth).json()
    assert client.get(f"/api/signage/play/{old}").status_code == 404
    assert client.get(f"/api/signage/play/{_key(rotated)}").status_code == 200
    client.delete(f"/api/signage/screens/{screen['id']}", headers=auth)


def test_screen_management_needs_hr_role(client, auth):
    assert client.get("/api/signage/screens").status_code == 401
    assert client.post("/api/signage/screens", json={"name": "بلا إذن"}).status_code == 401


def test_impressions_feed_the_report(client, auth, setup):
    key = _key(setup["always"])
    slide_id = setup["slides"][1]["id"]
    for _ in range(3):
        res = client.post(f"/api/signage/play/{key}/impression",
                          json={"slide_id": slide_id, "seconds": 6})
        assert res.status_code == 204, res.text
    rows = client.get("/api/signage/report", headers=auth).json()
    row = next(r for r in rows if r["slide_id"] == slide_id)
    assert row["impressions"] >= 3
    assert row["seconds"] >= 18


def test_playlist_in_use_cannot_be_deleted(client, auth, setup):
    res = client.delete(f"/api/signage/playlists/{setup['playlist']['id']}", headers=auth)
    assert res.status_code == 400


def test_heartbeat_marks_the_screen_online(client, auth, setup):
    client.get(f"/api/signage/play/{_key(setup['always'])}")
    rows = client.get("/api/signage/screens", headers=auth).json()
    row = next(r for r in rows if r["id"] == setup["always"]["id"])
    assert row["online"] is True
