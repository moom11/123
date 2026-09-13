"""تقارير الإدارة الموقّعة: مستند جاهز للطباعة أو الحفظ PDF بتوقيع معتمد.

التوقيع يُضمَّن في المستند نفسه (data URI) لا كرابط، فيبقى ظاهراً في ملف الـPDF
بعد حفظه أو إرساله. وكل تقرير يحمل رقماً ووقت إصدار واسم من أصدره، فيُعرف
أصله ولا يُنسب إلى الإدارة ما لم يصدر عنها.
"""
from __future__ import annotations

import secrets
from datetime import date, datetime
from html import escape

from sqlalchemy.orm import Session

from ..config import UPLOAD_DIR
from . import settings_store
from . import signature as signature_service

MONTHS = [
    "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
    "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
]


def month_label(year: int, month: int) -> str:
    return f"{MONTHS[month - 1]} {year}"


def _signature_block(name: str, title: str, image: str | None) -> str:
    """خانة توقيع: الصورة إن رُفعت، وإلا سطر يُوقَّع عليه يدوياً."""
    inner = (f'<img class="sig" src="{image}" alt="" />' if image
             else '<span class="sig-line"></span>')
    return f"""
      <div class="sign">
        <div class="title">{escape(title or '')}</div>
        <div class="space">{inner}</div>
        <div class="name">{escape(name or '............................')}</div>
      </div>"""


def signatures_html(db: Session, extra: list[tuple[str, str, str | None]] | None = None) -> str:
    """توقيعات المنشأة كما ضُبطت في الإعدادات، مع أي توقيع إضافي."""
    values = settings_store.get_all(db)
    blocks: list[str] = []
    for role, default_title in (("hr", "الموارد البشرية"), ("manager", "المدير العام")):
        path = values.get(f"signature_{role}_path") or ""
        image = signature_service.data_uri(UPLOAD_DIR / path) if path else None
        blocks.append(_signature_block(
            values.get(f"signatory_{role}_name") or "",
            values.get(f"signatory_{role}_title") or default_title,
            image,
        ))
    for title, name, image in (extra or []):
        blocks.append(_signature_block(name, title, image))
    return f'<div class="signs">{"".join(blocks)}</div>'


def document(
    db: Session,
    *,
    title: str,
    period: str,
    columns: list[str],
    rows: list[list[str]],
    summary: list[tuple[str, str]] | None = None,
    note: str | None = None,
    issued_by: str = "",
    extra_signatures: list[tuple[str, str, str | None]] | None = None,
    numeric_from: int = 2,
) -> str:
    """يبني صفحة تقرير كاملة جاهزة للطباعة (Ctrl+P ← حفظ PDF)."""
    values = settings_store.get_all(db)
    company = values.get("company_name") or "نظام الموارد البشرية"
    logo_path = values.get("logo_path") or ""
    logo = signature_service.data_uri(UPLOAD_DIR / logo_path) if logo_path.endswith(".png") else None
    logo_html = (f'<img class="logo" src="{logo}" alt="" />' if logo
                 else (f'<img class="logo" src="/uploads/{escape(logo_path)}" alt="" />'
                       if logo_path else ""))

    ref = f"{date.today():%Y%m}-{secrets.token_hex(3).upper()}"
    head = "".join(f"<th{' class=num' if i >= numeric_from else ''}>{escape(c)}</th>"
                   for i, c in enumerate(columns))
    body = "".join(
        "<tr>" + "".join(
            f"<td{' class=num' if i >= numeric_from else ''}>{escape(str(cell))}</td>"
            for i, cell in enumerate(row)
        ) + "</tr>"
        for row in rows
    ) or f'<tr><td colspan="{len(columns)}" class="empty">لا بيانات في هذه الفترة</td></tr>'

    summary_html = ""
    if summary:
        summary_html = '<div class="summary">' + "".join(
            f"<div><span>{escape(label)}</span><b>{escape(str(value))}</b></div>"
            for label, value in summary
        ) + "</div>"

    return f"""<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>{escape(title)} — {escape(period)}</title>
<style>{_STYLE}</style></head><body>
<div class="bar no-print">
  <button onclick="window.print()">طباعة / حفظ PDF</button>
  <button class="ghost" onclick="window.close()">إغلاق</button>
</div>
<section class="page">
  <header>
    <div class="brand">{logo_html}
      <div><h1>{escape(company)}</h1><div class="sub">{escape(title)}</div></div></div>
    <div class="meta">
      <div><span>الفترة</span><b>{escape(period)}</b></div>
      <div><span>رقم التقرير</span><b>{ref}</b></div>
      <div><span>تاريخ الإصدار</span><b>{datetime.now():%Y-%m-%d %H:%M}</b></div>
      {f'<div><span>أصدره</span><b>{escape(issued_by)}</b></div>' if issued_by else ''}
    </div>
  </header>

  {summary_html}

  <table>
    <thead><tr>{head}</tr></thead>
    <tbody>{body}</tbody>
  </table>

  {f'<div class="note">{escape(note)}</div>' if note else ''}

  <div class="approve">أقرّ بصحة البيانات الواردة أعلاه واعتمادها.</div>
  {signatures_html(db, extra_signatures)}

  <footer>صادر إلكترونياً من نظام الموارد البشرية — {escape(company)} · رقم {ref}</footer>
</section>
</body></html>"""


