"""قسيمة راتب أنيقة قابلة للطباعة أو الحفظ PDF (HTML مستقل بلا مكتبات خارجية).

المتصفح هو من يحوّلها إلى PDF عبر «طباعة ← حفظ بصيغة PDF»، فتظهر العربية بخطها الصحيح
دون الحاجة إلى خطوط أو حزم إضافية على الخادم.
"""
from __future__ import annotations

from datetime import date
from html import escape

from sqlalchemy.orm import Session

from ..models import PayrollRun, Payslip
from . import settings_store

MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
          "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"]

_ONES = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة",
         "عشرة", "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر",
         "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"]
_TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"]
_HUNDREDS = ["", "مئة", "مئتان", "ثلاثمئة", "أربعمئة", "خمسمئة",
             "ستمئة", "سبعمئة", "ثمانمئة", "تسعمئة"]


def _under_thousand(number: int) -> str:
    parts: list[str] = []
    hundreds, rest = divmod(number, 100)
    if hundreds:
        parts.append(_HUNDREDS[hundreds])
    if rest:
        if rest < 20:
            parts.append(_ONES[rest])
        else:
            tens, ones = divmod(rest, 10)
            parts.append(f"{_ONES[ones]} و{_TENS[tens]}" if ones else _TENS[tens])
    return " و".join(parts)


def _group(number: int, singular: str, dual: str, plural: str) -> str:
    """صيغة الألف/المليون حسب العدد (ألف، ألفان، ثلاثة آلاف…)."""
    if number == 1:
        return singular
    if number == 2:
        return dual
    if 3 <= number <= 10:
        return f"{_under_thousand(number)} {plural}"
    return f"{_under_thousand(number)} {singular}"


def _unit(count: int, singular: str, dual: str, plural: str, accusative: str) -> str:
    """تمييز العدد: ريال واحد، ريالان، ثلاثة ريالات، خمسة عشر ريالاً، مئة ريال."""
    rest = count % 100
    if count == 1:
        return f"{singular} واحد" if singular == "ريال" else f"{singular} واحدة"
    if count == 2:
        return dual
    if 3 <= rest <= 10:
        return plural
    if rest == 0:
        return singular
    return accusative


def _amount_part(count: int, singular: str, dual: str, plural: str, accusative: str) -> str:
    """يجمع العدد مع تمييزه (والعددان ١ و٢ يُذكران بالتمييز وحده)."""
    if count in (1, 2):
        return _unit(count, singular, dual, plural, accusative)
    chunks: list[str] = []
    millions, rest = divmod(count, 1_000_000)
    thousands, units = divmod(rest, 1000)
    if millions:
        chunks.append(_group(millions, "مليون", "مليونان", "ملايين"))
    if thousands:
        chunks.append(_group(thousands, "ألف", "ألفان", "آلاف"))
    if units:
        chunks.append(_under_thousand(units))
    words = " و".join(chunk for chunk in chunks if chunk)
    return f"{words} {_unit(count, singular, dual, plural, accusative)}"


def amount_in_words(amount: float) -> str:
    """تفقيط المبلغ بالريال والهللة."""
    amount = round(float(amount or 0), 2)
    riyals = int(amount)
    halalas = int(round((amount - riyals) * 100))
    if riyals == 0 and halalas == 0:
        return "صفر ريال"

    parts: list[str] = []
    if riyals:
        parts.append(_amount_part(riyals, "ريال", "ريالان", "ريالات", "ريالاً"))
    if halalas:
        parts.append(_amount_part(halalas, "هللة", "هللتان", "هللات", "هللة"))
    return " و".join(parts)


def _money(value: float | None) -> str:
    return f"{float(value or 0):,.2f}"


def _row(label: str, value: float, tone: str = "") -> str:
    return (f'<tr class="{tone}"><td>{escape(label)}</td>'
            f'<td class="num">{_money(value)}</td></tr>')


def payslip_html(db: Session, slip: Payslip, run: PayrollRun) -> str:
    """قسيمة موظف واحد (جسم الصفحة فقط)."""
    employee = slip.employee
    company = settings_store.get(db, "company_name") or "نظام الموارد البشرية"
    logo = settings_store.get(db, "logo_path")
    logo_html = (f'<img class="logo" src="/uploads/{escape(logo)}" alt="" />' if logo else "")
    period = f"{MONTHS[run.month - 1]} {run.year}"

    earnings = [
        ("الراتب الأساسي", slip.basic_salary),
        ("البدلات", slip.allowances or 0),
        ("بدل العمل الإضافي", slip.overtime_amount),
        ("إضافات أخرى", slip.other_additions),
    ]
    deductions = [
        ("خصم الغياب", slip.absence_deduction),
        ("خصم التأخير", slip.late_deduction),
        ("إجازة بدون راتب", slip.unpaid_leave_deduction),
        ("خصم المخالفات", slip.violation_deduction),
        ("قسط السلفة", slip.loan_deduction or 0),
        ("خصومات أخرى", slip.other_deductions),
    ]
    total_earnings = round(sum(value for _, value in earnings), 2)
    total_deductions = round(sum(value for _, value in deductions), 2)

    return f"""
  <section class="slip">
    <header>
      <div class="brand">{logo_html}
        <div><h1>{escape(company)}</h1><div class="sub">قسيمة راتب — {period}</div></div>
      </div>
      <div class="meta">
        <div><span>رقم القسيمة</span><b>{slip.id}</b></div>
        <div><span>تاريخ الإصدار</span><b>{date.today().isoformat()}</b></div>
        <div><span>الحالة</span><b>{'معتمد' if run.status.value == 'approved' else 'مسودة'}</b></div>
      </div>
    </header>

    <div class="who">
      <div><span>الموظف</span><b>{escape(employee.full_name if employee else '')}</b></div>
      <div><span>رقم الموظف</span><b>{escape(employee.code if employee else '')}</b></div>
      <div><span>المسمى الوظيفي</span><b>{escape((employee.job_title if employee else '') or '—')}</b></div>
      <div><span>الإدارة</span><b>{escape(
        (employee.department.name if employee and employee.department else '') or '—')}</b></div>
      <div><span>تاريخ التعيين</span><b>{employee.hire_date.isoformat() if employee and employee.hire_date else '—'}</b></div>
      <div><span>الوردية</span><b>{escape(
        (employee.shift.name if employee and employee.shift else '') or '—')}</b></div>
    </div>

    <div class="stats">
      <div><span>أيام الحضور</span><b>{slip.present_days}</b></div>
      <div><span>أيام الغياب</span><b>{slip.absent_days}</b></div>
      <div><span>إجازات مدفوعة</span><b>{_money(slip.paid_leave_days)}</b></div>
      <div><span>دقائق التأخير</span><b>{slip.late_minutes}</b></div>
      <div><span>دقائق الإضافي</span><b>{slip.overtime_minutes}</b></div>
    </div>

    <div class="tables">
      <table>
        <thead><tr><th>المستحقات</th><th class="num">ريال</th></tr></thead>
        <tbody>{''.join(_row(label, value) for label, value in earnings)}
          <tr class="total"><td>إجمالي المستحقات</td><td class="num">{_money(total_earnings)}</td></tr>
        </tbody>
      </table>
      <table>
        <thead><tr><th>الاستقطاعات</th><th class="num">ريال</th></tr></thead>
        <tbody>{''.join(_row(label, value) for label, value in deductions)}
          <tr class="total"><td>إجمالي الاستقطاعات</td><td class="num">{_money(total_deductions)}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="net">
      <div class="label">صافي الراتب المستحق</div>
      <div class="value">{_money(slip.net_pay)} <span>ريال</span></div>
      <div class="words">فقط {escape(amount_in_words(slip.net_pay))} لا غير</div>
    </div>

    {f'<div class="note">ملاحظة: {escape(slip.note)}</div>' if slip.note else ''}

    <div class="signs">
      <div><span>توقيع الموظف</span><i></i></div>
      <div><span>الموارد البشرية</span><i></i></div>
      <div><span>الإدارة المالية</span><i></i></div>
    </div>
    <footer>هذه القسيمة صادرة إلكترونياً من نظام الموارد البشرية — {escape(company)}</footer>
  </section>"""