_STYLE = """
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin:0; background:#f1f5f9; color:#0f172a; font-size:12px;
    font-family:"Tajawal","Cairo","Segoe UI",Tahoma,Arial,sans-serif; }
  .bar { position:sticky; top:0; display:flex; gap:10px; justify-content:center;
    padding:12px; background:#2563eb; z-index:5; }
  .bar button { border:none; background:#fff; color:#2563eb; font:inherit; font-weight:600;
    padding:9px 18px; border-radius:9px; cursor:pointer; }
  .bar button.ghost { background:transparent; color:#fff; border:1px solid rgba(255,255,255,.6); }
  .page { background:#fff; width:277mm; min-height:190mm; margin:16px auto; padding:12mm;
    box-shadow:0 6px 24px rgba(20,40,60,.12); }
  header { display:flex; justify-content:space-between; align-items:flex-start; gap:16px;
    border-bottom:2px solid #0f172a; padding-bottom:10px; margin-bottom:12px; }
  .brand { display:flex; gap:12px; align-items:center; }
  .logo { height:52px; width:auto; object-fit:contain; }
  h1 { margin:0; font-size:19px; }
  .sub { color:#475569; font-size:13px; margin-top:2px; font-weight:600; }
  .meta { display:grid; grid-template-columns:repeat(2,auto); gap:4px 18px; font-size:11.5px; }
  .meta span { color:#64748b; margin-inline-end:6px; }
  .summary { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:12px; }
  .summary div { border:1px solid #e2e8f0; border-radius:8px; padding:7px 12px; background:#f8fafc; }
  .summary span { color:#64748b; display:block; font-size:10.5px; }
  .summary b { font-size:14px; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th, td { border:1px solid #e2e8f0; padding:5px 7px; text-align:right; }
  thead th { background:#0f172a; color:#fff; font-weight:600; }
  tbody tr:nth-child(even) { background:#f8fafc; }
  td.num, th.num { text-align:center; font-variant-numeric:tabular-nums; }
  td.empty { text-align:center; color:#94a3b8; padding:18px; }
  .note { margin-top:10px; font-size:11px; color:#475569; border-inline-start:3px solid #cbd5e1;
    padding-inline-start:8px; }
  .approve { margin-top:18px; font-size:12px; font-weight:600; }
  .signs { display:flex; gap:24px; margin-top:6px; flex-wrap:wrap; }
  .sign { flex:1; min-width:170px; text-align:center; }
  .sign .title { font-size:11.5px; color:#475569; margin-bottom:2px; }
  .sign .space { height:58px; display:flex; align-items:flex-end; justify-content:center;
    border-bottom:1px solid #0f172a; }
  .sign .sig { max-height:56px; max-width:100%; object-fit:contain; }
  .sign .sig-line { display:block; height:1px; }
  .sign .name { font-size:11.5px; font-weight:600; margin-top:5px; }
  footer { margin-top:14px; padding-top:8px; border-top:1px solid #e2e8f0;
    text-align:center; color:#94a3b8; font-size:10.5px; }
  @media print { body { background:#fff; } .no-print { display:none !important; }
    .page { width:auto; margin:0; padding:0; box-shadow:none; } }
"""