_STYLE = """
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin:0; background:#f8fafc; color:#1e293b; font-size:13px;
    font-family:"Tajawal","Cairo","Segoe UI",Tahoma,Arial,sans-serif; }
  .bar { position:sticky; top:0; display:flex; gap:10px; justify-content:center;
    padding:12px; background:#2563eb; }
  .bar button { border:none; background:#fff; color:#2563eb; font:inherit; font-weight:600;
    padding:9px 18px; border-radius:9px; cursor:pointer; }
  .bar button.ghost { background:transparent; color:#fff; border:1px solid rgba(255,255,255,.6); }
  .slip { background:#fff; width:190mm; min-height:260mm; margin:16px auto; padding:16mm 14mm;
    box-shadow:0 6px 24px rgba(20,40,60,.12); page-break-after:always; }
  .slip:last-of-type { page-break-after:auto; }
  header { display:flex; justify-content:space-between; align-items:flex-start; gap:16px;
    border-bottom:2px solid #2563eb; padding-bottom:12px; }
  .brand { display:flex; gap:12px; align-items:center; }
  .logo { max-height:56px; max-width:150px; object-fit:contain; }
  header h1 { margin:0; font-size:20px; }
  header .sub { color:#64748b; font-size:13px; margin-top:3px; }
  .meta { display:grid; gap:4px; font-size:12px; text-align:left; }
  .meta span { color:#64748b; margin-left:6px; }
  .who, .stats { display:grid; gap:10px 18px; margin-top:14px; }
  .who { grid-template-columns:repeat(3,1fr); }
  .stats { grid-template-columns:repeat(5,1fr); background:#f8fafc; border:1px solid #e2e8f0;
    border-radius:10px; padding:12px; margin-top:14px; text-align:center; }
  .who span, .stats span { display:block; color:#64748b; font-size:11.5px; margin-bottom:3px; }
  .who b, .stats b { font-size:13.5px; }
  .tables { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:16px; }
  table { width:100%; border-collapse:collapse; }
  th, td { padding:7px 9px; border-bottom:1px solid #e2e8f0; text-align:right; font-size:12.5px; }
  thead th { background:#2563eb; color:#fff; font-size:12.5px; }
  td.num, th.num { text-align:left; font-variant-numeric:tabular-nums; }
  tr.total td { background:#f1f5f9; font-weight:700; border-top:1px solid #cbd5e1; }
  .net { margin-top:16px; border:2px solid #2563eb; border-radius:12px; padding:14px 16px;
    display:flex; flex-wrap:wrap; align-items:center; gap:8px 18px; background:#eff6ff; }
  .net .label { font-weight:700; }
  .net .value { font-size:24px; font-weight:700; color:#2563eb; font-variant-numeric:tabular-nums; }
  .net .value span { font-size:14px; }
  .net .words { width:100%; color:#334155; font-size:12.5px; }
  .note { margin-top:12px; font-size:12.5px; color:#64748b; }
  .signs { display:grid; grid-template-columns:repeat(3,1fr); gap:20px; margin-top:34px; }
  .signs span { display:block; font-size:12px; color:#64748b; margin-bottom:26px; }
  .signs i { display:block; border-top:1px dashed #94a3b8; }
  footer { margin-top:22px; text-align:center; color:#94a3b8; font-size:11px; }
  @media print { .bar { display:none; } body { background:#fff; }
    .slip { box-shadow:none; margin:0; width:auto; min-height:auto; padding:0; } }
"""


def document(db: Session, run: PayrollRun, slips: list[Payslip], title: str) -> str:
    """مستند HTML كامل يحوي قسيمة أو أكثر، مع زر طباعة."""
    body = "".join(payslip_html(db, slip, run) for slip in slips)
    return f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{escape(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700&display=swap" rel="stylesheet" />
<style>{_STYLE}</style>
</head>
<body>
  <div class="bar">
    <button onclick="window.print()">طباعة / حفظ PDF</button>
    <button class="ghost" onclick="window.close()">إغلاق</button>
  </div>
  {body}
</body>
</html>"""
